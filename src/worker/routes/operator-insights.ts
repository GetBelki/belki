import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { TrackingSourceSchema } from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import { assertOperator } from "../lib/auth";
import {
  RELATED_QUERY_SIGNAL_COUNTS_VERSION,
  analyticsBackfillEstimatedMinutes,
} from "../lib/analytics-read-model";
import {
  RELATED_QUERY_SIGNAL_KEYS,
  buildFanOutActivityTrend,
  buildFanOutSignalTrend,
  buildResponseShareTrend,
  productAnalyticsDateRange,
  type RelatedQuerySignalKey,
} from "../lib/reporting";
import { sourceDiscoveryBackfillEstimatedMinutes } from "../ingestion/source-discovery";

const OperatorInsightPeriodSchema = z.enum(["7d", "30d", "90d"]);
const OperatorInsightSourceSchema = z.union([
  z.literal("all"),
  TrackingSourceSchema,
]);
const OperatorInsightQuerySchema = z.object({
  period: OperatorInsightPeriodSchema.default("30d"),
  source: OperatorInsightSourceSchema.default("all"),
});
const OperatorFanOutSourceSchema = z.enum(["all", "chatgpt", "gemini", "perplexity"]);
const OperatorFanOutQuerySchema = z.object({
  period: OperatorInsightPeriodSchema.default("30d"),
  source: OperatorFanOutSourceSchema.default("chatgpt"),
  model: z.string().trim().min(1).max(100).default("all"),
});
const OperatorSourceDiscoveryQuerySchema = OperatorInsightQuerySchema.extend({
  model: z.string().trim().min(1).max(100).default("all"),
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
type OperatorFanOutSource = z.infer<typeof OperatorFanOutSourceSchema>;

interface DailyResponseRow {
  metric_date: string;
  completed_responses: number;
  matching_responses: number;
}

type DailyFanOutRow = {
  metric_date: string;
  completed_responses: number;
  reported_responses: number;
  responses_with_fan_out: number;
  total_fan_outs: number;
} & Record<`${RelatedQuerySignalKey}_fanouts`, number>
  & Record<`${RelatedQuerySignalKey}_responses`, number>;

interface YearFanOutRow {
  metric_date: string;
  year: number;
  matching_fan_outs: number;
  matching_responses: number;
}

interface FanOutModelRow {
  provider_model: string | null;
  responses: number;
}

interface SourceDiscoveryBackfillRow {
  status: "pending" | "backfilling" | "ready";
  cursor_date: string | null;
  through_date: string | null;
}

interface SourceDiscoveryDailyRow {
  metric_date: string;
  completed_responses: number;
  reported_fan_out_responses: number;
  total_fan_outs: number;
  retrieved_urls: number;
  retrieved_domains: number;
  cited_urls: number;
  cited_domains: number;
}

interface SourceDiscoveryNoveltyRow {
  metric_date: string;
  known_urls: number;
  new_urls_known_domains: number;
  new_urls_new_domains: number;
}

interface SourceDiscoveryPageTypeRow {
  content_type: string;
  citations: number;
  new_urls: number;
  new_domains: number;
}

interface SourceDiscoverySiteImpactRow {
  site_operator_present: number;
  responses: number;
  total_fan_outs: number;
  retrieved_urls: number;
  cited_urls: number;
  new_urls: number;
  new_domains: number;
}

function insightRange(period: OperatorInsightPeriod) {
  return productAnalyticsDateRange(period);
}

function sourceBindings(source: OperatorInsightSource): [string, string] {
  return [source, source];
}

function fanOutSourceBindings(source: OperatorFanOutSource): [string, string] {
  return [source, source];
}

function fanOutModelBindings(model: string): [string, string, string] {
  return [model, model, model];
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0;
}

function percentage(numerator: number, denominator: number): number {
  return ratio(numerator, denominator) * 100;
}

function sourceDiscoveryContentTypeSql(alias: string): string {
  const url = `LOWER(COALESCE(${alias}.canonical_url, ''))`;
  const title = `LOWER(COALESCE(${alias}.title, ''))`;
  return `CASE
    WHEN ${url} LIKE '%.pdf' OR INSTR(${url}, '.pdf?') > 0 THEN 'pdf'
    WHEN ${url} LIKE '%/pricing%' OR ${url} LIKE '%/plans%'
      OR ${title} LIKE '%pricing%' THEN 'pricing'
    WHEN ${url} LIKE '%/press/%' OR ${url} LIKE '%/press'
      OR ${url} LIKE '%/newsroom/%' OR ${url} LIKE '%/newsroom'
      OR ${url} LIKE '%/media-room/%' THEN 'press'
    WHEN ${url} LIKE '%/product/%' OR ${url} LIKE '%/products/%'
      OR ${url} LIKE '%/shop/%' THEN 'product'
    WHEN ${url} LIKE '%://blog.%' OR ${url} LIKE '%/blog/%'
      OR ${url} LIKE '%/blog' THEN 'blog'
    WHEN ${url} LIKE '%://docs.%' OR ${url} LIKE '%/docs/%'
      OR ${url} LIKE '%/documentation/%' OR ${url} LIKE '%/support/%'
      OR ${url} LIKE '%/help/%' THEN 'docs'
    WHEN ${url} LIKE '%/review/%' OR ${url} LIKE '%/reviews/%'
      OR ${title} LIKE '% review%' THEN 'reviews'
    ELSE 'other'
  END`;
}

function completeSourceDiscoveryDates(
  dates: { from: string; to: string },
  dailyRows: SourceDiscoveryDailyRow[],
  noveltyRows: SourceDiscoveryNoveltyRow[],
) {
  const daily = new Map(dailyRows.map((row) => [row.metric_date, row]));
  const novelty = new Map(noveltyRows.map((row) => [row.metric_date, row]));
  const values = [];
  const cursor = new Date(`${dates.from}T00:00:00.000Z`);
  const end = Date.parse(`${dates.to}T00:00:00.000Z`);
  while (cursor.getTime() <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const activity = daily.get(date);
    const discovery = novelty.get(date);
    const completedResponses = Number(activity?.completed_responses ?? 0);
    const reportedFanOutResponses = Number(
      activity?.reported_fan_out_responses ?? 0,
    );
    const totalFanOuts = Number(activity?.total_fan_outs ?? 0);
    const retrievedUrls = Number(activity?.retrieved_urls ?? 0);
    const retrievedDomains = Number(activity?.retrieved_domains ?? 0);
    const citedUrls = Number(activity?.cited_urls ?? 0);
    const citedDomains = Number(activity?.cited_domains ?? 0);
    const knownUrls = Number(discovery?.known_urls ?? 0);
    const newUrlsKnownDomains = Number(
      discovery?.new_urls_known_domains ?? 0,
    );
    const newUrlsNewDomains = Number(discovery?.new_urls_new_domains ?? 0);
    const totalUniqueUrls = knownUrls + newUrlsKnownDomains + newUrlsNewDomains;
    values.push({
      date,
      completedResponses,
      reportedFanOutResponses,
      totalFanOuts,
      retrievedUrls,
      retrievedDomains,
      citedUrls,
      citedDomains,
      fanOutsPerResponse: reportedFanOutResponses
        ? ratio(totalFanOuts, reportedFanOutResponses)
        : null,
      retrievedUrlsPerResponse: ratio(retrievedUrls, completedResponses),
      citedUrlsPerResponse: ratio(citedUrls, completedResponses),
      knownUrls,
      newUrlsKnownDomains,
      newUrlsNewDomains,
      totalUniqueUrls,
      knownUrlShare: percentage(knownUrls, totalUniqueUrls),
      newUrlKnownDomainShare: percentage(newUrlsKnownDomains, totalUniqueUrls),
      newUrlNewDomainShare: percentage(newUrlsNewDomains, totalUniqueUrls),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
}

const fanOutSignalSelectSql = RELATED_QUERY_SIGNAL_KEYS.map((key) => {
  const count = `COALESCE(CAST(json_extract(fact.related_query_signal_counts_json, '$.${key}') AS INTEGER), 0)`;
  return `SUM(${count}) AS ${key}_fanouts,
          SUM(CASE WHEN ${count} > 0 THEN 1 ELSE 0 END) AS ${key}_responses`;
}).join(",\n          ");

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
  "/operator/insights/source-discovery",
  zValidator("query", OperatorSourceDiscoveryQuerySchema),
  async (c) => {
    await assertOperator(c);
    const input = c.req.valid("query");
    const dates = insightRange(input.period);
    const [backfill, models] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT status, cursor_date, through_date
         FROM source_discovery_backfill WHERE singleton_id = 1`,
      ).first<SourceDiscoveryBackfillRow>(),
      c.env.CONTROL_DB.prepare(
        `SELECT fact.provider_model, COUNT(*) AS responses
         FROM analytics_snapshot_facts fact
         JOIN projects project
           ON project.id = fact.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         WHERE fact.metric_date BETWEEN ? AND ?
           AND (? = 'all' OR fact.tracking_source = ?)
         GROUP BY fact.provider_model
         ORDER BY fact.provider_model`,
      )
        .bind(dates.from, dates.to, ...sourceBindings(input.source))
        .all<FanOutModelRow>(),
    ]);
    const modelOptions = models.results.map((row) => ({
      value: row.provider_model ?? "__unreported__",
      label: row.provider_model ?? "Model not reported",
      responses: Number(row.responses),
    }));
    if (backfill?.status !== "ready") {
      return c.json({
        data: {
          period: input.period,
          source: input.source,
          model: input.model,
          models: modelOptions,
          indexing: true,
          estimatedMinutes: sourceDiscoveryBackfillEstimatedMinutes(
            backfill?.cursor_date ?? null,
            backfill?.through_date ?? null,
          ),
          activity: [],
          pageTypes: [],
          siteImpact: [],
        },
      });
    }

    const contentTypeSql = sourceDiscoveryContentTypeSql("citation");
    const [daily, novelty, pageTypes, siteImpact] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT fact.metric_date,
          COUNT(*) AS completed_responses,
          SUM(CASE WHEN fact.fan_out_telemetry_status = 'reported'
            THEN 1 ELSE 0 END) AS reported_fan_out_responses,
          SUM(CASE WHEN fact.fan_out_telemetry_status = 'reported'
            THEN fact.related_queries_count ELSE 0 END) AS total_fan_outs,
          SUM((SELECT COUNT(DISTINCT retrieval.canonical_url)
            FROM analytics_retrieval_occurrences retrieval
            WHERE retrieval.snapshot_id = fact.snapshot_id
              AND retrieval.canonical_url IS NOT NULL)) AS retrieved_urls,
          SUM((SELECT COUNT(DISTINCT retrieval.registrable_domain)
            FROM analytics_retrieval_occurrences retrieval
            WHERE retrieval.snapshot_id = fact.snapshot_id
              AND retrieval.registrable_domain IS NOT NULL)) AS retrieved_domains,
          SUM((SELECT COUNT(DISTINCT citation.canonical_url)
            FROM analytics_citation_occurrences citation
            WHERE citation.snapshot_id = fact.snapshot_id
              AND citation.canonical_url IS NOT NULL)) AS cited_urls,
          SUM((SELECT COUNT(DISTINCT citation.registrable_domain)
            FROM analytics_citation_occurrences citation
            WHERE citation.snapshot_id = fact.snapshot_id)) AS cited_domains
         FROM analytics_snapshot_facts fact
         JOIN projects project
           ON project.id = fact.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         WHERE fact.metric_date BETWEEN ? AND ?
           AND (? = 'all' OR fact.tracking_source = ?)
           AND (
             ? = 'all'
             OR (? = '__unreported__' AND fact.provider_model IS NULL)
             OR fact.provider_model = ?
           )
         GROUP BY fact.metric_date
         ORDER BY fact.metric_date`,
      )
        .bind(
          dates.from,
          dates.to,
          ...sourceBindings(input.source),
          ...fanOutModelBindings(input.model),
        )
        .all<SourceDiscoveryDailyRow>(),
      c.env.CONTROL_DB.prepare(
        `WITH daily_urls AS (
          SELECT fact.metric_date, fact.tracking_source,
            citation.canonical_url, MIN(citation.registrable_domain)
              AS registrable_domain
          FROM analytics_snapshot_facts fact
          JOIN analytics_citation_occurrences citation
            ON citation.snapshot_id = fact.snapshot_id
          JOIN projects project
            ON project.id = fact.project_id AND project.deleted_at IS NULL
          JOIN workspaces workspace
            ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
          WHERE fact.metric_date BETWEEN ? AND ?
            AND (? = 'all' OR fact.tracking_source = ?)
            AND (
              ? = 'all'
              OR (? = '__unreported__' AND fact.provider_model IS NULL)
              OR fact.provider_model = ?
            )
            AND citation.canonical_url IS NOT NULL
          GROUP BY fact.metric_date, fact.tracking_source,
            citation.canonical_url
        )
        SELECT daily.metric_date,
          SUM(CASE WHEN url.first_seen_date < daily.metric_date
            THEN 1 ELSE 0 END) AS known_urls,
          SUM(CASE WHEN url.first_seen_date = daily.metric_date
            AND domain.first_seen_date < daily.metric_date
            THEN 1 ELSE 0 END) AS new_urls_known_domains,
          SUM(CASE WHEN url.first_seen_date = daily.metric_date
            AND domain.first_seen_date = daily.metric_date
            THEN 1 ELSE 0 END) AS new_urls_new_domains
        FROM daily_urls daily
        JOIN analytics_citation_url_first_seen url
          ON url.tracking_source = daily.tracking_source
         AND url.canonical_url = daily.canonical_url
        JOIN analytics_citation_domain_first_seen domain
          ON domain.tracking_source = daily.tracking_source
         AND domain.registrable_domain = daily.registrable_domain
        GROUP BY daily.metric_date
        ORDER BY daily.metric_date`,
      )
        .bind(
          dates.from,
          dates.to,
          ...sourceBindings(input.source),
          ...fanOutModelBindings(input.model),
        )
        .all<SourceDiscoveryNoveltyRow>(),
      c.env.CONTROL_DB.prepare(
        `WITH typed_citations AS (
          SELECT fact.metric_date, fact.tracking_source,
            citation.canonical_url, citation.registrable_domain,
            ${contentTypeSql} AS content_type
          FROM analytics_snapshot_facts fact
          JOIN analytics_citation_occurrences citation
            ON citation.snapshot_id = fact.snapshot_id
          JOIN projects project
            ON project.id = fact.project_id AND project.deleted_at IS NULL
          JOIN workspaces workspace
            ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
          WHERE fact.metric_date BETWEEN ? AND ?
            AND (? = 'all' OR fact.tracking_source = ?)
            AND (
              ? = 'all'
              OR (? = '__unreported__' AND fact.provider_model IS NULL)
              OR fact.provider_model = ?
            )
            AND citation.canonical_url IS NOT NULL
        )
        SELECT typed.content_type, COUNT(*) AS citations,
          SUM(CASE WHEN url.first_seen_date = typed.metric_date
            THEN 1 ELSE 0 END) AS new_urls,
          SUM(CASE WHEN url.first_seen_date = typed.metric_date
            AND domain.first_seen_date = typed.metric_date
            THEN 1 ELSE 0 END) AS new_domains
        FROM typed_citations typed
        JOIN analytics_citation_url_first_seen url
          ON url.tracking_source = typed.tracking_source
         AND url.canonical_url = typed.canonical_url
        JOIN analytics_citation_domain_first_seen domain
          ON domain.tracking_source = typed.tracking_source
         AND domain.registrable_domain = typed.registrable_domain
        GROUP BY typed.content_type
        ORDER BY citations DESC, typed.content_type`,
      )
        .bind(
          dates.from,
          dates.to,
          ...sourceBindings(input.source),
          ...fanOutModelBindings(input.model),
        )
        .all<SourceDiscoveryPageTypeRow>(),
      c.env.CONTROL_DB.prepare(
        `WITH response_depth AS (
          SELECT fact.snapshot_id, fact.metric_date,
            fact.related_site_query_present AS site_operator_present,
            fact.related_queries_count,
            (SELECT COUNT(DISTINCT retrieval.canonical_url)
              FROM analytics_retrieval_occurrences retrieval
              WHERE retrieval.snapshot_id = fact.snapshot_id
                AND retrieval.canonical_url IS NOT NULL) AS retrieved_urls,
            (SELECT COUNT(DISTINCT citation.canonical_url)
              FROM analytics_citation_occurrences citation
              WHERE citation.snapshot_id = fact.snapshot_id
                AND citation.canonical_url IS NOT NULL) AS cited_urls,
            (SELECT COUNT(DISTINCT citation.canonical_url)
              FROM analytics_citation_occurrences citation
              JOIN analytics_citation_url_first_seen url
                ON url.tracking_source = fact.tracking_source
               AND url.canonical_url = citation.canonical_url
              WHERE citation.snapshot_id = fact.snapshot_id
                AND url.first_seen_date = fact.metric_date) AS new_urls,
            (SELECT COUNT(DISTINCT citation.registrable_domain)
              FROM analytics_citation_occurrences citation
              JOIN analytics_citation_domain_first_seen domain
                ON domain.tracking_source = fact.tracking_source
               AND domain.registrable_domain = citation.registrable_domain
              WHERE citation.snapshot_id = fact.snapshot_id
                AND domain.first_seen_date = fact.metric_date) AS new_domains
          FROM analytics_snapshot_facts fact
          JOIN projects project
            ON project.id = fact.project_id AND project.deleted_at IS NULL
          JOIN workspaces workspace
            ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
          WHERE fact.metric_date BETWEEN ? AND ?
            AND (? = 'all' OR fact.tracking_source = ?)
            AND (
              ? = 'all'
              OR (? = '__unreported__' AND fact.provider_model IS NULL)
              OR fact.provider_model = ?
            )
            AND fact.tracking_source IN ('chatgpt', 'gemini', 'perplexity')
            AND fact.fan_out_telemetry_status = 'reported'
            AND fact.related_query_signal_counts_indexed_at IS NOT NULL
            AND fact.related_query_signal_counts_version >= ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
        )
        SELECT site_operator_present, COUNT(*) AS responses,
          SUM(related_queries_count) AS total_fan_outs,
          SUM(retrieved_urls) AS retrieved_urls,
          SUM(cited_urls) AS cited_urls,
          SUM(new_urls) AS new_urls,
          SUM(new_domains) AS new_domains
        FROM response_depth
        GROUP BY site_operator_present
        ORDER BY site_operator_present DESC`,
      )
        .bind(
          dates.from,
          dates.to,
          ...sourceBindings(input.source),
          ...fanOutModelBindings(input.model),
        )
        .all<SourceDiscoverySiteImpactRow>(),
    ]);

    const activity = completeSourceDiscoveryDates(
      dates,
      daily.results,
      novelty.results,
    );
    const totals = activity.reduce(
      (summary, point) => ({
        completedResponses: summary.completedResponses + point.completedResponses,
        reportedFanOutResponses:
          summary.reportedFanOutResponses + point.reportedFanOutResponses,
        totalFanOuts: summary.totalFanOuts + point.totalFanOuts,
        retrievedUrls: summary.retrievedUrls + point.retrievedUrls,
        citedUrls: summary.citedUrls + point.citedUrls,
        knownUrls: summary.knownUrls + point.knownUrls,
        newUrlsKnownDomains:
          summary.newUrlsKnownDomains + point.newUrlsKnownDomains,
        newUrlsNewDomains: summary.newUrlsNewDomains + point.newUrlsNewDomains,
      }),
      {
        completedResponses: 0,
        reportedFanOutResponses: 0,
        totalFanOuts: 0,
        retrievedUrls: 0,
        citedUrls: 0,
        knownUrls: 0,
        newUrlsKnownDomains: 0,
        newUrlsNewDomains: 0,
      },
    );
    const totalUniqueUrls = totals.knownUrls + totals.newUrlsKnownDomains
      + totals.newUrlsNewDomains;
    const totalPageTypeCitations = pageTypes.results.reduce(
      (total, row) => total + Number(row.citations),
      0,
    );
    return c.json({
      data: {
        period: input.period,
        source: input.source,
        model: input.model,
        models: modelOptions,
        indexing: false,
        estimatedMinutes: 0,
        summary: {
          completedResponses: totals.completedResponses,
          retrievedUrlsPerResponse: ratio(
            totals.retrievedUrls,
            totals.completedResponses,
          ),
          citedUrlsPerResponse: ratio(
            totals.citedUrls,
            totals.completedResponses,
          ),
          newUrlShare: percentage(
            totals.newUrlsKnownDomains + totals.newUrlsNewDomains,
            totalUniqueUrls,
          ),
          newDomainShare: percentage(
            totals.newUrlsNewDomains,
            totalUniqueUrls,
          ),
        },
        activity,
        pageTypes: pageTypes.results.map((row) => {
          const citations = Number(row.citations);
          return {
            type: row.content_type,
            citations,
            citationShare: percentage(citations, totalPageTypeCitations),
            newUrlShare: percentage(Number(row.new_urls), citations),
            newDomainShare: percentage(Number(row.new_domains), citations),
          };
        }),
        siteImpact: siteImpact.results.map((row) => {
          const responses = Number(row.responses);
          const citedUrls = Number(row.cited_urls);
          return {
            siteOperatorPresent: Number(row.site_operator_present) === 1,
            responses,
            fanOutsPerResponse: ratio(Number(row.total_fan_outs), responses),
            retrievedUrlsPerResponse: ratio(
              Number(row.retrieved_urls),
              responses,
            ),
            citedUrlsPerResponse: ratio(citedUrls, responses),
            newUrlShare: percentage(Number(row.new_urls), citedUrls),
            newDomainsPerResponse: ratio(Number(row.new_domains), responses),
          };
        }),
      },
    });
  },
);

operatorInsightRoutes.get(
  "/operator/insights/fan-out",
  zValidator("query", OperatorFanOutQuerySchema),
  async (c) => {
    await assertOperator(c);
    const input = c.req.valid("query");
    const dates = insightRange(input.period);
    const currentYear = new Date().getUTCFullYear();
    const [selectedProgress, globalProgress] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT
          SUM(CASE WHEN fact.snapshot_id IS NULL
            OR fact.related_query_signal_counts_indexed_at IS NULL
            THEN 1 ELSE 0 END) AS full_remaining,
          SUM(CASE WHEN fact.snapshot_id IS NOT NULL
            AND fact.related_query_signal_counts_indexed_at IS NOT NULL
            AND fact.related_query_signal_counts_version < ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
            THEN 1 ELSE 0 END) AS signal_remaining,
          SUM(CASE WHEN fact.snapshot_id IS NOT NULL
            AND fact.related_query_signal_counts_indexed_at IS NOT NULL
            AND fact.related_query_signal_counts_version >= ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
            AND fact.fan_out_telemetry_indexed_at IS NULL
            THEN 1 ELSE 0 END) AS telemetry_remaining
         FROM snapshot_index snapshot
         JOIN projects project
           ON project.id = snapshot.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
         WHERE snapshot.captured_at >= ? AND snapshot.captured_at < ?
           AND (
             (? = 'all' AND snapshot.tracking_source IN ('chatgpt', 'gemini', 'perplexity'))
             OR snapshot.tracking_source = ?
           )
           AND (
             fact.snapshot_id IS NULL
             OR fact.related_query_signal_counts_indexed_at IS NULL
             OR fact.related_query_signal_counts_version < ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
             OR fact.fan_out_telemetry_indexed_at IS NULL
           )`,
      )
      .bind(
        dates.startTimestamp,
        dates.endExclusiveTimestamp,
        ...fanOutSourceBindings(input.source),
      )
        .first<{
          full_remaining: number;
          signal_remaining: number;
          telemetry_remaining: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT
          SUM(CASE WHEN fact.snapshot_id IS NULL
            OR fact.related_query_signal_counts_indexed_at IS NULL
            THEN 1 ELSE 0 END) AS full_remaining,
          SUM(CASE WHEN fact.snapshot_id IS NOT NULL
            AND fact.related_query_signal_counts_indexed_at IS NOT NULL
            AND fact.related_query_signal_counts_version < ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
            THEN 1 ELSE 0 END) AS signal_remaining,
          SUM(CASE WHEN fact.snapshot_id IS NOT NULL
            AND fact.related_query_signal_counts_indexed_at IS NOT NULL
            AND fact.related_query_signal_counts_version >= ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
            AND fact.fan_out_telemetry_indexed_at IS NULL
            THEN 1 ELSE 0 END) AS telemetry_remaining
         FROM snapshot_index snapshot
         JOIN projects project
           ON project.id = snapshot.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
         WHERE snapshot.tracking_source IN ('chatgpt', 'gemini', 'perplexity')
           AND (fact.snapshot_id IS NULL
           OR fact.related_query_signal_counts_indexed_at IS NULL
           OR fact.related_query_signal_counts_version < ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
           OR fact.fan_out_telemetry_indexed_at IS NULL)`,
      ).first<{
        full_remaining: number;
        signal_remaining: number;
        telemetry_remaining: number;
      }>(),
    ]);
    const selectedFullRemaining = Number(selectedProgress?.full_remaining ?? 0);
    const selectedSignalRemaining = Number(
      selectedProgress?.signal_remaining ?? 0,
    );
    const selectedTelemetryRemaining = Number(
      selectedProgress?.telemetry_remaining ?? 0,
    );
    const remainingSnapshots = selectedFullRemaining
      + selectedSignalRemaining
      + selectedTelemetryRemaining;
    if (remainingSnapshots > 0) {
      return c.json({
        data: {
          period: input.period,
          source: input.source,
          model: input.model,
          models: [],
          indexing: true,
          remainingSnapshots,
          estimatedMinutes: analyticsBackfillEstimatedMinutes(
            Number(globalProgress?.full_remaining ?? 0),
            Number(globalProgress?.telemetry_remaining ?? 0),
            Number(globalProgress?.signal_remaining ?? 0),
          ),
          activity: [],
          signals: Object.fromEntries(
            RELATED_QUERY_SIGNAL_KEYS.map((key) => [key, []]),
          ),
          yearSignals: [],
          total: [],
          siteOperator: [],
          reviews: [],
          official: [],
          government: [],
          years: [],
        },
      });
    }

    const [daily, yearly, models] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT fact.metric_date,
          COUNT(*) AS completed_responses,
          SUM(CASE WHEN fact.fan_out_telemetry_status = 'reported'
            THEN 1 ELSE 0 END) AS reported_responses,
          SUM(CASE WHEN fact.fan_out_telemetry_status = 'reported'
            AND fact.related_queries_count > 0 THEN 1 ELSE 0 END)
            AS responses_with_fan_out,
          SUM(CASE WHEN fact.fan_out_telemetry_status = 'reported'
            THEN fact.related_queries_count ELSE 0 END) AS total_fan_outs,
          ${fanOutSignalSelectSql}
         FROM analytics_snapshot_facts fact
         JOIN projects project
           ON project.id = fact.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         WHERE fact.metric_date BETWEEN ? AND ?
           AND (
             (? = 'all' AND fact.tracking_source IN ('chatgpt', 'gemini', 'perplexity'))
             OR fact.tracking_source = ?
           )
           AND (
             ? = 'all'
             OR (? = '__unreported__' AND fact.provider_model IS NULL)
             OR fact.provider_model = ?
           )
           AND fact.related_query_signal_counts_indexed_at IS NOT NULL
           AND fact.related_query_signal_counts_version >= ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
           AND fact.fan_out_telemetry_indexed_at IS NOT NULL
         GROUP BY fact.metric_date
         ORDER BY fact.metric_date`,
      )
        .bind(
          dates.from,
          dates.to,
          ...fanOutSourceBindings(input.source),
          ...fanOutModelBindings(input.model),
        )
        .all<DailyFanOutRow>(),
      c.env.CONTROL_DB.prepare(
        `SELECT fact.metric_date, CAST(year.key AS INTEGER) AS year,
          SUM(CAST(year.value AS INTEGER)) AS matching_fan_outs,
          SUM(CASE WHEN CAST(year.value AS INTEGER) > 0 THEN 1 ELSE 0 END)
            AS matching_responses
         FROM analytics_snapshot_facts fact
         JOIN projects project
           ON project.id = fact.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         JOIN json_each(
           json_extract(fact.related_query_signal_counts_json, '$.years')
         ) year
         WHERE fact.metric_date BETWEEN ? AND ?
           AND (
             (? = 'all' AND fact.tracking_source IN ('chatgpt', 'gemini', 'perplexity'))
             OR fact.tracking_source = ?
           )
           AND (
             ? = 'all'
             OR (? = '__unreported__' AND fact.provider_model IS NULL)
             OR fact.provider_model = ?
           )
           AND fact.related_query_signal_counts_indexed_at IS NOT NULL
           AND fact.related_query_signal_counts_version >= ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
           AND fact.fan_out_telemetry_indexed_at IS NOT NULL
           AND fact.fan_out_telemetry_status = 'reported'
           AND CAST(year.key AS INTEGER) BETWEEN 2025 AND ?
         GROUP BY fact.metric_date, year.key
         ORDER BY year, fact.metric_date`,
      )
        .bind(
          dates.from,
          dates.to,
          ...fanOutSourceBindings(input.source),
          ...fanOutModelBindings(input.model),
          currentYear,
        )
        .all<YearFanOutRow>(),
      c.env.CONTROL_DB.prepare(
        `SELECT fact.provider_model, COUNT(*) AS responses
         FROM analytics_snapshot_facts fact
         JOIN projects project
           ON project.id = fact.project_id AND project.deleted_at IS NULL
         JOIN workspaces workspace
           ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
         WHERE fact.metric_date BETWEEN ? AND ?
           AND (
             (? = 'all' AND fact.tracking_source IN ('chatgpt', 'gemini', 'perplexity'))
             OR fact.tracking_source = ?
           )
           AND fact.fan_out_telemetry_indexed_at IS NOT NULL
         GROUP BY fact.provider_model
         ORDER BY fact.provider_model`,
      )
        .bind(dates.from, dates.to, ...fanOutSourceBindings(input.source))
        .all<FanOutModelRow>(),
    ]);
    const completedByDate = new Map(
      daily.results.map((row) => [
        row.metric_date,
        Number(row.completed_responses),
      ]),
    );
    const reportedByDate = new Map(
      daily.results.map((row) => [
        row.metric_date,
        Number(row.reported_responses),
      ]),
    );
    const responsesWithFanOutByDate = new Map(
      daily.results.map((row) => [
        row.metric_date,
        Number(row.responses_with_fan_out),
      ]),
    );
    const totalFanOutsByDate = new Map(
      daily.results.map((row) => [row.metric_date, Number(row.total_fan_outs)]),
    );
    const signalResponseMaps = new Map<
      RelatedQuerySignalKey,
      Map<string, number>
    >();
    const signalFanOutMaps = new Map<
      RelatedQuerySignalKey,
      Map<string, number>
    >();
    for (const key of RELATED_QUERY_SIGNAL_KEYS) {
      signalResponseMaps.set(key, new Map(
        daily.results.map((row) => [
          row.metric_date,
          Number(row[`${key}_responses`]),
        ]),
      ));
      signalFanOutMaps.set(key, new Map(
        daily.results.map((row) => [
          row.metric_date,
          Number(row[`${key}_fanouts`]),
        ]),
      ));
    }
    const responseMapsByYear = new Map<number, Map<string, number>>();
    const fanOutMapsByYear = new Map<number, Map<string, number>>();
    for (const row of yearly.results) {
      const year = Number(row.year);
      const responses = responseMapsByYear.get(year) ?? new Map<string, number>();
      responses.set(row.metric_date, Number(row.matching_responses));
      responseMapsByYear.set(year, responses);
      const fanOuts = fanOutMapsByYear.get(year) ?? new Map<string, number>();
      fanOuts.set(row.metric_date, Number(row.matching_fan_outs));
      fanOutMapsByYear.set(year, fanOuts);
    }
    const signalTrends = Object.fromEntries(
      RELATED_QUERY_SIGNAL_KEYS.map((key) => [
        key,
        buildFanOutSignalTrend(
          dates,
          completedByDate,
          reportedByDate,
          totalFanOutsByDate,
          signalResponseMaps.get(key) ?? new Map(),
          signalFanOutMaps.get(key) ?? new Map(),
        ),
      ]),
    );
    const yearSignals = [...responseMapsByYear.entries()]
      .sort(([left], [right]) => left - right)
      .map(([year, responses]) => ({
        year,
        trend: buildFanOutSignalTrend(
          dates,
          completedByDate,
          reportedByDate,
          totalFanOutsByDate,
          responses,
          fanOutMapsByYear.get(year) ?? new Map(),
        ),
      }));
    return c.json({
      data: {
        period: input.period,
        source: input.source,
        model: input.model,
        models: models.results.map((row) => ({
          value: row.provider_model ?? "__unreported__",
          label: row.provider_model ?? "Model not reported",
          responses: Number(row.responses),
        })),
        indexing: false,
        remainingSnapshots: 0,
        estimatedMinutes: 0,
        activity: buildFanOutActivityTrend(
          dates,
          completedByDate,
          reportedByDate,
          responsesWithFanOutByDate,
          totalFanOutsByDate,
        ),
        signals: signalTrends,
        yearSignals,
        total: buildResponseShareTrend(
          dates,
          reportedByDate,
          responsesWithFanOutByDate,
        ),
        siteOperator: buildResponseShareTrend(
          dates,
          reportedByDate,
          signalResponseMaps.get("site") ?? new Map(),
        ),
        reviews: buildResponseShareTrend(
          dates,
          reportedByDate,
          signalResponseMaps.get("reviews") ?? new Map(),
        ),
        official: buildResponseShareTrend(
          dates,
          reportedByDate,
          signalResponseMaps.get("official") ?? new Map(),
        ),
        government: buildResponseShareTrend(
          dates,
          reportedByDate,
          signalResponseMaps.get("government") ?? new Map(),
        ),
        years: [...responseMapsByYear.entries()]
          .sort(([left], [right]) => left - right)
          .map(([year, responses]) => ({
            year,
            trend: buildResponseShareTrend(
              dates,
              reportedByDate,
              responses,
            ),
          })),
      },
    });
  },
);
