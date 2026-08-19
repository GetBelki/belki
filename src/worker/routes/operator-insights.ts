import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { TrackingSourceSchema } from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import { assertOperator } from "../lib/auth";
import { analyticsBackfillEstimatedMinutes } from "../lib/analytics-read-model";
import {
  buildResponseShareTrend,
  productAnalyticsDateRange,
} from "../lib/reporting";

const OperatorInsightPeriodSchema = z.enum(["7d", "30d", "90d"]);
const OperatorInsightSourceSchema = z.union([
  z.literal("all"),
  TrackingSourceSchema,
]);
const OperatorInsightQuerySchema = z.object({
  period: OperatorInsightPeriodSchema.default("30d"),
  source: OperatorInsightSourceSchema.default("all"),
});
const OperatorCitationQuerySchema = OperatorInsightQuerySchema.extend({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .transform((value) => value.toLowerCase())
    .optional(),
});
const OperatorCitationDomainsQuerySchema = OperatorInsightQuerySchema.extend({
  search: z
    .string()
    .trim()
    .max(200)
    .transform((value) => value.toLowerCase())
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

type OperatorInsightPeriod = z.infer<typeof OperatorInsightPeriodSchema>;
type OperatorInsightSource = z.infer<typeof OperatorInsightSourceSchema>;

interface DailyResponseRow {
  metric_date: string;
  completed_responses: number;
  matching_responses: number;
}

function insightRange(period: OperatorInsightPeriod) {
  return productAnalyticsDateRange(period);
}

function sourceBindings(source: OperatorInsightSource): [string, string] {
  return [source, source];
}

export const operatorInsightRoutes = new Hono<AppEnv>();

operatorInsightRoutes.get(
  "/operator/insights/citation-domains",
  zValidator("query", OperatorCitationDomainsQuerySchema),
  async (c) => {
    await assertOperator(c);
    const input = c.req.valid("query");
    const dates = insightRange(input.period);
    const search = input.search ?? "";
    const domains = await c.env.CONTROL_DB.prepare(
      `SELECT metric.domain,
        SUM(metric.cited_snapshot_count) AS cited_responses,
        SUM(metric.citation_count) AS citations
       FROM daily_source_domain_metrics metric
       JOIN projects project
         ON project.id = metric.project_id AND project.deleted_at IS NULL
       JOIN workspaces workspace
         ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
       WHERE metric.metric_date BETWEEN ? AND ?
         AND (? = 'all' OR metric.tracking_source = ?)
         AND (? = '' OR INSTR(metric.domain, ?) > 0)
       GROUP BY metric.domain
       ORDER BY cited_responses DESC, citations DESC, metric.domain
       LIMIT ?`,
    )
      .bind(
        dates.from,
        dates.to,
        ...sourceBindings(input.source),
        search,
        search,
        input.limit,
      )
      .all<{
        domain: string;
        cited_responses: number;
        citations: number;
      }>();
    return c.json({
      data: domains.results.map((row) => ({
        domain: row.domain,
        citedResponses: Number(row.cited_responses),
        citations: Number(row.citations),
      })),
    });
  },
);

operatorInsightRoutes.get(
  "/operator/insights/citations",
  zValidator("query", OperatorCitationQuerySchema),
  async (c) => {
    await assertOperator(c);
    const input = c.req.valid("query");
    const dates = insightRange(input.period);
    const [completed, selectedDomain] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT metric.metric_date,
          SUM(metric.completed_runs) AS completed_responses,
          SUM(metric.cited_runs) AS matching_responses
         FROM daily_source_project_metrics metric
         JOIN projects project
           ON project.id = metric.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         WHERE metric.metric_date BETWEEN ? AND ?
           AND (? = 'all' OR metric.tracking_source = ?)
         GROUP BY metric.metric_date
         ORDER BY metric.metric_date`,
      )
        .bind(dates.from, dates.to, ...sourceBindings(input.source))
        .all<DailyResponseRow>(),
      input.domain
        ? c.env.CONTROL_DB.prepare(
            `SELECT metric.metric_date,
              SUM(metric.cited_snapshot_count) AS matching_responses
             FROM daily_source_domain_metrics metric
             JOIN projects project
               ON project.id = metric.project_id AND project.deleted_at IS NULL
             JOIN workspaces workspace
               ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
             WHERE metric.metric_date BETWEEN ? AND ?
               AND (? = 'all' OR metric.tracking_source = ?)
               AND metric.domain = ?
             GROUP BY metric.metric_date
             ORDER BY metric.metric_date`,
          )
            .bind(
              dates.from,
              dates.to,
              ...sourceBindings(input.source),
              input.domain,
            )
            .all<{ metric_date: string; matching_responses: number }>()
        : Promise.resolve({ results: [] }),
    ]);
    const completedByDate = new Map(
      completed.results.map((row) => [
        row.metric_date,
        Number(row.completed_responses),
      ]),
    );
    const matchingByDate = new Map(
      (input.domain ? selectedDomain.results : completed.results).map((row) => [
        row.metric_date,
        Number(row.matching_responses),
      ]),
    );
    return c.json({
      data: {
        period: input.period,
        source: input.source,
        domain: input.domain ?? null,
        trend: buildResponseShareTrend(dates, completedByDate, matchingByDate),
      },
    });
  },
);

operatorInsightRoutes.get(
  "/operator/insights/fan-out",
  zValidator("query", OperatorInsightQuerySchema),
  async (c) => {
    await assertOperator(c);
    const input = c.req.valid("query");
    const dates = insightRange(input.period);
    const currentYear = new Date().getUTCFullYear();
    const [selectedProgress, globalProgress] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT COUNT(*) AS remaining
         FROM snapshot_index snapshot
         JOIN projects project
           ON project.id = snapshot.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
         WHERE snapshot.captured_at >= ? AND snapshot.captured_at < ?
           AND (? = 'all' OR snapshot.tracking_source = ?)
           AND (
             fact.snapshot_id IS NULL
             OR fact.related_query_insights_indexed_at IS NULL
           )`,
      )
      .bind(
        dates.startTimestamp,
        dates.endExclusiveTimestamp,
        ...sourceBindings(input.source),
      )
        .first<{ remaining: number }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT COUNT(*) AS remaining
         FROM snapshot_index snapshot
         JOIN projects project
           ON project.id = snapshot.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
         WHERE fact.snapshot_id IS NULL
           OR fact.related_query_insights_indexed_at IS NULL`,
      ).first<{ remaining: number }>(),
    ]);
    const remainingSnapshots = Number(selectedProgress?.remaining ?? 0);
    const globalRemainingSnapshots = Number(globalProgress?.remaining ?? 0);
    if (remainingSnapshots > 0) {
      return c.json({
        data: {
          period: input.period,
          source: input.source,
          indexing: true,
          remainingSnapshots,
          estimatedMinutes: analyticsBackfillEstimatedMinutes(
            globalRemainingSnapshots,
          ),
          total: [],
          siteOperator: [],
          reviews: [],
          official: [],
          government: [],
          years: [],
        },
      });
    }

    const [daily, yearly] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT fact.metric_date,
          COUNT(*) AS completed_responses,
          SUM(CASE WHEN fact.related_queries_count > 0 THEN 1 ELSE 0 END)
            AS total_responses,
          SUM(fact.related_site_query_present) AS site_responses,
          SUM(fact.related_review_query_present) AS review_responses,
          SUM(CASE WHEN EXISTS(
            SELECT 1
            FROM analytics_related_query_occurrences occurrence
            WHERE occurrence.snapshot_id = fact.snapshot_id
              AND (
                (' ' || occurrence.normalized_query || ' ')
                  GLOB '*[^a-z0-9_]official[^a-z0-9_]*'
                OR (' ' || occurrence.normalized_query || ' ')
                  GLOB '*[^a-z0-9_]oficial[^a-z0-9_]*'
              )
          ) THEN 1 ELSE 0 END) AS official_responses,
          SUM(CASE WHEN EXISTS(
            SELECT 1
            FROM analytics_related_query_occurrences occurrence
            WHERE occurrence.snapshot_id = fact.snapshot_id
              AND (
                (occurrence.normalized_query || ' ')
                  GLOB '*.gov[^a-z0-9_]*'
                OR (occurrence.normalized_query || ' ')
                  GLOB '*.gob[^a-z0-9_]*'
              )
          ) THEN 1 ELSE 0 END) AS government_responses
         FROM analytics_snapshot_facts fact
         JOIN projects project
           ON project.id = fact.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         WHERE fact.metric_date BETWEEN ? AND ?
           AND (? = 'all' OR fact.tracking_source = ?)
           AND fact.related_query_insights_indexed_at IS NOT NULL
         GROUP BY fact.metric_date
         ORDER BY fact.metric_date`,
      )
        .bind(dates.from, dates.to, ...sourceBindings(input.source))
        .all<{
          metric_date: string;
          completed_responses: number;
          total_responses: number;
          site_responses: number;
          review_responses: number;
          official_responses: number;
          government_responses: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT fact.metric_date, CAST(year.value AS INTEGER) AS year,
          COUNT(DISTINCT fact.snapshot_id) AS matching_responses
         FROM analytics_snapshot_facts fact
         JOIN projects project
           ON project.id = fact.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         JOIN json_each(fact.related_query_years_json) year
         WHERE fact.metric_date BETWEEN ? AND ?
           AND (? = 'all' OR fact.tracking_source = ?)
           AND fact.related_query_insights_indexed_at IS NOT NULL
           AND CAST(year.value AS INTEGER) BETWEEN 2025 AND ?
         GROUP BY fact.metric_date, year.value
         ORDER BY year, fact.metric_date`,
      )
        .bind(
          dates.from,
          dates.to,
          ...sourceBindings(input.source),
          currentYear,
        )
        .all<{
          metric_date: string;
          year: number;
          matching_responses: number;
        }>(),
    ]);
    const completedByDate = new Map(
      daily.results.map((row) => [
        row.metric_date,
        Number(row.completed_responses),
      ]),
    );
    const totalByDate = new Map(
      daily.results.map((row) => [row.metric_date, Number(row.total_responses)]),
    );
    const siteByDate = new Map(
      daily.results.map((row) => [row.metric_date, Number(row.site_responses)]),
    );
    const reviewByDate = new Map(
      daily.results.map((row) => [row.metric_date, Number(row.review_responses)]),
    );
    const officialByDate = new Map(
      daily.results.map((row) => [row.metric_date, Number(row.official_responses)]),
    );
    const governmentByDate = new Map(
      daily.results.map((row) => [row.metric_date, Number(row.government_responses)]),
    );
    const matchingByYear = new Map<number, Map<string, number>>();
    for (const row of yearly.results) {
      const year = Number(row.year);
      const values = matchingByYear.get(year) ?? new Map<string, number>();
      values.set(row.metric_date, Number(row.matching_responses));
      matchingByYear.set(year, values);
    }
    return c.json({
      data: {
        period: input.period,
        source: input.source,
        indexing: false,
        remainingSnapshots: 0,
        estimatedMinutes: 0,
        total: buildResponseShareTrend(dates, completedByDate, totalByDate),
        siteOperator: buildResponseShareTrend(dates, completedByDate, siteByDate),
        reviews: buildResponseShareTrend(dates, completedByDate, reviewByDate),
        official: buildResponseShareTrend(
          dates,
          completedByDate,
          officialByDate,
        ),
        government: buildResponseShareTrend(
          dates,
          completedByDate,
          governmentByDate,
        ),
        years: [...matchingByYear.entries()]
          .sort(([left], [right]) => left - right)
          .map(([year, values]) => ({
            year,
            trend: buildResponseShareTrend(dates, completedByDate, values),
          })),
      },
    });
  },
);
