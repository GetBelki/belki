import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/app";
import { allowedAdAssetUrl, decodeAdKey } from "../lib/ads";
import { ApiError, exclusiveDateEnd } from "../lib/http";

const PeriodSchema = z.enum(["7d", "30d", "90d", "365d"]);
const TagIdsSchema = z
  .string()
  .max(400)
  .transform((value) => [...new Set(value.split(",").filter(Boolean))])
  .refine(
    (values) => values.length <= 10 && values.every(
      (value) => z.string().uuid().safeParse(value).success,
    ),
    "Tag filters must contain up to 10 valid tag IDs.",
  );
const AdsQuerySchema = z.object({
  projectId: z.string().uuid(),
  period: PeriodSchema.default("30d"),
  search: z.string().trim().max(200).optional(),
  locationCode: z.coerce.number().int().optional(),
  tagIds: TagIdsSchema.optional(),
  relationship: z.enum(["owned", "competitor", "untracked"]).optional(),
});
const AdvertiserParamSchema = z.object({
  advertiserKey: z.string().trim().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/u),
});
const AssetParamSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/u) });
const AssetQuerySchema = z.object({ projectId: z.string().uuid() });

type AdsQuery = z.infer<typeof AdsQuerySchema>;
type SqlBinding = string | number;

function dateRange(period: z.infer<typeof PeriodSchema>) {
  const days = period === "365d" ? 365 : period === "90d" ? 90 : period === "7d" ? 7 : 30;
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const fromDate = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - days + 1,
  ));
  return {
    from: fromDate.toISOString().slice(0, 10),
    to,
    start: `${fromDate.toISOString().slice(0, 10)}T00:00:00.000Z`,
    end: exclusiveDateEnd(to),
  };
}

async function assertProjectAccess(env: Env, workspaceId: string, projectId: string) {
  const project = await env.CONTROL_DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL",
  )
    .bind(projectId, workspaceId)
    .first();
  if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
}

function filters(input: AdsQuery, advertiserIdentity?: string) {
  const range = dateRange(input.period);
  const clauses = [
    "ad.project_id = ?",
    "ad.captured_at >= ?",
    "ad.captured_at < ?",
  ];
  const bindings: SqlBinding[] = [input.projectId, range.start, range.end];
  if (input.locationCode !== undefined) {
    clauses.push("query.location_code = ?");
    bindings.push(input.locationCode);
  }
  if (input.relationship) {
    clauses.push("ad.relationship = ?");
    bindings.push(input.relationship);
  }
  if (advertiserIdentity) {
    clauses.push("ad.advertiser_identity = ?");
    bindings.push(advertiserIdentity);
  }
  if (input.search) {
    clauses.push(`(
      LOWER(COALESCE(ad.advertiser_name, '')) LIKE ? OR
      LOWER(COALESCE(ad.advertiser_domain, '')) LIKE ? OR
      LOWER(COALESCE(ad.title, '')) LIKE ? OR
      LOWER(COALESCE(ad.snippet, '')) LIKE ?
    )`);
    const value = `%${input.search.toLocaleLowerCase()}%`;
    bindings.push(value, value, value, value);
  }
  if (input.tagIds?.length) {
    clauses.push(`ad.tracked_query_id IN (
      SELECT assignment.tracked_query_id
      FROM tracked_query_tags assignment
      WHERE assignment.tag_id IN (${input.tagIds.map(() => "?").join(",")})
      GROUP BY assignment.tracked_query_id
      HAVING COUNT(DISTINCT assignment.tag_id) = ?
    )`);
    bindings.push(...input.tagIds, input.tagIds.length);
  }
  return { where: clauses.join(" AND "), bindings, range };
}

function completedFilters(input: AdsQuery) {
  const range = dateRange(input.period);
  const clauses = [
    "fact.project_id = ?",
    "fact.captured_at >= ?",
    "fact.captured_at < ?",
  ];
  const bindings: SqlBinding[] = [input.projectId, range.start, range.end];
  if (input.locationCode !== undefined) {
    clauses.push("query.location_code = ?");
    bindings.push(input.locationCode);
  }
  if (input.tagIds?.length) {
    clauses.push(`fact.tracked_query_id IN (
      SELECT assignment.tracked_query_id
      FROM tracked_query_tags assignment
      WHERE assignment.tag_id IN (${input.tagIds.map(() => "?").join(",")})
      GROUP BY assignment.tracked_query_id
      HAVING COUNT(DISTINCT assignment.tag_id) = ?
    )`);
    bindings.push(...input.tagIds, input.tagIds.length);
  }
  return { where: clauses.join(" AND "), bindings };
}

function assetUrl(
  key: string | null,
  status: string | null,
  projectId: string,
  sourceUrl: string | null = null,
): string | null {
  if (key && status === "ready") {
    return `/api/v1/ads/assets/${key.split("/").at(-1)}?projectId=${encodeURIComponent(projectId)}`;
  }
  return sourceUrl ? allowedAdAssetUrl(sourceUrl)?.href ?? null : null;
}

interface CreativeRow {
  creative_identity: string;
  creative_key: string;
  advertiser_key: string;
  advertiser_name: string | null;
  advertiser_domain: string | null;
  relationship: "owned" | "competitor" | "untracked";
  title: string | null;
  snippet: string | null;
  canonical_url: string | null;
  destination_domain: string | null;
  image_asset_key: string | null;
  image_asset_status: string | null;
  image_source_url: string | null;
  favicon_asset_key: string | null;
  favicon_asset_status: string | null;
  favicon_source_url: string | null;
  appearances: number;
  first_seen: string;
  latest_seen: string;
  average_position: number | null;
}

function serializeCreative(row: CreativeRow, projectId: string) {
  const imageFallbackUrl = row.image_source_url
    ? allowedAdAssetUrl(row.image_source_url)?.href ?? null
    : null;
  const faviconFallbackUrl = row.favicon_source_url
    ? allowedAdAssetUrl(row.favicon_source_url)?.href ?? null
    : null;
  return {
    creativeKey: row.creative_key,
    advertiserKey: row.advertiser_key,
    advertiserName: row.advertiser_name ?? row.advertiser_domain ?? "Unknown advertiser",
    advertiserDomain: row.advertiser_domain,
    relationship: row.relationship,
    title: row.title,
    snippet: row.snippet,
    destinationUrl: row.canonical_url,
    destinationDomain: row.destination_domain,
    imageUrl: assetUrl(row.image_asset_key, row.image_asset_status, projectId, row.image_source_url),
    imageFallbackUrl,
    faviconUrl: assetUrl(row.favicon_asset_key, row.favicon_asset_status, projectId, row.favicon_source_url),
    faviconFallbackUrl,
    appearances: Number(row.appearances),
    firstSeen: row.first_seen,
    latestSeen: row.latest_seen,
    averagePosition: row.average_position === null ? null : Number(row.average_position),
  };
}

export const adsRoutes = new Hono<AppEnv>();

adsRoutes.get(
  "/analytics/ads",
  zValidator("query", AdsQuerySchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const filtered = filters(input);
    const completed = completedFilters(input);
    const fromSql = `
      FROM analytics_ad_occurrences ad
      JOIN tracked_queries query ON query.id = ad.tracked_query_id
      LEFT JOIN ad_assets image ON image.source_url = ad.image_source_url
      LEFT JOIN ad_assets favicon ON favicon.source_url = ad.favicon_source_url
      WHERE ${filtered.where}`;
    const [summary, completedRuns, trends, completedTrends, advertisers, creatives, state] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT COUNT(*) AS appearances, COUNT(DISTINCT ad.snapshot_id) AS ad_snapshots,
          COUNT(DISTINCT ad.advertiser_identity) AS advertisers,
          COUNT(DISTINCT ad.creative_identity) AS creatives ${fromSql}`,
      ).bind(...filtered.bindings).first<{
        appearances: number; ad_snapshots: number; advertisers: number; creatives: number;
      }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(fact.ads_count), 0) AS ad_appearances,
          COUNT(DISTINCT CASE WHEN fact.ads_count > 0 THEN fact.snapshot_id END) AS ad_snapshots
         FROM analytics_snapshot_facts fact
         JOIN tracked_queries query ON query.id = fact.tracked_query_id
         WHERE ${completed.where}`,
      ).bind(...completed.bindings).first<{
        count: number; ad_appearances: number; ad_snapshots: number;
      }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT substr(ad.captured_at, 1, 10) AS date,
          COUNT(*) AS appearances, COUNT(DISTINCT ad.snapshot_id) AS ad_snapshots
         ${fromSql} GROUP BY substr(ad.captured_at, 1, 10) ORDER BY date`,
      ).bind(...filtered.bindings).all<{
        date: string; appearances: number; ad_snapshots: number;
      }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT substr(fact.captured_at, 1, 10) AS date, COUNT(*) AS completed,
          COALESCE(SUM(fact.ads_count), 0) AS ad_appearances,
          COUNT(DISTINCT CASE WHEN fact.ads_count > 0 THEN fact.snapshot_id END) AS ad_snapshots
         FROM analytics_snapshot_facts fact
         JOIN tracked_queries query ON query.id = fact.tracked_query_id
         WHERE ${completed.where}
         GROUP BY substr(fact.captured_at, 1, 10) ORDER BY date`,
      ).bind(...completed.bindings).all<{
        date: string; completed: number; ad_appearances: number; ad_snapshots: number;
      }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT ad.advertiser_identity, ad.advertiser_key,
          MAX(COALESCE(ad.advertiser_name, ad.advertiser_domain)) AS advertiser_name,
          MAX(ad.advertiser_domain) AS advertiser_domain,
          MAX(ad.relationship) AS relationship,
          COUNT(*) AS appearances, COUNT(DISTINCT ad.snapshot_id) AS snapshots,
          COUNT(DISTINCT ad.tracked_query_id) AS prompts,
          COUNT(DISTINCT ad.creative_identity) AS creatives,
          MIN(ad.captured_at) AS first_seen, MAX(ad.captured_at) AS latest_seen,
          MAX(favicon.asset_key) AS favicon_asset_key,
          MAX(favicon.status) AS favicon_asset_status,
          MAX(ad.favicon_source_url) AS favicon_source_url
         ${fromSql}
         GROUP BY ad.advertiser_identity, ad.advertiser_key
         ORDER BY appearances DESC, latest_seen DESC LIMIT 100`,
      ).bind(...filtered.bindings).all<Record<string, string | number | null>>(),
      c.env.CONTROL_DB.prepare(
        `SELECT ad.creative_identity, ad.creative_key, ad.advertiser_key,
          MAX(ad.advertiser_name) AS advertiser_name,
          MAX(ad.advertiser_domain) AS advertiser_domain,
          MAX(ad.relationship) AS relationship, MAX(ad.title) AS title,
          MAX(ad.snippet) AS snippet, MAX(ad.canonical_url) AS canonical_url,
          MAX(ad.destination_domain) AS destination_domain,
          MAX(image.asset_key) AS image_asset_key,
          MAX(image.status) AS image_asset_status,
          MAX(ad.image_source_url) AS image_source_url,
          MAX(favicon.asset_key) AS favicon_asset_key,
          MAX(favicon.status) AS favicon_asset_status,
          MAX(ad.favicon_source_url) AS favicon_source_url,
          COUNT(*) AS appearances, MIN(ad.captured_at) AS first_seen,
          MAX(ad.captured_at) AS latest_seen, AVG(ad.rank_absolute) AS average_position
         ${fromSql}
         GROUP BY ad.creative_identity, ad.creative_key, ad.advertiser_key
         ORDER BY latest_seen DESC, appearances DESC LIMIT 24`,
      ).bind(...filtered.bindings).all<CreativeRow>(),
      c.env.CONTROL_DB.prepare(
        "SELECT status FROM analytics_read_model_projects WHERE project_id = ? AND schema_version = 4",
      ).bind(input.projectId).first<{ status: string }>(),
    ]);
    const canUseSnapshotTotals = !input.search && !input.relationship;
    const indexedAppearances = Number(summary?.appearances ?? 0);
    const snapshotAppearances = Number(completedRuns?.ad_appearances ?? 0);
    const totalAppearances = canUseSnapshotTotals
      ? Math.max(indexedAppearances, snapshotAppearances)
      : indexedAppearances;
    const indexedSnapshots = Number(summary?.ad_snapshots ?? 0);
    const snapshotAdSnapshots = Number(completedRuns?.ad_snapshots ?? 0);
    const totalAdSnapshots = canUseSnapshotTotals
      ? Math.max(indexedSnapshots, snapshotAdSnapshots)
      : indexedSnapshots;
    const completedCount = Number(completedRuns?.count ?? 0);
    const byDate = new Map(trends.results.map((row) => [row.date, row]));
    const completedByDate = new Map(completedTrends.results.map((row) => [row.date, row]));
    const trend = [];
    for (let cursor = new Date(`${filtered.range.from}T00:00:00.000Z`);
      cursor <= new Date(`${filtered.range.to}T00:00:00.000Z`);
      cursor = new Date(cursor.getTime() + 86_400_000)) {
      const date = cursor.toISOString().slice(0, 10);
      const row = byDate.get(date);
      const completedRow = completedByDate.get(date);
      const dailyCompleted = Number(completedRow?.completed ?? 0);
      const dailyAppearances = canUseSnapshotTotals
        ? Math.max(Number(row?.appearances ?? 0), Number(completedRow?.ad_appearances ?? 0))
        : Number(row?.appearances ?? 0);
      const dailyAdSnapshots = canUseSnapshotTotals
        ? Math.max(Number(row?.ad_snapshots ?? 0), Number(completedRow?.ad_snapshots ?? 0))
        : Number(row?.ad_snapshots ?? 0);
      trend.push({
        date,
        appearances: dailyAppearances,
        adSnapshots: dailyAdSnapshots,
        completedResponses: dailyCompleted,
        appearanceRate: dailyCompleted
          ? (dailyAdSnapshots / dailyCompleted) * 100
          : 0,
      });
    }
    return c.json({ data: {
      period: input.period,
      indexing: state?.status !== "ready" || snapshotAppearances > indexedAppearances,
      summary: {
        appearanceRate: completedCount
          ? (totalAdSnapshots / completedCount) * 100
          : 0,
        appearances: totalAppearances,
        activeAdvertisers: Number(summary?.advertisers ?? 0),
        uniqueCreatives: Number(summary?.creatives ?? 0),
        completedResponses: completedCount,
      },
      trend,
      advertisers: advertisers.results.map((row) => ({
        advertiserKey: String(row.advertiser_key),
        name: String(row.advertiser_name ?? row.advertiser_domain ?? "Unknown advertiser"),
        domain: row.advertiser_domain,
        relationship: row.relationship,
        appearances: Number(row.appearances),
        adShare: totalAppearances ? (Number(row.appearances) / totalAppearances) * 100 : 0,
        snapshots: Number(row.snapshots),
        prompts: Number(row.prompts),
        creatives: Number(row.creatives),
        firstSeen: row.first_seen,
        latestSeen: row.latest_seen,
        faviconUrl: assetUrl(
          row.favicon_asset_key === null ? null : String(row.favicon_asset_key),
          row.favicon_asset_status === null ? null : String(row.favicon_asset_status),
          input.projectId,
          row.favicon_source_url === null ? null : String(row.favicon_source_url),
        ),
      })),
      creatives: creatives.results.map((row) => serializeCreative(row, input.projectId)),
    }});
  },
);

adsRoutes.get(
  "/analytics/ads/:advertiserKey",
  zValidator("param", AdvertiserParamSchema),
  zValidator("query", AdsQuerySchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    const identity = decodeAdKey(c.req.valid("param").advertiserKey);
    if (!identity) throw new ApiError(404, "advertiser_not_found", "Advertiser not found.");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const filtered = filters(input, identity);
    const fromSql = `
      FROM analytics_ad_occurrences ad
      JOIN tracked_queries query ON query.id = ad.tracked_query_id
      LEFT JOIN ad_assets image ON image.source_url = ad.image_source_url
      LEFT JOIN ad_assets favicon ON favicon.source_url = ad.favicon_source_url
      WHERE ${filtered.where}`;
    const [summary, trends, creatives, prompts] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT MAX(ad.advertiser_name) AS advertiser_name,
          MAX(ad.advertiser_domain) AS advertiser_domain,
          MAX(ad.advertiser_canonical_url) AS advertiser_url,
          MAX(ad.relationship) AS relationship, COUNT(*) AS appearances,
          COUNT(DISTINCT ad.snapshot_id) AS snapshots,
          COUNT(DISTINCT ad.tracked_query_id) AS prompts,
          COUNT(DISTINCT ad.creative_identity) AS creatives,
          MIN(ad.captured_at) AS first_seen, MAX(ad.captured_at) AS latest_seen,
          MAX(favicon.asset_key) AS favicon_asset_key,
          MAX(favicon.status) AS favicon_asset_status,
          MAX(ad.favicon_source_url) AS favicon_source_url ${fromSql}`,
      ).bind(...filtered.bindings).first<Record<string, string | number | null>>(),
      c.env.CONTROL_DB.prepare(
        `SELECT substr(ad.captured_at, 1, 10) AS date, COUNT(*) AS appearances,
          COUNT(DISTINCT ad.snapshot_id) AS snapshots ${fromSql}
         GROUP BY substr(ad.captured_at, 1, 10) ORDER BY date`,
      ).bind(...filtered.bindings).all<Record<string, string | number>>(),
      c.env.CONTROL_DB.prepare(
        `SELECT ad.creative_identity, ad.creative_key, ad.advertiser_key,
          MAX(ad.advertiser_name) AS advertiser_name,
          MAX(ad.advertiser_domain) AS advertiser_domain,
          MAX(ad.relationship) AS relationship, MAX(ad.title) AS title,
          MAX(ad.snippet) AS snippet, MAX(ad.canonical_url) AS canonical_url,
          MAX(ad.destination_domain) AS destination_domain,
          MAX(image.asset_key) AS image_asset_key,
          MAX(image.status) AS image_asset_status,
          MAX(ad.image_source_url) AS image_source_url,
          MAX(favicon.asset_key) AS favicon_asset_key,
          MAX(favicon.status) AS favicon_asset_status,
          MAX(ad.favicon_source_url) AS favicon_source_url,
          COUNT(*) AS appearances, MIN(ad.captured_at) AS first_seen,
          MAX(ad.captured_at) AS latest_seen, AVG(ad.rank_absolute) AS average_position
         ${fromSql}
         GROUP BY ad.creative_identity, ad.creative_key, ad.advertiser_key
         ORDER BY latest_seen DESC, appearances DESC LIMIT 100`,
      ).bind(...filtered.bindings).all<CreativeRow>(),
      c.env.CONTROL_DB.prepare(
        `SELECT ad.tracked_query_id, MAX(query.query_text) AS query_text,
          MAX(query.location_code) AS location_code,
          MAX(query.language_code) AS language_code,
          COUNT(*) AS appearances, COUNT(DISTINCT ad.snapshot_id) AS snapshots,
          MAX(ad.captured_at) AS latest_seen,
          (SELECT latest.snapshot_id FROM analytics_ad_occurrences latest
           WHERE latest.project_id = ad.project_id
             AND latest.tracked_query_id = ad.tracked_query_id
             AND latest.advertiser_identity = ad.advertiser_identity
           ORDER BY latest.captured_at DESC LIMIT 1) AS latest_snapshot_id
         ${fromSql}
         GROUP BY ad.tracked_query_id, ad.project_id, ad.advertiser_identity
         ORDER BY latest_seen DESC LIMIT 100`,
      ).bind(...filtered.bindings).all<Record<string, string | number>>(),
    ]);
    if (!summary || Number(summary.appearances ?? 0) === 0) {
      throw new ApiError(404, "advertiser_not_found", "Advertiser not found.");
    }
    const promptIds = prompts.results.map((row) => String(row.tracked_query_id));
    const tagRows = promptIds.length
      ? await c.env.CONTROL_DB.prepare(
          `SELECT assignment.tracked_query_id, tag.id, tag.name
           FROM tracked_query_tags assignment
           JOIN prompt_tags tag ON tag.id = assignment.tag_id
           WHERE assignment.tracked_query_id IN (${promptIds.map(() => "?").join(",")})
           ORDER BY tag.name`,
        ).bind(...promptIds).all<{ tracked_query_id: string; id: string; name: string }>()
      : { results: [] as Array<{ tracked_query_id: string; id: string; name: string }> };
    const tags = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of tagRows.results) {
      tags.set(row.tracked_query_id, [
        ...(tags.get(row.tracked_query_id) ?? []),
        { id: row.id, name: row.name },
      ]);
    }
    return c.json({ data: {
      advertiser: {
        advertiserKey: c.req.valid("param").advertiserKey,
        name: summary.advertiser_name ?? summary.advertiser_domain ?? "Unknown advertiser",
        domain: summary.advertiser_domain,
        website: summary.advertiser_url,
        relationship: summary.relationship,
        faviconUrl: assetUrl(
          summary.favicon_asset_key === null ? null : String(summary.favicon_asset_key),
          summary.favicon_asset_status === null ? null : String(summary.favicon_asset_status),
          input.projectId,
          summary.favicon_source_url === null ? null : String(summary.favicon_source_url),
        ),
        appearances: Number(summary.appearances),
        snapshots: Number(summary.snapshots),
        prompts: Number(summary.prompts),
        creatives: Number(summary.creatives),
        firstSeen: summary.first_seen,
        latestSeen: summary.latest_seen,
      },
      trend: trends.results.map((row) => ({
        date: row.date,
        appearances: Number(row.appearances),
        snapshots: Number(row.snapshots),
      })),
      creatives: creatives.results.map((row) => serializeCreative(row, input.projectId)),
      prompts: prompts.results.map((row) => ({
        id: row.tracked_query_id,
        query: row.query_text,
        locationCode: Number(row.location_code),
        languageCode: row.language_code,
        appearances: Number(row.appearances),
        snapshots: Number(row.snapshots),
        latestSeen: row.latest_seen,
        latestSnapshotId: row.latest_snapshot_id,
        tags: tags.get(String(row.tracked_query_id)) ?? [],
      })),
    }});
  },
);

adsRoutes.get(
  "/ads/assets/:key",
  zValidator("param", AssetParamSchema),
  zValidator("query", AssetQuerySchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId);
    const assetKey = `ads/assets/${c.req.valid("param").key}`;
    const asset = await c.env.CONTROL_DB.prepare(
      `SELECT asset.asset_key, asset.content_type
       FROM ad_assets asset
       WHERE asset.asset_key = ? AND asset.status = 'ready'
         AND EXISTS (
           SELECT 1 FROM analytics_ad_occurrences occurrence
           WHERE occurrence.project_id = ?
             AND (occurrence.image_source_url = asset.source_url
               OR occurrence.favicon_source_url = asset.source_url)
         )`,
    ).bind(assetKey, input.projectId).first<{
      asset_key: string; content_type: string | null;
    }>();
    if (!asset) throw new ApiError(404, "ad_asset_not_found", "Ad asset not found.");
    const object = await c.env.EVIDENCE_BUCKET.get(asset.asset_key);
    if (!object) throw new ApiError(404, "ad_asset_not_found", "Ad asset not found.");
    const headers = new Headers({
      "content-type": asset.content_type ?? "application/octet-stream",
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    });
    return new Response(object.body, { headers });
  },
);
