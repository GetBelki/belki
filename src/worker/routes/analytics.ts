import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../lib/app";
import { extractTaskHtml } from "../lib/dataforseo-html";
import { matchedBrandTerms } from "../lib/domain";
import { evidenceResponseHeaders } from "../lib/evidence";
import { getShard } from "../lib/shards";
import { ApiError, exclusiveDateEnd, jsonParse } from "../lib/http";
import { productIdentity } from "../lib/reporting";

const DateRangeSchema = z.object({
  projectId: z.string().uuid(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
const SnapshotParamSchema = z.object({ id: z.string().uuid() });
const EvidenceParamSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["raw", "html"]),
});
const PromptAnalyticsSchema = z.object({
  projectId: z.string().uuid(),
  search: z.string().trim().max(200).optional(),
  locationCode: z.coerce.number().int().optional(),
  languageCode: z.string().trim().max(12).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function chunks<T>(values: T[], size = 75): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
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
  "/analytics/overview",
  zValidator("query", DateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const dates = range(input);
    const [summary, productCoverage, series, recent] = await Promise.all([
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
        `SELECT
          s.id, s.tracked_query_id, s.captured_at, s.model,
          s.cited_domains_count, s.brand_entities_count, s.products_count,
          q.query_text
        FROM snapshot_index s
        JOIN tracked_queries q ON q.id = s.tracked_query_id
        WHERE s.project_id = ?
        ORDER BY s.captured_at DESC LIMIT 10`,
      )
        .bind(input.projectId)
        .all(),
    ]);
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
        recentSnapshots: recent.results,
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
    if (input.cursor) {
      clauses.push("q.id > ?");
      bindings.push(input.cursor);
    }
    bindings.push(input.limit + 1);
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
      LIMIT ?`,
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
    const rows = queryRows.results.slice(0, input.limit);
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
          queryRows.results.length > input.limit ? rows.at(-1)?.id ?? null : null,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/citation-sources",
  zValidator("query", DateRangeSchema),
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
    return c.json({
      data: [...citations.entries()]
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
        )
        .slice(0, 250),
    });
  },
);

analyticsRoutes.get(
  "/analytics/shopping",
  zValidator("query", DateRangeSchema),
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
    const grouped = new Map<number, string[]>();
    for (const index of indexes.results) {
      grouped.set(index.shard_id, [...(grouped.get(index.shard_id) ?? []), index.id]);
    }
    type Product = {
      id: string;
      snapshot_id: string;
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
      images_json: string;
      captured_at: string;
    };
    const occurrences = (
      await Promise.all(
        [...grouped.entries()].flatMap(([shardId, ids]) =>
          chunks(ids).map(async (snapshotIds) => {
            const placeholders = snapshotIds.map(() => "?").join(",");
            return (
              await getShard(c.env, shardId)
                .prepare(
                  `SELECT p.id, p.snapshot_id, p.provider_product_id, p.merchants,
                    p.title, p.price, p.currency, p.tag, p.raw_url, p.canonical_url,
                    p.registrable_domain, p.rating_value, p.rating_votes_count,
                    p.images_json, s.captured_at
                   FROM snapshot_products p JOIN snapshots s ON s.id = p.snapshot_id
                   WHERE p.snapshot_id IN (${placeholders})`,
                )
                .bind(...snapshotIds)
                .all<Product>()
            ).results;
          }),
        ),
      )
    ).flat();
    const products = new Map<string, Product & { appearances: number }>();
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
    return c.json({
      data: [...products.values()]
        .sort(
          (left, right) =>
            right.appearances - left.appearances ||
            right.captured_at.localeCompare(left.captured_at),
        )
        .slice(0, 500)
        .map((product) => ({
          ...product,
          images: jsonParse<string[]>(product.images_json, []),
          latestSeen: product.captured_at,
        })),
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
      .first<{ shard_id: number; project_id: string } & Record<string, unknown>>();
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
      ]);
    const structuredSnapshot = snapshot
      ? {
          ...snapshot,
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
    const metadata = new Headers();
    object.writeHttpMetadata(metadata);
    const headers = evidenceResponseHeaders(kind, id, metadata);
    if (kind === "html" && key.endsWith(".json")) {
      if (object.size > 20 * 1024 * 1024) {
        throw new ApiError(
          422,
          "evidence_too_large",
          "The stored HTML evidence is too large to open safely.",
        );
      }
      try {
        const payload = await new Response(object.body).json();
        return new Response(extractTaskHtml(payload), { headers });
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
    return new Response(object.body, { headers });
  },
);
