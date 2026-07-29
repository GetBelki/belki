import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { resolveProviderCost } from "../../shared/provider-cost";
import type { AppEnv } from "../lib/app";
import {
  extractTaskHtml,
  sanitizeCapturedHtmlResponse,
} from "../lib/dataforseo-html";
import { requireRole } from "../lib/auth";
import { matchedBrandTerms } from "../lib/domain";
import { evidenceResponseHeaders } from "../lib/evidence";
import { getShard } from "../lib/shards";
import { ApiError, exclusiveDateEnd, jsonParse } from "../lib/http";
import {
  billingDateRange,
  buildBillingReport,
  productAnalyticsDateRange,
  productIdentity,
  productIdentityFromKey,
  productKey,
  summarizeProductPrices,
  type BillingDailyRow,
} from "../lib/reporting";

const DateRangeSchema = z.object({
  projectId: z.string().uuid(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
const PaginatedDateRangeSchema = DateRangeSchema.extend({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
const CitationSourceParamSchema = z.object({
  domain: z.string().trim().min(1).max(253).transform((value) => value.toLowerCase()),
});
const SnapshotParamSchema = z.object({ id: z.string().uuid() });
const EvidenceParamSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["raw", "html"]),
});
const PromptTagIdsSchema = z
  .string()
  .max(400)
  .transform((value) => [...new Set(value.split(",").filter(Boolean))])
  .refine(
    (values) =>
      values.length <= 10 &&
      values.every((value) => z.string().uuid().safeParse(value).success),
    "Tag filters must contain up to 10 valid tag IDs.",
  );
const PromptAnalyticsSchema = z.object({
  projectId: z.string().uuid(),
  search: z.string().trim().max(200).optional(),
  locationCode: z.coerce.number().int().optional(),
  languageCode: z.string().trim().max(12).optional(),
  tagIds: PromptTagIdsSchema.optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const BillingQuerySchema = z.object({
  projectId: z.string().uuid(),
  period: z.enum(["30d", "month"]).default("30d"),
});
const ShoppingProductParamSchema = z.object({
  productKey: z.string().trim().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/u),
});
const ShoppingProductDetailSchema = z.object({
  projectId: z.string().uuid(),
  period: z.enum(["30d", "90d", "365d"]).default("30d"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

function chunks<T>(values: T[], size = 75): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

type ProductSnapshotIndex = {
  id: string;
  shard_id: number;
};

type ShoppingProductOccurrence = {
  id: string;
  snapshot_id: string;
  tracked_query_id: string;
  keyword: string;
  location_code: number;
  language_code: string;
  ordinal: number;
  rank_absolute: number | null;
  provider_product_id: string | null;
  merchants: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  tag: string | null;
  raw_url: string | null;
  canonical_url: string | null;
  registrable_domain: string | null;
  rating_value: number | null;
  rating_votes_count: number | null;
  rating_max: number | null;
  images_json: string;
  product_ids_json: string;
  captured_at: string;
};

function productIdentitySql(identity?: string): {
  clause: string;
  bindings: string[];
} {
  if (identity?.startsWith("id:")) {
    return {
      clause: " AND p.provider_product_id = ?",
      bindings: [identity.slice(3)],
    };
  }
  if (identity?.startsWith("url:")) {
    return {
      clause: " AND COALESCE(p.canonical_url, p.raw_url) = ?",
      bindings: [identity.slice(4)],
    };
  }
  return { clause: "", bindings: [] };
}

async function loadShoppingProductOccurrences(
  env: Env,
  indexes: ProductSnapshotIndex[],
  identity?: string,
): Promise<ShoppingProductOccurrence[]> {
  const grouped = new Map<number, string[]>();
  for (const index of indexes) {
    grouped.set(index.shard_id, [...(grouped.get(index.shard_id) ?? []), index.id]);
  }
  const identitySql = productIdentitySql(identity);
  return (
    await Promise.all(
      [...grouped.entries()].flatMap(([shardId, ids]) =>
        chunks(ids).map(async (snapshotIds) => {
          const placeholders = snapshotIds.map(() => "?").join(",");
          return (
            await getShard(env, shardId)
              .prepare(
                `SELECT p.id, p.snapshot_id, s.tracked_query_id, s.keyword,
                  s.location_code, s.language_code, p.ordinal, p.rank_absolute,
                  p.provider_product_id, p.merchants,
                  p.title, p.price, p.currency, p.tag, p.raw_url, p.canonical_url,
                  p.registrable_domain, p.rating_value, p.rating_votes_count,
                  p.rating_max, p.images_json, p.product_ids_json, s.captured_at
                 FROM snapshot_products p JOIN snapshots s ON s.id = p.snapshot_id
                 WHERE p.snapshot_id IN (${placeholders})${identitySql.clause}`,
              )
              .bind(...snapshotIds, ...identitySql.bindings)
              .all<ShoppingProductOccurrence>()
          ).results;
        }),
      ),
    )
  ).flat();
}

function serializedShoppingProduct(
  product: ShoppingProductOccurrence & { appearances?: number },
) {
  return {
    ...product,
    productKey: productKey(product),
    images: jsonParse<string[]>(product.images_json, []),
    product_ids: jsonParse<unknown[]>(product.product_ids_json, []),
    latestSeen: product.captured_at,
  };
}

function range(input: { from?: string; to?: string }): { from: string; to: string } {
  const to = input.to ?? new Date().toISOString().slice(0, 10);
  const from =
    input.from ?? new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

async function assertProjectAccess(
  env: Env,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const project = await env.CONTROL_DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL",
  )
    .bind(projectId, workspaceId)
    .first();
  if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
}

export const analyticsRoutes = new Hono<AppEnv>();

analyticsRoutes.get(
  "/analytics/billing",
  zValidator("query", BillingQuerySchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const dates = billingDateRange(input.period);
    const rows = await c.env.CONTROL_DB.prepare(
      `SELECT
        substr(COALESCE(submitted_at, created_at), 1, 10) AS metric_date,
        COUNT(*) AS charged_runs,
        COALESCE(SUM(request_cost_usd), 0) AS provider_cost_usd
       FROM crawl_jobs
       WHERE project_id = ?
         AND workspace_id = ?
         AND request_cost_usd IS NOT NULL
         AND request_cost_usd > 0
         AND COALESCE(submitted_at, created_at) >= ?
         AND COALESCE(submitted_at, created_at) < ?
       GROUP BY metric_date
       ORDER BY metric_date`,
    )
      .bind(
        input.projectId,
        principal.workspaceId,
        dates.startTimestamp,
        dates.endExclusiveTimestamp,
      )
      .all<BillingDailyRow>();
    return c.json({
      data: {
        period: input.period,
        currency: "USD",
        ...buildBillingReport(rows.results, dates),
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/overview",
  zValidator("query", DateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const dates = range(input);
    const [summary, productCoverage, series, recentProductIndexes] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT
          COALESCE(SUM(completed_runs), 0) AS completed_runs,
          COALESCE(SUM(cited_runs), 0) AS cited_runs,
          COALESCE(SUM(brand_mentioned_runs), 0) AS brand_mentioned_runs,
          COALESCE(SUM(product_runs), 0) AS product_runs,
          COALESCE(SUM(total_citations), 0) AS total_citations
        FROM daily_project_metrics
        WHERE project_id = ? AND metric_date BETWEEN ? AND ?`,
      )
        .bind(input.projectId, dates.from, dates.to)
        .first<{
          completed_runs: number;
          cited_runs: number;
          brand_mentioned_runs: number;
          product_runs: number;
          total_citations: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT
          COUNT(q.id) AS tracked_prompt_count,
          COALESCE(SUM(
            CASE WHEN (
              SELECT s.has_product_block
              FROM snapshot_index s
              WHERE s.tracked_query_id = q.id
                AND s.captured_at >= ?
                AND s.captured_at < ?
              ORDER BY s.captured_at DESC
              LIMIT 1
            ) = 1 THEN 1 ELSE 0 END
          ), 0) AS product_prompt_count
        FROM tracked_queries q
        WHERE q.project_id = ?
          AND q.is_active = 1
          AND q.deleted_at IS NULL`,
      )
        .bind(
          `${dates.from}T00:00:00.000Z`,
          exclusiveDateEnd(dates.to),
          input.projectId,
        )
        .first<{
          tracked_prompt_count: number;
          product_prompt_count: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT * FROM daily_project_metrics
         WHERE project_id = ? AND metric_date BETWEEN ? AND ?
         ORDER BY metric_date`,
      )
        .bind(input.projectId, dates.from, dates.to)
        .all(),
      c.env.CONTROL_DB.prepare(
        `SELECT id, shard_id FROM snapshot_index
         WHERE project_id = ? AND captured_at >= ? AND captured_at < ?
           AND products_count > 0
         ORDER BY captured_at DESC LIMIT 24`,
      )
        .bind(
          input.projectId,
          `${dates.from}T00:00:00.000Z`,
          exclusiveDateEnd(dates.to),
        )
        .all<ProductSnapshotIndex>(),
    ]);
    const recentOccurrences = (
      await loadShoppingProductOccurrences(c.env, recentProductIndexes.results)
    ).sort((left, right) => right.captured_at.localeCompare(left.captured_at));
    const recentProducts = new Map<string, ShoppingProductOccurrence>();
    for (const product of recentOccurrences) {
      const key = productIdentity(product);
      if (!recentProducts.has(key)) recentProducts.set(key, product);
    }
    const completed = summary?.completed_runs ?? 0;
    const trackedPrompts = productCoverage?.tracked_prompt_count ?? 0;
    return c.json({
      data: {
        summary: {
          ...summary,
          trackedPromptCount: trackedPrompts,
          productPromptCount: productCoverage?.product_prompt_count ?? 0,
          productPromptCoverage: trackedPrompts
            ? ((productCoverage?.product_prompt_count ?? 0) / trackedPrompts) * 100
            : 0,
          citationRate: completed ? ((summary?.cited_runs ?? 0) / completed) * 100 : 0,
          brandMentionRate: completed
            ? ((summary?.brand_mentioned_runs ?? 0) / completed) * 100
            : 0,
          productBlockRate: completed
            ? ((summary?.product_runs ?? 0) / completed) * 100
            : 0,
        },
        series: series.results,
        recentProducts: [...recentProducts.values()]
          .slice(0, 5)
          .map(serializedShoppingProduct),
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/domains",
  zValidator("query", DateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const dates = range(input);
    const rows = await c.env.CONTROL_DB.prepare(
      `SELECT
        domain,
        SUM(cited_snapshot_count) AS cited_snapshot_count,
        SUM(citation_count) AS citation_count,
        SUM(retrieved_snapshot_count) AS retrieved_snapshot_count,
        SUM(retrieval_count) AS retrieval_count,
        SUM(product_count) AS product_count
      FROM daily_domain_metrics
      WHERE project_id = ? AND metric_date BETWEEN ? AND ?
      GROUP BY domain
      ORDER BY citation_count DESC, retrieval_count DESC
      LIMIT 250`,
    )
      .bind(input.projectId, dates.from, dates.to)
      .all();
    return c.json({ data: rows.results });
  },
);

analyticsRoutes.get(
  "/analytics/prompts",
  zValidator("query", PromptAnalyticsSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const clauses = ["q.project_id = ?", "q.deleted_at IS NULL"];
    const bindings: Array<string | number> = [input.projectId];
    if (input.search) {
      clauses.push("LOWER(q.query_text) LIKE ?");
      bindings.push(`%${input.search.toLocaleLowerCase()}%`);
    }
    if (input.locationCode !== undefined) {
      clauses.push("q.location_code = ?");
      bindings.push(input.locationCode);
    }
    if (input.languageCode) {
      clauses.push("q.language_code = ?");
      bindings.push(input.languageCode);
    }
    if (input.tagIds?.length) {
      const placeholders = input.tagIds.map(() => "?").join(",");
      clauses.push(
        `(SELECT COUNT(DISTINCT qt.tag_id)
          FROM tracked_query_tags qt
          WHERE qt.tracked_query_id = q.id
            AND qt.tag_id IN (${placeholders})) = ?`,
      );
      bindings.push(...input.tagIds, input.tagIds.length);
    }
    const totalRow = await c.env.CONTROL_DB.prepare(
      `SELECT COUNT(*) AS total
       FROM tracked_queries q
       WHERE ${clauses.join(" AND ")}`,
    )
      .bind(...bindings)
      .first<{ total: number }>();
    const total = totalRow?.total ?? 0;
    bindings.push(input.limit, input.offset);
    const queryRows = await c.env.CONTROL_DB.prepare(
      `SELECT
        q.id, q.query_text, q.location_code, q.language_code,
        q.schedule_cadence, q.schedule_time, q.schedule_timezone, q.is_active,
        q.shard_id,
        (SELECT s.id FROM snapshot_index s WHERE s.tracked_query_id = q.id
          ORDER BY s.captured_at DESC LIMIT 1) AS latest_snapshot_id,
        (SELECT s.captured_at FROM snapshot_index s WHERE s.tracked_query_id = q.id
          ORDER BY s.captured_at DESC LIMIT 1) AS latest_captured_at,
        (SELECT s.id FROM snapshot_index s WHERE s.tracked_query_id = q.id
          ORDER BY s.captured_at DESC LIMIT 1 OFFSET 1) AS previous_snapshot_id,
        (SELECT COUNT(*) FROM snapshot_index s WHERE s.tracked_query_id = q.id)
          AS snapshot_count,
        (SELECT j.status FROM crawl_jobs j WHERE j.tracked_query_id = q.id
          ORDER BY j.created_at DESC LIMIT 1) AS latest_run_status
      FROM tracked_queries q
      WHERE ${clauses.join(" AND ")}
      ORDER BY q.id
      LIMIT ? OFFSET ?`,
    )
      .bind(...bindings)
      .all<{
        id: string;
        query_text: string;
        location_code: number;
        language_code: string;
        schedule_cadence: string;
        schedule_time: string;
        schedule_timezone: string;
        is_active: number;
        shard_id: number;
        latest_snapshot_id: string | null;
        latest_captured_at: string | null;
        previous_snapshot_id: string | null;
        snapshot_count: number;
        latest_run_status: string | null;
      }>();
    const rows = queryRows.results;
    const promptTags = new Map<
      string,
      Array<{ id: string; name: string; colorIndex: number }>
    >();
    if (rows.length) {
      const promptIds = rows.map((row) => row.id);
      const tagRows = await c.env.CONTROL_DB.prepare(
        `SELECT
          qt.tracked_query_id, t.id, t.name, t.color_index
         FROM tracked_query_tags qt
         JOIN prompt_tags t ON t.id = qt.tag_id
         WHERE qt.tracked_query_id IN (${promptIds.map(() => "?").join(",")})
         ORDER BY lower(t.name), t.id`,
      )
        .bind(...promptIds)
        .all<{
          tracked_query_id: string;
          id: string;
          name: string;
          color_index: number;
        }>();
      for (const tag of tagRows.results) {
        promptTags.set(tag.tracked_query_id, [
          ...(promptTags.get(tag.tracked_query_id) ?? []),
          {
            id: tag.id,
            name: tag.name,
            colorIndex: tag.color_index,
          },
        ]);
      }
    }
    const snapshotCounts = new Map<
      string,
      { sourceCount: number; citationCount: number }
    >();
    const grouped = new Map<number, string[]>();
    for (const row of rows) {
      for (const snapshotId of [row.latest_snapshot_id, row.previous_snapshot_id]) {
        if (snapshotId) {
          grouped.set(row.shard_id, [...(grouped.get(row.shard_id) ?? []), snapshotId]);
        }
      }
    }
    await Promise.all(
      [...grouped.entries()].flatMap(([shardId, ids]) =>
        chunks([...new Set(ids)]).map(async (snapshotIds) => {
          const placeholders = snapshotIds.map(() => "?").join(",");
          const result = await getShard(c.env, shardId)
            .prepare(
              `SELECT s.id,
                (SELECT COUNT(*) FROM snapshot_search_results r
                  WHERE r.snapshot_id = s.id) AS source_count,
                (SELECT COUNT(*) FROM snapshot_sources c
                  WHERE c.snapshot_id = s.id) AS citation_count
               FROM snapshots s WHERE s.id IN (${placeholders})`,
            )
            .bind(...snapshotIds)
            .all<{ id: string; source_count: number; citation_count: number }>();
          for (const value of result.results) {
            snapshotCounts.set(value.id, {
              sourceCount: value.source_count,
              citationCount: value.citation_count,
            });
          }
        }),
      ),
    );
    const contributionIds = rows
      .flatMap((row) => [row.latest_snapshot_id, row.previous_snapshot_id])
      .filter((value): value is string => Boolean(value));
    const [ownedBrands, contributions, mentionRates] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        "SELECT id FROM tracked_brands WHERE project_id = ? AND kind = 'owned'",
      )
        .bind(input.projectId)
        .all<{ id: string }>(),
      contributionIds.length
        ? c.env.CONTROL_DB.prepare(
            `SELECT snapshot_id, brands_json FROM metric_contributions
             WHERE snapshot_id IN (${contributionIds.map(() => "?").join(",")})`,
          )
            .bind(...contributionIds)
            .all<{ snapshot_id: string; brands_json: string }>()
        : Promise.resolve({ results: [] }),
      c.env.CONTROL_DB.prepare(
        `SELECT tracked_query_id,
          SUM(completed_runs) AS completed_runs,
          SUM(brand_mentioned_runs) AS mentioned_runs
         FROM metric_contributions
         WHERE project_id = ? AND metric_date BETWEEN ? AND ?
         GROUP BY tracked_query_id`,
      )
        .bind(input.projectId, range({}).from, range({}).to)
        .all<{
          tracked_query_id: string;
          completed_runs: number;
          mentioned_runs: number;
        }>(),
    ]);
    const ownedIds = new Set(ownedBrands.results.map((brand) => brand.id));
    const mentionCount = new Map(
      contributions.results.map((contribution) => [
        contribution.snapshot_id,
        new Set(
          jsonParse<string[]>(contribution.brands_json, []).filter((id) =>
            ownedIds.has(id),
          ),
        ).size,
      ]),
    );
    const rates = new Map(
      mentionRates.results.map((value) => [
        value.tracked_query_id,
        value.completed_runs ? (value.mentioned_runs / value.completed_runs) * 100 : 0,
      ]),
    );
    return c.json({
      data: rows.map((row) => {
        const latestMentions = row.latest_snapshot_id
          ? mentionCount.get(row.latest_snapshot_id) ?? 0
          : null;
        const previousMentions = row.previous_snapshot_id
          ? mentionCount.get(row.previous_snapshot_id) ?? 0
          : null;
        const latestCounts = row.latest_snapshot_id
          ? snapshotCounts.get(row.latest_snapshot_id)
          : undefined;
        return {
          id: row.id,
          queryText: row.query_text,
          locationCode: row.location_code,
          languageCode: row.language_code,
          scheduleCadence: row.schedule_cadence,
          scheduleTime: row.schedule_time,
          scheduleTimezone: row.schedule_timezone,
          isActive: Boolean(row.is_active),
          latestSnapshotId: row.latest_snapshot_id,
          latestCapturedAt: row.latest_captured_at,
          snapshotCount: row.snapshot_count,
          latestRunStatus: row.latest_run_status,
          tags: promptTags.get(row.id) ?? [],
          sourceCount: row.latest_snapshot_id ? latestCounts?.sourceCount ?? 0 : null,
          mentionCount: latestMentions,
          mentionRate: row.latest_snapshot_id ? rates.get(row.id) ?? 0 : null,
          citationCount: row.latest_snapshot_id
            ? latestCounts?.citationCount ?? 0
            : null,
          mentionChange:
            latestMentions !== null && previousMentions !== null
              ? latestMentions - previousMentions
              : null,
        };
      }),
      page: {
        nextCursor:
          input.offset + rows.length < total
            ? String(input.offset + rows.length)
            : null,
        total,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/citation-sources",
  zValidator("query", PaginatedDateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const dates = range(input);
    const indexes = await c.env.CONTROL_DB.prepare(
      `SELECT id, shard_id FROM snapshot_index
       WHERE project_id = ? AND captured_at >= ? AND captured_at < ?`,
    )
      .bind(input.projectId, `${dates.from}T00:00:00.000Z`, exclusiveDateEnd(dates.to))
      .all<{ id: string; shard_id: number }>();
    const grouped = new Map<number, string[]>();
    for (const index of indexes.results) {
      grouped.set(index.shard_id, [...(grouped.get(index.shard_id) ?? []), index.id]);
    }
    const urls = new Map<string, Set<string>>();
    const citations = new Map<
      string,
      { total: number; snapshotIds: Set<string> }
    >();
    await Promise.all(
      [...grouped.entries()].flatMap(([shardId, ids]) =>
        chunks(ids).map(async (snapshotIds) => {
          const placeholders = snapshotIds.map(() => "?").join(",");
          const result = await getShard(c.env, shardId)
            .prepare(
              `SELECT snapshot_id, registrable_domain, canonical_url, raw_url
               FROM snapshot_sources WHERE snapshot_id IN (${placeholders})`,
            )
            .bind(...snapshotIds)
            .all<{
              snapshot_id: string;
              registrable_domain: string | null;
              canonical_url: string | null;
              raw_url: string | null;
            }>();
          for (const source of result.results) {
            if (!source.registrable_domain) continue;
            const url = source.canonical_url ?? source.raw_url;
            if (url) {
              const set = urls.get(source.registrable_domain) ?? new Set<string>();
              set.add(url);
              urls.set(source.registrable_domain, set);
            }
            const metric = citations.get(source.registrable_domain) ?? {
              total: 0,
              snapshotIds: new Set<string>(),
            };
            metric.total += 1;
            metric.snapshotIds.add(source.snapshot_id);
            citations.set(source.registrable_domain, metric);
          }
        }),
      ),
    );
    const completed = indexes.results.length;
    const sortedSources = [...citations.entries()]
      .map(([domain, metric]) => ({
        domain,
        citationRate: completed
          ? (metric.snapshotIds.size / completed) * 100
          : 0,
        totalUrls: urls.get(domain)?.size ?? 0,
        totalCitations: metric.total,
        citedSnapshots: metric.snapshotIds.size,
      }))
      .sort(
        (left, right) =>
          right.totalCitations - left.totalCitations ||
          left.domain.localeCompare(right.domain),
      );
    const page = sortedSources.slice(input.offset, input.offset + input.limit);
    return c.json({
      data: page,
      page: {
        nextCursor:
          input.offset + page.length < sortedSources.length
            ? String(input.offset + page.length)
            : null,
        total: sortedSources.length,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/citation-sources/:domain",
  zValidator("param", CitationSourceParamSchema),
  zValidator("query", PaginatedDateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const { domain } = c.req.valid("param");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const dates = range(input);
    const [dailyMetrics, indexes] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT
          p.metric_date,
          p.completed_runs,
          COALESCE(d.cited_snapshot_count, 0) AS cited_snapshot_count,
          COALESCE(d.citation_count, 0) AS citation_count
         FROM daily_project_metrics p
         LEFT JOIN daily_domain_metrics d
           ON d.project_id = p.project_id
          AND d.metric_date = p.metric_date
          AND d.domain = ?
         WHERE p.project_id = ? AND p.metric_date BETWEEN ? AND ?
         ORDER BY p.metric_date`,
      )
        .bind(domain, input.projectId, dates.from, dates.to)
        .all<{
          metric_date: string;
          completed_runs: number;
          cited_snapshot_count: number;
          citation_count: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT id, shard_id FROM snapshot_index
         WHERE project_id = ? AND captured_at >= ? AND captured_at < ?`,
      )
        .bind(
          input.projectId,
          `${dates.from}T00:00:00.000Z`,
          exclusiveDateEnd(dates.to),
        )
        .all<{ id: string; shard_id: number }>(),
    ]);
    const grouped = new Map<number, string[]>();
    for (const index of indexes.results) {
      grouped.set(index.shard_id, [...(grouped.get(index.shard_id) ?? []), index.id]);
    }
    const sourceOccurrences = (
      await Promise.all(
        [...grouped.entries()].flatMap(([shardId, ids]) =>
          chunks(ids).map(async (snapshotIds) => {
            const placeholders = snapshotIds.map(() => "?").join(",");
            return (
              await getShard(c.env, shardId)
                .prepare(
                  `SELECT
                    COALESCE(c.canonical_url, c.raw_url) AS url,
                    MAX(c.title) AS title,
                    MAX(c.source_name) AS source_name,
                    COUNT(*) AS citation_count,
                    COUNT(DISTINCT c.snapshot_id) AS cited_snapshots,
                    MAX(s.captured_at) AS last_cited_at
                   FROM snapshot_sources c
                   JOIN snapshots s ON s.id = c.snapshot_id
                   WHERE c.snapshot_id IN (${placeholders})
                     AND c.registrable_domain = ?
                     AND (c.canonical_url IS NOT NULL OR c.raw_url IS NOT NULL)
                   GROUP BY COALESCE(c.canonical_url, c.raw_url)`,
                )
                .bind(...snapshotIds, domain)
                .all<{
                  url: string;
                  title: string | null;
                  source_name: string | null;
                  citation_count: number;
                  cited_snapshots: number;
                  last_cited_at: string;
                }>()
            ).results;
          }),
        ),
      )
    ).flat();
    const urls = new Map<
      string,
      {
        url: string;
        title: string | null;
        sourceName: string | null;
        citationCount: number;
        citedSnapshots: number;
        lastCitedAt: string;
      }
    >();
    for (const source of sourceOccurrences) {
      const existing = urls.get(source.url);
      if (existing) {
        existing.citationCount += source.citation_count;
        existing.citedSnapshots += source.cited_snapshots;
        if (source.last_cited_at > existing.lastCitedAt) {
          existing.lastCitedAt = source.last_cited_at;
          existing.title = source.title ?? existing.title;
          existing.sourceName = source.source_name ?? existing.sourceName;
        }
      } else {
        urls.set(source.url, {
          url: source.url,
          title: source.title,
          sourceName: source.source_name,
          citationCount: source.citation_count,
          citedSnapshots: source.cited_snapshots,
          lastCitedAt: source.last_cited_at,
        });
      }
    }
    const rankedUrls = [...urls.values()]
      .map((source) => ({
        url: source.url,
        title: source.title,
        sourceName: source.sourceName,
        citationCount: source.citationCount,
        citedSnapshots: source.citedSnapshots,
        lastCitedAt: source.lastCitedAt,
      }))
      .sort(
        (left, right) =>
          right.citationCount - left.citationCount ||
          right.lastCitedAt.localeCompare(left.lastCitedAt) ||
          left.url.localeCompare(right.url),
      );
    const page = rankedUrls.slice(input.offset, input.offset + input.limit);
    const totals = dailyMetrics.results.reduce(
      (summary, point) => ({
        completedRuns: summary.completedRuns + point.completed_runs,
        citedSnapshots: summary.citedSnapshots + point.cited_snapshot_count,
        totalCitations: summary.totalCitations + point.citation_count,
      }),
      { completedRuns: 0, citedSnapshots: 0, totalCitations: 0 },
    );
    return c.json({
      data: {
        domain,
        summary: {
          ...totals,
          totalUrls: rankedUrls.length,
          citationRate: totals.completedRuns
            ? (totals.citedSnapshots / totals.completedRuns) * 100
            : 0,
        },
        trend: dailyMetrics.results.map((point) => ({
          date: point.metric_date,
          completedRuns: point.completed_runs,
          citedSnapshots: point.cited_snapshot_count,
          citationCount: point.citation_count,
          citationRate: point.completed_runs
            ? (point.cited_snapshot_count / point.completed_runs) * 100
            : 0,
        })),
        urls: page,
      },
      page: {
        nextCursor:
          input.offset + page.length < rankedUrls.length
            ? String(input.offset + page.length)
            : null,
        total: rankedUrls.length,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/shopping",
  zValidator("query", PaginatedDateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const dates = range(input);
    const indexes = await c.env.CONTROL_DB.prepare(
      `SELECT id, shard_id FROM snapshot_index
       WHERE project_id = ? AND captured_at >= ? AND captured_at < ?
         AND products_count > 0 ORDER BY captured_at DESC`,
    )
      .bind(input.projectId, `${dates.from}T00:00:00.000Z`, exclusiveDateEnd(dates.to))
      .all<{ id: string; shard_id: number }>();
    const occurrences = await loadShoppingProductOccurrences(c.env, indexes.results);
    const products = new Map<
      string,
      ShoppingProductOccurrence & { appearances: number }
    >();
    for (const occurrence of occurrences.sort((left, right) =>
      right.captured_at.localeCompare(left.captured_at),
    )) {
      const key = productIdentity(occurrence);
      const existing = products.get(key);
      if (existing) {
        existing.appearances += 1;
      } else {
        products.set(key, { ...occurrence, appearances: 1 });
      }
    }
    const sortedProducts = [...products.values()].sort(
      (left, right) =>
        right.appearances - left.appearances ||
        right.captured_at.localeCompare(left.captured_at),
    );
    const page = sortedProducts.slice(input.offset, input.offset + input.limit);
    return c.json({
      data: page.map(serializedShoppingProduct),
      page: {
        nextCursor:
          input.offset + page.length < sortedProducts.length
            ? String(input.offset + page.length)
            : null,
        total: sortedProducts.length,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/shopping/:productKey",
  zValidator("param", ShoppingProductParamSchema),
  zValidator("query", ShoppingProductDetailSchema),
  async (c) => {
    const principal = c.get("principal");
    const { productKey: routeProductKey } = c.req.valid("param");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const identity = productIdentityFromKey(routeProductKey);
    if (!identity) {
      throw new ApiError(404, "product_not_found", "Product not found.");
    }
    const dates = productAnalyticsDateRange(input.period);
    const [indexes, projectMetrics] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT id, shard_id FROM snapshot_index
         WHERE project_id = ? AND captured_at >= ? AND captured_at < ?
           AND products_count > 0
         ORDER BY captured_at DESC`,
      )
        .bind(input.projectId, dates.startTimestamp, dates.endExclusiveTimestamp)
        .all<ProductSnapshotIndex>(),
      c.env.CONTROL_DB.prepare(
        `SELECT metric_date, completed_runs
         FROM daily_project_metrics
         WHERE project_id = ? AND metric_date BETWEEN ? AND ?
         ORDER BY metric_date`,
      )
        .bind(input.projectId, dates.from, dates.to)
        .all<{ metric_date: string; completed_runs: number }>(),
    ]);
    const occurrences = (
      await loadShoppingProductOccurrences(c.env, indexes.results, identity)
    )
      .filter((occurrence) => productIdentity(occurrence) === identity)
      .sort(
        (left, right) =>
          right.captured_at.localeCompare(left.captured_at) ||
          right.id.localeCompare(left.id),
      );
    if (!occurrences.length) {
      throw new ApiError(
        404,
        "product_not_found",
        "This product has no observations in the selected period.",
      );
    }

    const completedByDate = new Map(
      projectMetrics.results.map((metric) => [
        metric.metric_date,
        Number(metric.completed_runs) || 0,
      ]),
    );
    const completedRuns = [...completedByDate.values()].reduce(
      (total, value) => total + value,
      0,
    );
    const appearingSnapshots = new Set(
      occurrences.map((occurrence) => occurrence.snapshot_id),
    );
    const promptIds = new Set(
      occurrences.map((occurrence) => occurrence.tracked_query_id),
    );
    const merchantLabels = new Set(
      occurrences
        .map(
          (occurrence) =>
            occurrence.merchants ?? occurrence.registrable_domain,
        )
        .filter((value): value is string => Boolean(value)),
    );
    const positions = occurrences
      .map((occurrence) => occurrence.ordinal + 1)
      .filter((position) => Number.isFinite(position));
    const latest = occurrences[0]!;
    const priceSummary = summarizeProductPrices(occurrences);
    const latestRatingOccurrence = occurrences.find(
      (occurrence) =>
        occurrence.rating_value !== null ||
        occurrence.rating_votes_count !== null,
    );
    const earliestRatingOccurrence = latestRatingOccurrence
      ? [...occurrences]
          .reverse()
          .find(
            (occurrence) =>
              occurrence.rating_value !== null ||
              occurrence.rating_votes_count !== null,
          )
      : undefined;
    const hasEarlierRating =
      latestRatingOccurrence !== undefined &&
      earliestRatingOccurrence !== undefined &&
      latestRatingOccurrence.id !== earliestRatingOccurrence.id;
    const ratingSummary = latestRatingOccurrence
      ? {
          value: latestRatingOccurrence.rating_value,
          maximum: latestRatingOccurrence.rating_max,
          reviews: latestRatingOccurrence.rating_votes_count,
          reviewChange:
            hasEarlierRating &&
            latestRatingOccurrence.rating_votes_count !== null &&
            earliestRatingOccurrence?.rating_votes_count !== null &&
            earliestRatingOccurrence?.rating_votes_count !== undefined
              ? latestRatingOccurrence.rating_votes_count -
                earliestRatingOccurrence.rating_votes_count
              : null,
          ratingChange:
            hasEarlierRating &&
            latestRatingOccurrence.rating_value !== null &&
            earliestRatingOccurrence?.rating_value !== null &&
            earliestRatingOccurrence?.rating_value !== undefined &&
            latestRatingOccurrence.rating_max ===
              earliestRatingOccurrence.rating_max
              ? latestRatingOccurrence.rating_value -
                earliestRatingOccurrence.rating_value
              : null,
        }
      : null;

    const dailyOccurrences = new Map<string, ShoppingProductOccurrence[]>();
    for (const occurrence of occurrences) {
      const date = occurrence.captured_at.slice(0, 10);
      dailyOccurrences.set(date, [
        ...(dailyOccurrences.get(date) ?? []),
        occurrence,
      ]);
    }
    const visibilityTrend: Array<{
      date: string;
      completedRuns: number;
      appearingCaptures: number;
      appearances: number;
      appearanceRate: number;
      averagePosition: number | null;
    }> = [];
    const priceTrend: Array<{
      date: string;
      currency: string | null;
      latest: number;
      minimum: number;
      maximum: number;
    }> = [];
    const reviewTrend: Array<{
      date: string;
      rating: number | null;
      ratingMaximum: number | null;
      reviews: number | null;
    }> = [];
    const dateCursor = new Date(`${dates.from}T00:00:00.000Z`);
    const dateEnd = new Date(`${dates.to}T00:00:00.000Z`);
    while (dateCursor <= dateEnd) {
      const date = dateCursor.toISOString().slice(0, 10);
      const day = (dailyOccurrences.get(date) ?? []).sort((left, right) =>
        right.captured_at.localeCompare(left.captured_at),
      );
      const dayCaptures = new Set(
        day.map((occurrence) => occurrence.snapshot_id),
      ).size;
      const dayPositions = day.map((occurrence) => occurrence.ordinal + 1);
      const dayCompletedRuns = completedByDate.get(date) ?? 0;
      visibilityTrend.push({
        date,
        completedRuns: dayCompletedRuns,
        appearingCaptures: dayCaptures,
        appearances: day.length,
        appearanceRate: dayCompletedRuns
          ? (dayCaptures / dayCompletedRuns) * 100
          : 0,
        averagePosition: dayPositions.length
          ? dayPositions.reduce((sum, value) => sum + value, 0) /
            dayPositions.length
          : null,
      });
      const pricesByCurrency = new Map<
        string,
        ShoppingProductOccurrence[]
      >();
      for (const occurrence of day) {
        if (occurrence.price === null) continue;
        const currency = occurrence.currency ?? "";
        pricesByCurrency.set(currency, [
          ...(pricesByCurrency.get(currency) ?? []),
          occurrence,
        ]);
      }
      for (const [currency, priceOccurrences] of pricesByCurrency) {
        const values = priceOccurrences.map(
          (occurrence) => occurrence.price ?? 0,
        );
        priceTrend.push({
          date,
          currency: currency || null,
          latest: priceOccurrences[0]!.price ?? 0,
          minimum: Math.min(...values),
          maximum: Math.max(...values),
        });
      }
      const dailyRating = day.find(
        (occurrence) =>
          occurrence.rating_value !== null ||
          occurrence.rating_votes_count !== null,
      );
      if (dailyRating) {
        reviewTrend.push({
          date,
          rating: dailyRating.rating_value,
          ratingMaximum: dailyRating.rating_max,
          reviews: dailyRating.rating_votes_count,
        });
      }
      dateCursor.setUTCDate(dateCursor.getUTCDate() + 1);
    }

    const promptMap = new Map<
      string,
      {
        queryId: string;
        prompt: string;
        locationCode: number;
        languageCode: string;
        appearances: number;
        snapshotIds: Set<string>;
        latestSeen: string;
        latestSnapshotId: string;
        latestPosition: number;
        latestPrice: number | null;
        latestCurrency: string | null;
      }
    >();
    for (const occurrence of occurrences) {
      const existing = promptMap.get(occurrence.tracked_query_id);
      if (existing) {
        existing.appearances += 1;
        existing.snapshotIds.add(occurrence.snapshot_id);
        continue;
      }
      promptMap.set(occurrence.tracked_query_id, {
        queryId: occurrence.tracked_query_id,
        prompt: occurrence.keyword,
        locationCode: occurrence.location_code,
        languageCode: occurrence.language_code,
        appearances: 1,
        snapshotIds: new Set([occurrence.snapshot_id]),
        latestSeen: occurrence.captured_at,
        latestSnapshotId: occurrence.snapshot_id,
        latestPosition: occurrence.ordinal + 1,
        latestPrice: occurrence.price,
        latestCurrency: occurrence.currency,
      });
    }
    const prompts = [...promptMap.values()]
      .map(({ snapshotIds, ...prompt }) => ({
        ...prompt,
        captures: snapshotIds.size,
      }))
      .sort(
        (left, right) =>
          right.appearances - left.appearances ||
          right.latestSeen.localeCompare(left.latestSeen),
      );

    const merchantMap = new Map<
      string,
      {
        merchant: string;
        appearances: number;
        latestSeen: string;
        latestRating: number | null;
        latestReviews: number | null;
        prices: Map<
          string,
          { currency: string | null; latest: number; minimum: number; maximum: number }
        >;
      }
    >();
    for (const occurrence of occurrences) {
      const merchant =
        occurrence.merchants ??
        occurrence.registrable_domain ??
        "Merchant unavailable";
      const existing = merchantMap.get(merchant);
      const priceKey = occurrence.currency ?? "";
      if (!existing) {
        const prices = new Map<
          string,
          { currency: string | null; latest: number; minimum: number; maximum: number }
        >();
        if (occurrence.price !== null) {
          prices.set(priceKey, {
            currency: occurrence.currency,
            latest: occurrence.price,
            minimum: occurrence.price,
            maximum: occurrence.price,
          });
        }
        merchantMap.set(merchant, {
          merchant,
          appearances: 1,
          latestSeen: occurrence.captured_at,
          latestRating: occurrence.rating_value,
          latestReviews: occurrence.rating_votes_count,
          prices,
        });
        continue;
      }
      existing.appearances += 1;
      if (
        existing.latestRating === null &&
        occurrence.rating_value !== null
      ) {
        existing.latestRating = occurrence.rating_value;
      }
      if (
        existing.latestReviews === null &&
        occurrence.rating_votes_count !== null
      ) {
        existing.latestReviews = occurrence.rating_votes_count;
      }
      if (occurrence.price !== null) {
        const price = existing.prices.get(priceKey);
        if (price) {
          price.minimum = Math.min(price.minimum, occurrence.price);
          price.maximum = Math.max(price.maximum, occurrence.price);
        } else {
          existing.prices.set(priceKey, {
            currency: occurrence.currency,
            latest: occurrence.price,
            minimum: occurrence.price,
            maximum: occurrence.price,
          });
        }
      }
    }
    const merchants = [...merchantMap.values()]
      .map(({ prices, ...merchant }) => ({
        ...merchant,
        prices: [...prices.values()],
      }))
      .sort(
        (left, right) =>
          right.appearances - left.appearances ||
          right.latestSeen.localeCompare(left.latestSeen),
      );

    const occurrencePage = occurrences.slice(
      input.offset,
      input.offset + input.limit,
    );
    return c.json({
      data: {
        product: serializedShoppingProduct(latest),
        range: { from: dates.from, to: dates.to, period: input.period },
        summary: {
          completedRuns,
          appearingCaptures: appearingSnapshots.size,
          appearanceRate: completedRuns
            ? (appearingSnapshots.size / completedRuns) * 100
            : 0,
          appearances: occurrences.length,
          prompts: promptIds.size,
          merchants: merchantLabels.size,
          firstSeen: occurrences.at(-1)?.captured_at ?? latest.captured_at,
          latestSeen: latest.captured_at,
          latestPosition: latest.ordinal + 1,
          averagePosition: positions.length
            ? positions.reduce((sum, value) => sum + value, 0) /
              positions.length
            : null,
          price: priceSummary,
          rating: ratingSummary,
        },
        visibilityTrend,
        priceTrend,
        reviewTrend,
        prompts,
        merchants,
        occurrences: occurrencePage.map((occurrence) => ({
          id: occurrence.id,
          snapshotId: occurrence.snapshot_id,
          queryId: occurrence.tracked_query_id,
          prompt: occurrence.keyword,
          locationCode: occurrence.location_code,
          languageCode: occurrence.language_code,
          capturedAt: occurrence.captured_at,
          merchant:
            occurrence.merchants ??
            occurrence.registrable_domain ??
            null,
          position: occurrence.ordinal + 1,
          rankAbsolute: occurrence.rank_absolute,
          price: occurrence.price,
          currency: occurrence.currency,
          rating: occurrence.rating_value,
          ratingMaximum: occurrence.rating_max,
          reviews: occurrence.rating_votes_count,
        })),
      },
      page: {
        nextCursor:
          input.offset + occurrencePage.length < occurrences.length
            ? String(input.offset + occurrencePage.length)
            : null,
        total: occurrences.length,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/brands",
  zValidator("query", DateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const dates = range(input);
    const rows = await c.env.CONTROL_DB.prepare(
      `SELECT
        b.id, b.name, b.kind,
        COALESCE(SUM(m.mentioned_snapshot_count), 0) AS mentioned_snapshot_count
      FROM tracked_brands b
      LEFT JOIN daily_brand_metrics m
        ON m.tracked_brand_id = b.id AND m.metric_date BETWEEN ? AND ?
      WHERE b.project_id = ?
      GROUP BY b.id
      ORDER BY b.kind DESC, mentioned_snapshot_count DESC, b.name`,
    )
      .bind(dates.from, dates.to, input.projectId)
      .all();
    return c.json({ data: rows.results });
  },
);

analyticsRoutes.get(
  "/analytics/products",
  zValidator("query", DateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const dates = range(input);
    const indexes = await c.env.CONTROL_DB.prepare(
      `SELECT id, shard_id FROM snapshot_index
       WHERE project_id = ? AND captured_at >= ? AND captured_at < ?
         AND products_count > 0
       ORDER BY captured_at DESC LIMIT 500`,
    )
      .bind(
        input.projectId,
        `${dates.from}T00:00:00.000Z`,
        exclusiveDateEnd(dates.to),
      )
      .all<{ id: string; shard_id: number }>();
    const grouped = new Map<number, string[]>();
    for (const item of indexes.results) {
      grouped.set(item.shard_id, [...(grouped.get(item.shard_id) ?? []), item.id]);
    }
    const products = (
      await Promise.all(
        [...grouped.entries()].map(async ([shardId, snapshotIds]) => {
          const placeholders = snapshotIds.map(() => "?").join(",");
          const result = await getShard(c.env, shardId)
            .prepare(
              `SELECT
                p.id, p.snapshot_id, p.title, p.price, p.currency, p.tag,
                p.raw_url, p.registrable_domain, p.rating_value,
                p.rating_votes_count, p.images_json, s.captured_at
              FROM snapshot_products p
              JOIN snapshots s ON s.id = p.snapshot_id
              WHERE p.snapshot_id IN (${placeholders})
              ORDER BY s.captured_at DESC LIMIT 500`,
            )
            .bind(...snapshotIds)
            .all();
          return result.results;
        }),
      )
    )
      .flat()
      .sort((left, right) =>
        String(right.captured_at).localeCompare(String(left.captured_at)),
      )
      .slice(0, 500);
    return c.json({ data: products });
  },
);

analyticsRoutes.get(
  "/snapshots",
  zValidator(
    "query",
    z.object({
      projectId: z.string().uuid(),
      queryId: z.string().uuid().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  ),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const clauses = ["project_id = ?"];
    const bindings: Array<string | number> = [input.projectId];
    if (input.queryId) {
      clauses.push("tracked_query_id = ?");
      bindings.push(input.queryId);
    }
    if (input.cursor) {
      clauses.push("captured_at < ?");
      bindings.push(input.cursor);
    }
    bindings.push(input.limit + 1);
    const rows = await c.env.CONTROL_DB.prepare(
      `SELECT s.*, q.query_text
       FROM snapshot_index s
       JOIN tracked_queries q ON q.id = s.tracked_query_id
       WHERE ${clauses.map((clause) => `s.${clause}`).join(" AND ")}
       ORDER BY s.captured_at DESC LIMIT ?`,
    )
      .bind(...bindings)
      .all<{ captured_at: string }>();
    const results = rows.results.slice(0, input.limit);
    return c.json({
      data: results,
      page: {
        nextCursor:
          rows.results.length > input.limit
            ? results.at(-1)?.captured_at ?? ""
            : null,
      },
    });
  },
);

analyticsRoutes.get(
  "/snapshots/:id",
  zValidator("param", SnapshotParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const index = await c.env.CONTROL_DB.prepare(
      "SELECT * FROM snapshot_index WHERE id = ? AND workspace_id = ?",
    )
      .bind(id, principal.workspaceId)
      .first<{
        shard_id: number;
        project_id: string;
        crawl_job_id: string;
      } & Record<string, unknown>>();
    if (!index) throw new ApiError(404, "snapshot_not_found", "Snapshot not found.");
    const shard = getShard(c.env, index.shard_id);
    const [
      snapshot,
      sources,
      searchResults,
      brands,
      products,
      domains,
      items,
      trackedBrands,
      crawlJob,
    ] =
      await Promise.all([
        shard
          .prepare("SELECT * FROM snapshots WHERE id = ?")
          .bind(id)
          .first<
            Record<string, unknown> & {
              item_types_json: string;
              fan_out_queries_json: string;
              answer_markdown: string | null;
              provider_cost_usd: number | null;
            }
          >(),
        shard
          .prepare("SELECT * FROM snapshot_sources WHERE snapshot_id = ? ORDER BY ordinal")
          .bind(id)
          .all(),
        shard
          .prepare(
            "SELECT * FROM snapshot_search_results WHERE snapshot_id = ? ORDER BY ordinal",
          )
          .bind(id)
          .all(),
        shard
          .prepare(
            `SELECT b.*, u.raw_url, u.registrable_domain
             FROM snapshot_brand_entities b
             LEFT JOIN brand_entity_urls u ON u.brand_entity_id = b.id
             WHERE b.snapshot_id = ? ORDER BY b.ordinal, u.ordinal`,
          )
          .bind(id)
          .all(),
        shard
          .prepare("SELECT * FROM snapshot_products WHERE snapshot_id = ? ORDER BY ordinal")
          .bind(id)
          .all<
            Record<string, unknown> & {
              images_json: string;
              product_ids_json: string;
            }
          >(),
        shard
          .prepare(
            "SELECT * FROM snapshot_domains WHERE snapshot_id = ? ORDER BY cited_count DESC",
          )
          .bind(id)
          .all(),
        shard
          .prepare(
            `SELECT id, snapshot_id, ordinal, type, rank_group, rank_absolute,
              markdown, payload_json
             FROM snapshot_items WHERE snapshot_id = ? ORDER BY ordinal`,
          )
          .bind(id)
          .all<Record<string, unknown> & { payload_json: string }>(),
        c.env.CONTROL_DB.prepare(
          `SELECT id, kind, name, aliases_json
           FROM tracked_brands WHERE project_id = ? ORDER BY kind DESC, name`,
        )
          .bind(index.project_id)
          .all<{
            id: string;
            kind: "owned" | "competitor";
            name: string;
            aliases_json: string;
          }>(),
        c.env.CONTROL_DB.prepare(
          `SELECT request_cost_usd
           FROM crawl_jobs
           WHERE id = ? AND workspace_id = ?`,
        )
          .bind(index.crawl_job_id, principal.workspaceId)
          .first<{ request_cost_usd: number | null }>(),
      ]);
    const structuredSnapshot = snapshot
      ? {
          ...snapshot,
          provider_cost_usd: resolveProviderCost(
            crawlJob?.request_cost_usd,
            snapshot.provider_cost_usd,
          ),
          has_html_evidence: Boolean(snapshot.html_r2_key),
          item_types: jsonParse<unknown[]>(
            snapshot.item_types_json,
            [],
          ),
          fan_out_queries: jsonParse<unknown[]>(
            snapshot.fan_out_queries_json,
            [],
          ),
        }
      : null;
    const structuredProducts = products.results.map((product) => ({
      ...product,
      images: jsonParse<unknown[]>(product.images_json, []),
      product_ids: jsonParse<unknown[]>(
        product.product_ids_json,
        [],
      ),
    }));
    const structuredItems = items.results.map((item) => ({
      ...item,
      payload: jsonParse<unknown>(
        item.payload_json,
        {},
      ),
    }));
    const answerMarkdown =
      typeof structuredSnapshot?.answer_markdown === "string"
        ? structuredSnapshot.answer_markdown
        : "";
    const brandMentions = trackedBrands.results.flatMap((brand) => {
      const matchedTerms = matchedBrandTerms(
        answerMarkdown,
        brand.name,
        jsonParse<string[]>(brand.aliases_json, []),
      );
      return matchedTerms.length ? [{ ...brand, matchedTerms }] : [];
    });
    return c.json({
      data: {
        snapshot: structuredSnapshot,
        sources: sources.results,
        searchResults: searchResults.results,
        brands: brands.results,
        products: structuredProducts,
        domains: domains.results,
        items: structuredItems,
        brandMentions,
      },
    });
  },
);

analyticsRoutes.get(
  "/snapshots/:id/diff",
  zValidator("param", SnapshotParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT id, tracked_query_id, shard_id, captured_at, model, answer_hash, has_product_block
       FROM snapshot_index WHERE id = ? AND workspace_id = ?`,
    )
      .bind(id, principal.workspaceId)
      .first<{
        id: string;
        tracked_query_id: string;
        shard_id: number;
        captured_at: string;
        model: string | null;
        answer_hash: string;
        has_product_block: number;
      }>();
    if (!current) throw new ApiError(404, "snapshot_not_found", "Snapshot not found.");
    const previous = await c.env.CONTROL_DB.prepare(
      `SELECT id, model, answer_hash, has_product_block, captured_at
       FROM snapshot_index
       WHERE tracked_query_id = ? AND captured_at < ?
       ORDER BY captured_at DESC LIMIT 1`,
    )
      .bind(current.tracked_query_id, current.captured_at)
      .first<{
        id: string;
        model: string | null;
        answer_hash: string;
        has_product_block: number;
        captured_at: string;
      }>();
    if (!previous) return c.json({ data: { previous: null } });
    const shard = getShard(c.env, current.shard_id);
    const [currentDomains, previousDomains, currentBrands, previousBrands] =
      await Promise.all([
        shard
          .prepare(
            "SELECT registrable_domain FROM snapshot_domains WHERE snapshot_id = ? AND cited_count > 0",
          )
          .bind(current.id)
          .all<{ registrable_domain: string }>(),
        shard
          .prepare(
            "SELECT registrable_domain FROM snapshot_domains WHERE snapshot_id = ? AND cited_count > 0",
          )
          .bind(previous.id)
          .all<{ registrable_domain: string }>(),
        shard
          .prepare(
            "SELECT DISTINCT normalized_title FROM snapshot_brand_entities WHERE snapshot_id = ?",
          )
          .bind(current.id)
          .all<{ normalized_title: string }>(),
        shard
          .prepare(
            "SELECT DISTINCT normalized_title FROM snapshot_brand_entities WHERE snapshot_id = ?",
          )
          .bind(previous.id)
          .all<{ normalized_title: string }>(),
      ]);
    const setDiff = (left: string[], right: string[]) =>
      left.filter((value) => !new Set(right).has(value));
    const currentDomainValues = currentDomains.results.map((row) => row.registrable_domain);
    const previousDomainValues = previousDomains.results.map((row) => row.registrable_domain);
    const currentBrandValues = currentBrands.results.map((row) => row.normalized_title);
    const previousBrandValues = previousBrands.results.map((row) => row.normalized_title);
    return c.json({
      data: {
        previous: { id: previous.id, capturedAt: previous.captured_at },
        domains: {
          added: setDiff(currentDomainValues, previousDomainValues),
          removed: setDiff(previousDomainValues, currentDomainValues),
        },
        brands: {
          added: setDiff(currentBrandValues, previousBrandValues),
          removed: setDiff(previousBrandValues, currentBrandValues),
        },
        answerChanged: current.answer_hash !== previous.answer_hash,
        modelChanged: current.model !== previous.model,
        productBlockChanged: current.has_product_block !== previous.has_product_block,
      },
    });
  },
);

analyticsRoutes.get(
  "/snapshots/:id/evidence/:kind",
  zValidator("param", EvidenceParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id, kind } = c.req.valid("param");
    const index = await c.env.CONTROL_DB.prepare(
      "SELECT raw_r2_key, html_r2_key FROM snapshot_index WHERE id = ? AND workspace_id = ?",
    )
      .bind(id, principal.workspaceId)
      .first<{ raw_r2_key: string; html_r2_key: string | null }>();
    if (!index) throw new ApiError(404, "snapshot_not_found", "Snapshot not found.");
    const key = kind === "raw" ? index.raw_r2_key : index.html_r2_key;
    if (!key) throw new ApiError(404, "evidence_not_found", "Evidence is not available.");
    const object = await c.env.EVIDENCE_BUCKET.get(key);
    if (!object) throw new ApiError(404, "evidence_not_found", "Evidence is not available.");
    if (kind === "html" && object.size > 20 * 1024 * 1024) {
      throw new ApiError(
        422,
        "evidence_too_large",
        "The stored HTML evidence is too large to open safely.",
      );
    }
    const metadata = new Headers();
    object.writeHttpMetadata(metadata);
    const headers = evidenceResponseHeaders(kind, id, metadata);
    if (kind === "html" && key.endsWith(".json")) {
      try {
        const payload = await new Response(object.body).json();
        return sanitizeCapturedHtmlResponse(
          new Response(extractTaskHtml(payload), { headers }),
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "evidence.legacy_html_invalid",
            snapshotId: id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        throw new ApiError(
          422,
          "evidence_invalid",
          "The stored HTML evidence could not be decoded.",
        );
      }
    }
    const response = new Response(object.body, { headers });
    return kind === "html"
      ? sanitizeCapturedHtmlResponse(response)
      : response;
  },
);
