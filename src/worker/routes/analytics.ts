import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../lib/app";
import { matchedBrandTerms } from "../lib/domain";
import { evidenceResponseHeaders } from "../lib/evidence";
import { getShard } from "../lib/shards";
import { ApiError, exclusiveDateEnd, jsonParse } from "../lib/http";

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
    const [summary, series, recent] = await Promise.all([
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
    return c.json({
      data: {
        summary: {
          ...summary,
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
    return new Response(object.body, { headers });
  },
);
