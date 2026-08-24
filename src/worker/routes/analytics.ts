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
import { writeAudit } from "../lib/audit";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { matchedBrandTerms, normalizeHostname } from "../lib/domain";
import { allowedAdAssetUrl, normalizeAdItem } from "../lib/ads";
import { evidenceResponseHeaders } from "../lib/evidence";
import {
  analyticsReadModelSupports,
  RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION,
  type AnalyticsReadModelState,
} from "../lib/analytics-read-model";
import { getShard } from "../lib/shards";
import { retryD1Read } from "../lib/d1";
import { ApiError, exclusiveDateEnd, jsonParse } from "../lib/http";
import {
  billingDateRange,
  aggregateBrandMentionDays,
  buildBillingReport,
  buildBrandComparison,
  mergeBillingReports,
  positionDistribution,
  productAnalyticsComparisonDateRange,
  productAnalyticsDateRange,
  productCapturePositions,
  productIdentity,
  productIdentityFromKey,
  productKey,
  normalizeRelatedQuery,
  relatedQueryFromKey,
  relatedQueryKey,
  summarizeProductPrices,
  summarizeProductPerformance,
  type BillingDailyRow,
  type SourceBrandMentionDailyRow,
  type TrackedBrandReportRow,
} from "../lib/reporting";
import {
  buildChartAnnotations,
  type ProjectEventRow,
} from "../../shared/project-event-helpers";
import { projectTrackingSources } from "../lib/tracking-sources";
import {
  googleProductIdentifiers,
  summarizeMarketPrices,
} from "../lib/product-enrichment";
import {
  ensureProductEnrichmentTarget,
  requestTargetRefresh,
} from "../automation/product-enrichment";
import {
  ProductEnrichmentPreferenceSchema,
  ProductEnrichmentRequestSchema,
  TrackingSourceSchema,
  type TrackingSource,
} from "../../shared/contracts";

const DateRangeSchema = z.object({
  projectId: z.string().uuid(),
  source: TrackingSourceSchema.default("chatgpt"),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
const OverviewDateRangeSchema = DateRangeSchema.extend({
  source: z.union([TrackingSourceSchema, z.literal("all")]).default("chatgpt"),
});
const PaginatedDateRangeSchema = DateRangeSchema.extend({
  cursor: z.string().max(4096).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
const TrackedBrandAnalyticsSchema = DateRangeSchema.extend({
  search: z.string().trim().max(200).optional(),
  kind: z.enum(["owned", "competitor"]).optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const EntityAnalyticsSchema = DateRangeSchema.extend({
  search: z.string().trim().max(200).optional(),
  group: z.enum(["brands", "companies", "places", "other"]).optional(),
  status: z.enum(["candidate", "ignored", "all"]).default("candidate"),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
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
  source: TrackingSourceSchema.default("chatgpt"),
  search: z.string().trim().max(200).optional(),
  locationCode: z.coerce.number().int().optional(),
  languageCode: z.string().trim().max(12).optional(),
  tagIds: PromptTagIdsSchema.optional(),
  cursor: z.string().max(4096).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const ShoppingAnalyticsSchema = PaginatedDateRangeSchema.extend({
  search: z.string().trim().max(200).optional(),
  locationCode: z.coerce.number().int().optional(),
  tagIds: PromptTagIdsSchema.optional(),
  enrichment: z.enum(["enriched", "not_enriched"]).optional(),
});
const BillingQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  period: z.enum(["30d", "month"]).default("30d"),
});
const ShoppingProductParamSchema = z.object({
  productKey: z.string().trim().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/u),
});
const ShoppingProductDetailSchema = z.object({
  projectId: z.string().uuid(),
  source: TrackingSourceSchema.default("chatgpt"),
  period: z.enum(["7d", "30d", "90d", "365d"]).default("30d"),
  cursor: z.string().max(4096).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  marketLocationCode: z.coerce.number().int().optional(),
  marketLanguageCode: z.string().trim().min(1).max(20).optional(),
});
const RelatedQueryPeriodSchema = z.enum(["7d", "30d", "90d", "365d"]);
const RelatedQueriesSchema = z.object({
  projectId: z.string().uuid(),
  source: TrackingSourceSchema.default("chatgpt"),
  period: RelatedQueryPeriodSchema.default("30d"),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const RelatedQueryParamSchema = z.object({
  queryKey: z.string().trim().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/u),
});
const RelatedQueryDetailSchema = z.object({
  projectId: z.string().uuid(),
  source: TrackingSourceSchema.default("chatgpt"),
  period: RelatedQueryPeriodSchema.default("30d"),
});
const RelatedQueryPageSchema = RelatedQueryDetailSchema.extend({
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
const RelatedQuerySourcesSchema = RelatedQueryPageSchema.extend({
  kind: z.enum(["cited", "retrieved"]),
});

function chunks<T>(values: T[], size = 75): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

interface VerifiedBrandMentions {
  byBrand: Map<string, number>;
  byDate: Map<string, number>;
  byQuery: Map<string, number>;
  bySnapshot: Map<string, Set<string>>;
  total: number;
}

function mergeVerifiedBrandMentions(
  reports: VerifiedBrandMentions[],
): VerifiedBrandMentions {
  const merged: VerifiedBrandMentions = {
    byBrand: new Map(),
    byDate: new Map(),
    byQuery: new Map(),
    bySnapshot: new Map(),
    total: 0,
  };
  for (const report of reports) {
    merged.total += report.total;
    for (const [key, value] of report.byBrand) {
      merged.byBrand.set(key, (merged.byBrand.get(key) ?? 0) + value);
    }
    for (const [key, value] of report.byDate) {
      merged.byDate.set(key, (merged.byDate.get(key) ?? 0) + value);
    }
    for (const [key, value] of report.byQuery) {
      merged.byQuery.set(key, (merged.byQuery.get(key) ?? 0) + value);
    }
    for (const [key, value] of report.bySnapshot) {
      merged.bySnapshot.set(key, new Set(value));
    }
  }
  return merged;
}

async function verifyStoredBrandMentions(
  env: Env,
  projectId: string,
  from: string,
  to: string,
  extraSnapshotIds: string[] = [],
  ownedOnly = true,
  source: TrackingSource = "chatgpt",
): Promise<VerifiedBrandMentions> {
  const uniqueExtraIds = [...new Set(extraSnapshotIds)];
  const candidateCondition = ownedOnly
    ? "brand_mentioned_runs > 0"
    : "brands_json <> '[]'";
  const contributionQueries = [
    env.CONTROL_DB.prepare(
      `SELECT snapshot_id, tracked_query_id, metric_date
       FROM metric_contributions
       WHERE project_id = ?
         AND tracking_source = ?
         AND ${candidateCondition}
         AND metric_date BETWEEN ? AND ?`,
    )
      .bind(projectId, source, from, to)
      .all<{
        snapshot_id: string;
        tracked_query_id: string;
        metric_date: string;
      }>(),
    ...chunks(uniqueExtraIds).map((ids) =>
      env.CONTROL_DB.prepare(
        `SELECT snapshot_id, tracked_query_id, metric_date
         FROM metric_contributions
         WHERE project_id = ?
           AND tracking_source = ?
           AND ${candidateCondition}
           AND snapshot_id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(projectId, source, ...ids)
        .all<{
          snapshot_id: string;
          tracked_query_id: string;
          metric_date: string;
        }>(),
    ),
  ];
  const [brands, contributionResults] = await Promise.all([
    env.CONTROL_DB.prepare(
      `SELECT id, name, aliases_json
       FROM tracked_brands
       WHERE project_id = ?${ownedOnly ? " AND kind = 'owned'" : ""}`,
    )
      .bind(projectId)
      .all<{ id: string; name: string; aliases_json: string }>(),
    Promise.all(contributionQueries),
  ]);
  const contributionRows = contributionResults.flatMap(
    (result) => result.results,
  );
  const empty: VerifiedBrandMentions = {
    byBrand: new Map(),
    byDate: new Map(),
    byQuery: new Map(),
    bySnapshot: new Map(),
    total: 0,
  };
  if (!brands.results.length || !contributionRows.length) return empty;

  const contributionBySnapshot = new Map(
    contributionRows.map((contribution) => [
      contribution.snapshot_id,
      contribution,
    ]),
  );
  const snapshotIds = [...contributionBySnapshot.keys()];
  const indexes = await Promise.all(
    chunks(snapshotIds).map((ids) =>
      env.CONTROL_DB.prepare(
        `SELECT id, shard_id
         FROM snapshot_index
         WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(...ids)
        .all<{ id: string; shard_id: number }>(),
    ),
  );
  const grouped = new Map<number, string[]>();
  for (const index of indexes.flatMap((result) => result.results)) {
    grouped.set(index.shard_id, [
      ...(grouped.get(index.shard_id) ?? []),
      index.id,
    ]);
  }
  const snapshots = await Promise.all(
    [...grouped.entries()].flatMap(([shardId, ids]) =>
      chunks(ids).map((snapshotChunk) =>
        retryD1Read(() =>
          getShard(env, shardId)
            .prepare(
              `SELECT id, answer_markdown
               FROM snapshots
               WHERE id IN (${snapshotChunk.map(() => "?").join(",")})`,
            )
            .bind(...snapshotChunk)
            .all<{ id: string; answer_markdown: string | null }>(),
        ),
      ),
    ),
  );

  const byDate = new Map<string, number>();
  const byQuery = new Map<string, number>();
  const bySnapshot = new Map<string, Set<string>>();
  const byBrand = new Map<string, number>();
  let total = 0;
  for (const snapshot of snapshots.flatMap((result) => result.results)) {
    const matchedIds = new Set(
      brands.results
        .filter((brand) =>
          matchedBrandTerms(
            snapshot.answer_markdown ?? "",
            brand.name,
            jsonParse<string[]>(brand.aliases_json, []),
          ).length > 0,
        )
        .map((brand) => brand.id),
    );
    bySnapshot.set(snapshot.id, matchedIds);
    if (!matchedIds.size) continue;
    const contribution = contributionBySnapshot.get(snapshot.id);
    if (!contribution) continue;
    total += 1;
    byDate.set(
      contribution.metric_date,
      (byDate.get(contribution.metric_date) ?? 0) + 1,
    );
    byQuery.set(
      contribution.tracked_query_id,
      (byQuery.get(contribution.tracked_query_id) ?? 0) + 1,
    );
    for (const brandId of matchedIds) {
      byBrand.set(brandId, (byBrand.get(brandId) ?? 0) + 1);
    }
  }
  return { byBrand, byDate, byQuery, bySnapshot, total };
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

async function loadReadModelShoppingProductOccurrences(
  env: Env,
  projectId: string,
  startTimestamp: string,
  endExclusiveTimestamp: string,
  identity?: string,
  source: TrackingSource = "chatgpt",
): Promise<ShoppingProductOccurrence[]> {
  const identityClause = identity ? " AND p.product_identity = ?" : "";
  const bindings = identity
    ? [projectId, source, startTimestamp, endExclusiveTimestamp, identity]
    : [projectId, source, startTimestamp, endExclusiveTimestamp];
  const result = await env.CONTROL_DB.prepare(
    `SELECT
      p.product_row_id AS id,
      p.snapshot_id,
      p.tracked_query_id,
      q.query_text AS keyword,
      q.location_code,
      q.language_code,
      p.ordinal,
      p.rank_absolute,
      p.provider_product_id,
      p.merchants,
      p.title,
      p.price,
      p.currency,
      p.tag,
      p.raw_url,
      p.canonical_url,
      p.registrable_domain,
      p.rating_value,
      p.rating_votes_count,
      p.rating_max,
      p.images_json,
      p.product_ids_json,
      p.captured_at
     FROM analytics_product_occurrences p
     JOIN tracked_queries q ON q.id = p.tracked_query_id
     JOIN analytics_snapshot_facts fact ON fact.snapshot_id = p.snapshot_id
     WHERE p.project_id = ?
       AND fact.tracking_source = ?
       AND p.captured_at >= ?
       AND p.captured_at < ?${identityClause}
     ORDER BY p.captured_at DESC, p.product_row_id DESC`,
  )
    .bind(...bindings)
    .all<ShoppingProductOccurrence>();
  return result.results;
}

async function loadReadModelCoFeaturedProductOccurrences(
  env: Env,
  projectId: string,
  startTimestamp: string,
  endExclusiveTimestamp: string,
  identity: string,
  source: TrackingSource = "chatgpt",
): Promise<ShoppingProductOccurrence[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT
      product.product_row_id AS id,
      product.snapshot_id,
      product.tracked_query_id,
      query.query_text AS keyword,
      query.location_code,
      query.language_code,
      product.ordinal,
      product.rank_absolute,
      product.provider_product_id,
      product.merchants,
      product.title,
      product.price,
      product.currency,
      product.tag,
      product.raw_url,
      product.canonical_url,
      product.registrable_domain,
      product.rating_value,
      product.rating_votes_count,
      product.rating_max,
      product.images_json,
      product.product_ids_json,
      product.captured_at
     FROM analytics_product_occurrences product
     JOIN tracked_queries query ON query.id = product.tracked_query_id
     JOIN analytics_snapshot_facts fact ON fact.snapshot_id = product.snapshot_id
     WHERE product.project_id = ?
       AND fact.tracking_source = ?
       AND product.captured_at >= ?
       AND product.captured_at < ?
       AND EXISTS (
         SELECT 1 FROM analytics_product_occurrences target
         WHERE target.project_id = product.project_id
           AND target.snapshot_id = product.snapshot_id
           AND target.product_identity = ?
       )
     ORDER BY product.captured_at DESC, product.product_row_id DESC`,
  )
    .bind(
      projectId,
      source,
      startTimestamp,
      endExclusiveTimestamp,
      identity,
    )
    .all<ShoppingProductOccurrence>();
  return result.results;
}

type CitationSourceOccurrence = {
  snapshot_id: string;
  tracked_query_id: string;
  keyword: string;
  location_code: number;
  language_code: string;
  url: string | null;
  title: string | null;
  source_name: string | null;
  captured_at: string;
};

async function loadReadModelCitationOccurrences(
  env: Env,
  projectId: string,
  domain: string,
  startTimestamp: string,
  endExclusiveTimestamp: string,
  source: TrackingSource = "chatgpt",
): Promise<CitationSourceOccurrence[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT
      citation.snapshot_id,
      citation.tracked_query_id,
      query.query_text AS keyword,
      query.location_code,
      query.language_code,
      COALESCE(citation.canonical_url, citation.raw_url) AS url,
      citation.title,
      citation.source_name,
      citation.captured_at
     FROM analytics_citation_occurrences citation
     JOIN tracked_queries query ON query.id = citation.tracked_query_id
     JOIN analytics_snapshot_facts fact ON fact.snapshot_id = citation.snapshot_id
     WHERE citation.project_id = ?
       AND fact.tracking_source = ?
       AND citation.registrable_domain = ?
       AND citation.captured_at >= ?
       AND citation.captured_at < ?
     ORDER BY citation.captured_at DESC, citation.snapshot_id, citation.ordinal`,
  )
    .bind(projectId, source, domain, startTimestamp, endExclusiveTimestamp)
    .all<CitationSourceOccurrence>();
  return result.results;
}

function serializedShoppingProduct(
  product: ShoppingProductOccurrence & {
    appearances?: number;
    enriched?: boolean;
  },
) {
  return {
    ...product,
    productKey: productKey(product),
    images: jsonParse<string[]>(product.images_json, []),
    product_ids: jsonParse<unknown[]>(product.product_ids_json, []),
    latestSeen: product.captured_at,
  };
}

export function buildProductCompetition(
  identity: string,
  targetOccurrences: ShoppingProductOccurrence[],
  coFeaturedOccurrences: ShoppingProductOccurrence[],
) {
  const targetPositions = productCapturePositions(targetOccurrences);
  const groups = new Map<string, ShoppingProductOccurrence[]>();
  for (const occurrence of coFeaturedOccurrences) {
    if (!targetPositions.has(occurrence.snapshot_id)) continue;
    const occurrenceIdentity = productIdentity(occurrence);
    if (occurrenceIdentity === identity) continue;
    groups.set(occurrenceIdentity, [
      ...(groups.get(occurrenceIdentity) ?? []),
      occurrence,
    ]);
  }
  const coFeatured = [...groups.entries()]
    .map(([competitorIdentity, occurrences]) => {
      const ordered = [...occurrences].sort(
        (left, right) =>
          right.captured_at.localeCompare(left.captured_at) ||
          right.id.localeCompare(left.id),
      );
      const positions = [...productCapturePositions(ordered).values()];
      const winningCaptures = positions.filter((position) => position === 1).length;
      return {
        identity: competitorIdentity,
        product: serializedShoppingProduct({
          ...ordered[0]!,
          appearances: ordered.length,
        }),
        appearances: ordered.length,
        coFeaturedCaptures: positions.length,
        coFeatureRate: targetPositions.size
          ? (positions.length / targetPositions.size) * 100
          : 0,
        winningCaptures,
        winRate: positions.length
          ? (winningCaptures / positions.length) * 100
          : 0,
        averagePosition: positions.length
          ? positions.reduce((sum, position) => sum + position, 0) /
            positions.length
          : null,
        distribution: positionDistribution(positions),
      };
    })
    .sort(
      (left, right) =>
        right.coFeaturedCaptures - left.coFeaturedCaptures ||
        (left.averagePosition ?? Number.POSITIVE_INFINITY) -
          (right.averagePosition ?? Number.POSITIVE_INFINITY) ||
        right.product.latestSeen.localeCompare(left.product.latestSeen) ||
        left.identity.localeCompare(right.identity),
    )
    .slice(0, 8)
    .map((competitor) => ({
      product: competitor.product,
      appearances: competitor.appearances,
      coFeaturedCaptures: competitor.coFeaturedCaptures,
      coFeatureRate: competitor.coFeatureRate,
      winningCaptures: competitor.winningCaptures,
      winRate: competitor.winRate,
      averagePosition: competitor.averagePosition,
      distribution: competitor.distribution,
    }));
  return {
    current: positionDistribution(targetPositions.values()),
    coFeatured,
  };
}

interface MarketTargetRow {
  id: string;
  location_code: number;
  language_code: string;
  status: string;
  current_job_id: string | null;
  latest_snapshot_id: string | null;
  last_success_at: string | null;
  next_refresh_at: string | null;
  last_error: string | null;
  google_product_id: string | null;
  data_docid: string | null;
  gid: string | null;
}

interface MarketSnapshotRow {
  id: string;
  captured_at: string;
  se_domain: string | null;
  check_url: string | null;
  product_url: string | null;
  title: string | null;
  description: string | null;
  tags_json: string;
  images_json: string;
  features_json: string;
  specifications_json: string;
  variations_json: string;
  rating_value: number | null;
  rating_votes_count: number | null;
  rating_max: number | null;
  seller_reviews_count: number | null;
  seller_count: number;
  in_stock_count: number;
}

interface MarketOfferRow {
  id: string;
  snapshot_id: string;
  ordinal: number;
  seller_name: string | null;
  seller_url: string | null;
  seller_domain: string | null;
  seller_rating_value: number | null;
  seller_rating_votes_count: number | null;
  seller_rating_max: number | null;
  seller_reviews_count: number | null;
  price_current: number | null;
  price_regular: number | null;
  price_max: number | null;
  currency: string | null;
  is_price_range: number;
  displayed_price: string | null;
  delivery_message: string | null;
  availability: string | null;
  is_owned: number;
}

async function loadProductMarket(
  env: Env,
  projectId: string,
  identity: string,
  dates: ReturnType<typeof productAnalyticsDateRange>,
  occurrences: ShoppingProductOccurrence[],
  requestedLocale?: { locationCode?: number; languageCode?: string },
) {
  const [project, preference, targets] = await Promise.all([
    env.CONTROL_DB.prepare(
      `SELECT product_enrichment_enabled
       FROM projects WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(projectId)
      .first<{
        product_enrichment_enabled: number;
      }>(),
    env.CONTROL_DB.prepare(
      `SELECT automatic_refresh_enabled FROM product_enrichment_preferences
       WHERE project_id = ? AND product_identity = ?`,
    )
      .bind(projectId, identity)
      .first<{ automatic_refresh_enabled: number }>(),
    env.CONTROL_DB.prepare(
      `SELECT id, location_code, language_code, status, current_job_id,
        latest_snapshot_id, last_success_at, next_refresh_at, last_error,
        google_product_id, data_docid, gid
       FROM product_enrichment_targets
       WHERE project_id = ? AND product_identity = ?
       ORDER BY last_seen_at DESC, updated_at DESC`,
    )
      .bind(projectId, identity)
      .all<MarketTargetRow>(),
  ]);
  const localeMap = new Map<string, { locationCode: number; languageCode: string }>();
  for (const occurrence of occurrences) {
    localeMap.set(`${occurrence.location_code}:${occurrence.language_code}`, {
      locationCode: occurrence.location_code,
      languageCode: occurrence.language_code,
    });
  }
  for (const target of targets.results) {
    localeMap.set(`${target.location_code}:${target.language_code}`, {
      locationCode: target.location_code,
      languageCode: target.language_code,
    });
  }
  const fallback = occurrences[0]
    ? { locationCode: occurrences[0].location_code, languageCode: occurrences[0].language_code }
    : [...localeMap.values()][0];
  const requestedKey = requestedLocale?.locationCode !== undefined && requestedLocale.languageCode
    ? `${requestedLocale.locationCode}:${requestedLocale.languageCode}`
    : null;
  const selectedLocale = (requestedKey && localeMap.get(requestedKey)) || fallback || null;
  const target = selectedLocale
    ? targets.results.find(
        (candidate) =>
          candidate.location_code === selectedLocale.locationCode &&
          candidate.language_code === selectedLocale.languageCode,
      ) ?? null
    : null;
  const occurrenceSupportsSelectedLocale = Boolean(selectedLocale && occurrences.some(
    (occurrence) =>
      occurrence.location_code === selectedLocale.locationCode &&
      occurrence.language_code === selectedLocale.languageCode &&
      googleProductIdentifiers(jsonParse<unknown[]>(occurrence.product_ids_json, [])),
  ));
  const enrichmentSupported = Boolean(
    target?.google_product_id || target?.data_docid || target?.gid || occurrenceSupportsSelectedLocale,
  );
  let latestSnapshot: MarketSnapshotRow | null = null;
  let latestOffers: MarketOfferRow[] = [];
  let history: MarketSnapshotRow[] = [];
  let historyOffers: MarketOfferRow[] = [];
  if (target) {
    const [latestResult, historyResult] = await Promise.all([
      target.latest_snapshot_id
        ? env.CONTROL_DB.prepare("SELECT * FROM product_market_snapshots WHERE id = ?")
            .bind(target.latest_snapshot_id)
            .first<MarketSnapshotRow>()
        : Promise.resolve(null),
      env.CONTROL_DB.prepare(
        `SELECT * FROM product_market_snapshots
         WHERE target_id = ? AND captured_at >= ? AND captured_at < ?
         ORDER BY captured_at`,
      )
        .bind(target.id, dates.startTimestamp, dates.endExclusiveTimestamp)
        .all<MarketSnapshotRow>(),
    ]);
    latestSnapshot = latestResult;
    history = historyResult.results;
    const snapshotIds = [...new Set([
      ...(latestSnapshot ? [latestSnapshot.id] : []),
      ...history.map((snapshot) => snapshot.id),
    ])];
    if (snapshotIds.length) {
      const offerResults = await Promise.all(
        chunks(snapshotIds).map((ids) =>
          env.CONTROL_DB.prepare(
            `SELECT * FROM product_market_offers
             WHERE snapshot_id IN (${ids.map(() => "?").join(",")})
             ORDER BY ordinal`,
          )
            .bind(...ids)
            .all<MarketOfferRow>(),
        ),
      );
      historyOffers = offerResults.flatMap((result) => result.results);
      latestOffers = latestSnapshot
        ? historyOffers.filter((offer) => offer.snapshot_id === latestSnapshot?.id)
        : [];
    }
  }
  const latestPrices = summarizeMarketPrices(
    latestOffers.map((offer) => ({ price: offer.price_current, currency: offer.currency })),
  );
  const priceTrend = history.flatMap((snapshot) =>
    summarizeMarketPrices(
      historyOffers
        .filter((offer) => offer.snapshot_id === snapshot.id)
        .map((offer) => ({ price: offer.price_current, currency: offer.currency })),
    ).map((price) => ({ date: snapshot.captured_at.slice(0, 10), ...price })),
  );
  const ownedOffers = latestOffers
    .filter((offer) => offer.is_owned === 1 && offer.price_current !== null)
    .sort((left, right) => (left.price_current ?? 0) - (right.price_current ?? 0));
  const ownedOffer = ownedOffers[0] ?? null;
  const comparableLowest = ownedOffer
    ? latestPrices.find((price) => price.currency === ownedOffer.currency)?.minimum ?? null
    : null;
  return {
    locales: [...localeMap.values()].map((locale) => {
      const localeTarget = targets.results.find(
        (candidate) =>
          candidate.location_code === locale.locationCode &&
          candidate.language_code === locale.languageCode,
      );
      return { ...locale, status: localeTarget?.status ?? "idle" };
    }),
    selectedLocale,
    policy: {
      projectEnabled: project?.product_enrichment_enabled === 1,
      automaticRefreshEnabled: preference?.automatic_refresh_enabled !== 0,
    },
    refresh: {
      targetId: target?.id ?? null,
      status: target?.status ?? "idle",
      pending: Boolean(target?.current_job_id),
      lastCompletedAt: target?.last_success_at ?? null,
      nextEligibleAt: target?.next_refresh_at ?? null,
      lastError: target?.last_error ?? null,
      supported: enrichmentSupported,
    },
    profile: latestSnapshot
      ? {
          title: latestSnapshot.title,
          description: latestSnapshot.description,
          tags: jsonParse<string[]>(latestSnapshot.tags_json, []),
          images: jsonParse<string[]>(latestSnapshot.images_json, []),
          features: jsonParse<string[]>(latestSnapshot.features_json, []),
          specifications: jsonParse<unknown[]>(latestSnapshot.specifications_json, []),
          variations: jsonParse<unknown[]>(latestSnapshot.variations_json, []),
          productUrl: latestSnapshot.product_url ?? latestSnapshot.check_url,
          sourceDomain: latestSnapshot.se_domain,
          capturedAt: latestSnapshot.captured_at,
          rating: {
            value: latestSnapshot.rating_value,
            maximum: latestSnapshot.rating_max,
            reviews: latestSnapshot.rating_votes_count,
          },
        }
      : null,
    summary: latestSnapshot
      ? {
          sellerCount: latestSnapshot.seller_count,
          inStockCount: latestSnapshot.in_stock_count,
          prices: latestPrices,
          ownedOffer: ownedOffer
            ? {
                seller: ownedOffer.seller_name,
                price: ownedOffer.price_current,
                currency: ownedOffer.currency,
                differenceFromLowest:
                  comparableLowest !== null && ownedOffer.price_current !== null
                    ? ownedOffer.price_current - comparableLowest
                    : null,
              }
            : null,
        }
      : null,
    priceTrend,
    offerTrend: history.map((snapshot) => ({
      date: snapshot.captured_at.slice(0, 10),
      sellers: snapshot.seller_count,
      inStock: snapshot.in_stock_count,
    })),
    offers: latestOffers.map((offer) => ({
      id: offer.id,
      seller: offer.seller_name,
      url: offer.seller_url,
      domain: offer.seller_domain,
      rating: offer.seller_rating_value,
      ratingMaximum: offer.seller_rating_max,
      reviews: offer.seller_reviews_count ?? offer.seller_rating_votes_count,
      price: offer.price_current,
      regularPrice: offer.price_regular,
      maximumPrice: offer.price_max,
      currency: offer.currency,
      isPriceRange: offer.is_price_range === 1,
      displayedPrice: offer.displayed_price,
      delivery: offer.delivery_message,
      availability: offer.availability,
      owned: offer.is_owned === 1,
    })),
  };
}

async function latestEnrichmentOccurrence(
  env: Env,
  projectId: string,
  identity: string,
  locationCode: number,
  languageCode: string,
) {
  return env.CONTROL_DB.prepare(
    `SELECT project.workspace_id, product.project_id, product.product_identity,
      product.product_key, product.product_ids_json, query.location_code,
      query.language_code, product.captured_at
     FROM analytics_product_occurrences product
     JOIN tracked_queries query ON query.id = product.tracked_query_id
     JOIN projects project ON project.id = product.project_id
     WHERE product.project_id = ? AND product.product_identity = ?
       AND query.location_code = ? AND query.language_code = ?
     ORDER BY
       CASE WHEN EXISTS (
         SELECT 1
         FROM json_each(product.product_ids_json) identifier
         WHERE NULLIF(TRIM(CAST(json_extract(identifier.value, '$.catalog_id') AS TEXT)), '') IS NOT NULL
            OR NULLIF(TRIM(CAST(json_extract(identifier.value, '$.headline_offer_docid') AS TEXT)), '') IS NOT NULL
            OR NULLIF(TRIM(CAST(json_extract(identifier.value, '$.product_id') AS TEXT)), '') IS NOT NULL
            OR NULLIF(TRIM(CAST(json_extract(identifier.value, '$.gpcid') AS TEXT)), '') IS NOT NULL
       ) THEN 0 ELSE 1 END,
       product.captured_at DESC
     LIMIT 1`,
  )
    .bind(projectId, identity, locationCode, languageCode)
    .first<{
      workspace_id: string;
      project_id: string;
      product_identity: string;
      product_key: string;
      product_ids_json: string;
      location_code: number;
      language_code: string;
      captured_at: string;
    }>();
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
  timing?: AppEnv["Variables"]["timing"],
): Promise<void> {
  const lookup = () =>
    env.CONTROL_DB.prepare(
      "SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND archived_at IS NULL",
    )
      .bind(projectId, workspaceId)
      .all<{ id: string }>();
  const result = timing
    ? await timing.measureD1("project_access", lookup)
    : await lookup();
  const project = result.results[0];
  if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
}

async function requireAnalyticsProjectContext(
  env: Env,
  workspaceId: string,
  projectId: string,
  timing: AppEnv["Variables"]["timing"],
): Promise<AnalyticsReadModelState | null> {
  try {
    const result = await timing.measureD1("project_context", () =>
      env.CONTROL_DB.prepare(
        `SELECT read_model.status, read_model.schema_version
         FROM projects project
         LEFT JOIN analytics_read_model_projects read_model
           ON read_model.project_id = project.id
         WHERE project.id = ? AND project.workspace_id = ?
           AND project.deleted_at IS NULL AND project.archived_at IS NULL
         LIMIT 1`,
      )
        .bind(projectId, workspaceId)
        .all<{ status: string | null; schema_version: number | null }>(),
    );
    const project = result.results[0];
    if (!project) {
      throw new ApiError(404, "project_not_found", "Project not found.");
    }
    return project.status == null || project.schema_version == null
      ? null
      : { status: project.status, schema_version: project.schema_version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("no such table: analytics_read_model_projects")) {
      throw error;
    }
    await assertProjectAccess(env, workspaceId, projectId, timing);
    return null;
  }
}

function relatedQueryRange(period: z.infer<typeof RelatedQueryPeriodSchema>) {
  const dates = productAnalyticsDateRange(period);
  return {
    from: dates.startTimestamp,
    to: dates.endExclusiveTimestamp,
  };
}

interface TrackedRelatedQueryRow {
  id: string;
  query_text: string;
  location_code: number;
  language_code: string;
}

async function trackedRelatedQueries(env: Env, projectId: string) {
  const rows = await env.CONTROL_DB.prepare(
    `SELECT id, query_text, location_code, language_code
     FROM tracked_queries
     WHERE project_id = ? AND deleted_at IS NULL
     ORDER BY created_at, id`,
  )
    .bind(projectId)
    .all<TrackedRelatedQueryRow>();
  const byNormalizedQuery = new Map<string, TrackedRelatedQueryRow>();
  for (const row of rows.results) {
    const normalized = normalizeRelatedQuery(row.query_text);
    if (normalized && !byNormalizedQuery.has(normalized)) {
      byNormalizedQuery.set(normalized, row);
    }
  }
  return byNormalizedQuery;
}

function decodedRelatedQuery(key: string): string {
  const normalized = relatedQueryFromKey(key);
  if (!normalized || normalizeRelatedQuery(normalized) !== normalized) {
    throw new ApiError(404, "related_query_not_found", "Related query not found.");
  }
  return normalized;
}

async function loadReadModelBrandMentions(
  env: Env,
  projectId: string,
  from: string,
  to: string,
  extraSnapshotIds: string[] = [],
  source: TrackingSource = "chatgpt",
): Promise<VerifiedBrandMentions> {
  type FactRow = {
    snapshot_id: string;
    tracked_query_id: string;
    metric_date: string;
    brand_mentioned_runs: number;
    brand_mentions_count: number;
  };
  const queries = [
    env.CONTROL_DB.prepare(
      `SELECT snapshot_id, tracked_query_id, metric_date,
        brand_mentioned_runs, brand_mentions_count
       FROM analytics_snapshot_facts
       WHERE project_id = ? AND tracking_source = ?
         AND metric_date BETWEEN ? AND ?`,
    )
      .bind(projectId, source, from, to)
      .all<FactRow>(),
    ...chunks([...new Set(extraSnapshotIds)]).map((snapshotIds) =>
      env.CONTROL_DB.prepare(
        `SELECT snapshot_id, tracked_query_id, metric_date,
          brand_mentioned_runs, brand_mentions_count
         FROM analytics_snapshot_facts
         WHERE project_id = ?
           AND tracking_source = ?
           AND snapshot_id IN (${snapshotIds.map(() => "?").join(",")})`,
      )
        .bind(projectId, source, ...snapshotIds)
        .all<FactRow>(),
    ),
  ];
  const results = await Promise.all(queries);
  const facts = new Map(
    results.flatMap((result) => result.results).map((fact) => [fact.snapshot_id, fact]),
  );
  const byDate = new Map<string, number>();
  const byQuery = new Map<string, number>();
  const bySnapshot = new Map<string, Set<string>>();
  let total = 0;
  for (const fact of facts.values()) {
    const mentionCount = Number(fact.brand_mentions_count) || 0;
    bySnapshot.set(
      fact.snapshot_id,
      new Set(
        Array.from({ length: mentionCount }, (_, index) => `brand:${index}`),
      ),
    );
    if (!fact.brand_mentioned_runs) continue;
    total += 1;
    byDate.set(fact.metric_date, (byDate.get(fact.metric_date) ?? 0) + 1);
    byQuery.set(
      fact.tracked_query_id,
      (byQuery.get(fact.tracked_query_id) ?? 0) + 1,
    );
  }
  return {
    byBrand: new Map(),
    byDate,
    byQuery,
    bySnapshot,
    total,
  };
}

export const analyticsRoutes = new Hono<AppEnv>();

analyticsRoutes.get(
  "/analytics/billing",
  zValidator("query", BillingQuerySchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const billing = await c.env.CONTROL_DB.prepare(
      "SELECT payment_mode FROM billing_accounts WHERE workspace_id = ?",
    ).bind(principal.workspaceId).first<{ payment_mode: string }>();
    if (billing?.payment_mode !== "disabled") {
      throw new ApiError(403, "provider_costs_private", "Provider cost reporting is available only to self-hosted installations.");
    }
    const input = c.req.valid("query");
    if (input.projectId) {
      await assertProjectAccess(
        c.env,
        principal.workspaceId,
        input.projectId,
        c.get("timing"),
      );
    }
    const dates = billingDateRange(input.period);
    const scopedProjectId = input.projectId ?? null;
    const [
      promptRows,
      promptDetailRows,
      promptSourceRows,
      enrichmentRows,
      entityRows,
      projectUsageRows,
      promptDetailProjectRows,
      projectSettings,
      monthlyEnrichmentRows,
      monthlyEntityRows,
    ] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT metric_date, SUM(charged_runs) AS charged_runs,
        SUM(provider_cost_usd) AS provider_cost_usd
       FROM (
         SELECT
           substr(COALESCE(submitted_at, created_at), 1, 10) AS metric_date,
           COUNT(*) AS charged_runs,
           COALESCE(SUM(request_cost_usd), 0) AS provider_cost_usd
         FROM crawl_jobs
         WHERE workspace_id = ?
           AND (? IS NULL OR project_id = ?)
           AND request_cost_usd IS NOT NULL
           AND request_cost_usd > 0
           AND COALESCE(submitted_at, created_at) >= ?
           AND COALESCE(submitted_at, created_at) < ?
         GROUP BY metric_date
         UNION ALL
         SELECT usage_date AS metric_date, charged_runs, provider_cost_usd
         FROM deleted_prompt_usage_daily
         WHERE workspace_id = ? AND (? IS NULL OR project_id = ?)
           AND usage_date >= substr(?, 1, 10)
           AND usage_date < substr(?, 1, 10)
           AND charged_runs > 0
       ) usage
       GROUP BY metric_date
       ORDER BY metric_date`,
      )
        .bind(
          principal.workspaceId,
          scopedProjectId,
          scopedProjectId,
          dates.startTimestamp,
          dates.endExclusiveTimestamp,
          principal.workspaceId,
          scopedProjectId,
          scopedProjectId,
          dates.startTimestamp,
          dates.endExclusiveTimestamp,
        )
        .all<BillingDailyRow>(),
      c.env.CONTROL_DB.prepare(
        `SELECT substr(COALESCE(submitted_at, created_at), 1, 10) AS metric_date,
          delivery_method,
          CASE WHEN tracking_source = 'chatgpt' AND html_r2_key IS NOT NULL
            THEN 1 ELSE 0 END AS retained_page,
          COUNT(*) AS charged_runs,
          COALESCE(SUM(request_cost_usd), 0) AS provider_cost_usd
         FROM crawl_jobs
         WHERE workspace_id = ?
           AND (? IS NULL OR project_id = ?)
           AND request_cost_usd IS NOT NULL
           AND request_cost_usd > 0
           AND COALESCE(submitted_at, created_at) >= ?
           AND COALESCE(submitted_at, created_at) < ?
         GROUP BY metric_date, delivery_method, retained_page
         ORDER BY metric_date, delivery_method, retained_page`,
      )
        .bind(
          principal.workspaceId,
          scopedProjectId,
          scopedProjectId,
          dates.startTimestamp,
          dates.endExclusiveTimestamp,
        )
        .all<BillingDailyRow & {
          delivery_method: "standard" | "standard_priority" | "live";
          retained_page: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT tracking_source,
          SUM(charged_tasks) AS charged_tasks,
          SUM(provider_cost_usd) AS provider_cost_usd,
          SUM(failed_charged_tasks) AS failed_charged_tasks,
          SUM(failed_provider_cost_usd) AS failed_provider_cost_usd
         FROM (
           SELECT tracking_source,
             COUNT(*) AS charged_tasks,
             COALESCE(SUM(request_cost_usd), 0) AS provider_cost_usd,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_charged_tasks,
             COALESCE(SUM(CASE WHEN status = 'failed' THEN request_cost_usd ELSE 0 END), 0)
               AS failed_provider_cost_usd
           FROM crawl_jobs
           WHERE workspace_id = ?
             AND (? IS NULL OR project_id = ?)
             AND request_cost_usd IS NOT NULL
             AND request_cost_usd > 0
             AND COALESCE(submitted_at, created_at) >= ?
             AND COALESCE(submitted_at, created_at) < ?
           GROUP BY tracking_source
           UNION ALL
           SELECT 'deleted_project' AS tracking_source,
             SUM(charged_runs), SUM(provider_cost_usd), 0, 0
           FROM deleted_prompt_usage_daily
           WHERE workspace_id = ? AND (? IS NULL OR project_id = ?)
             AND usage_date >= substr(?, 1, 10)
             AND usage_date < substr(?, 1, 10)
             AND charged_runs > 0
           HAVING SUM(charged_runs) > 0
         ) usage
         GROUP BY tracking_source
         ORDER BY provider_cost_usd DESC`,
      )
        .bind(
          principal.workspaceId,
          scopedProjectId,
          scopedProjectId,
          dates.startTimestamp,
          dates.endExclusiveTimestamp,
          principal.workspaceId,
          scopedProjectId,
          scopedProjectId,
          dates.startTimestamp,
          dates.endExclusiveTimestamp,
        )
        .all<{
          tracking_source: TrackingSource | "deleted_project";
          charged_tasks: number;
          provider_cost_usd: number;
          failed_charged_tasks: number;
          failed_provider_cost_usd: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT substr(COALESCE(submitted_at, created_at), 1, 10) AS metric_date,
          COUNT(*) AS charged_runs, COALESCE(SUM(request_cost_usd), 0) AS provider_cost_usd
         FROM product_enrichment_jobs
         WHERE workspace_id = ? AND (? IS NULL OR project_id = ?)
           AND request_cost_usd IS NOT NULL AND request_cost_usd > 0
           AND COALESCE(submitted_at, created_at) >= ?
           AND COALESCE(submitted_at, created_at) < ?
         GROUP BY metric_date ORDER BY metric_date`,
      )
        .bind(
          principal.workspaceId,
          scopedProjectId,
          scopedProjectId,
          dates.startTimestamp,
          dates.endExclusiveTimestamp,
        )
        .all<BillingDailyRow>(),
      c.env.CONTROL_DB.prepare(
        `SELECT metric_date, SUM(charged_runs) AS charged_runs,
          SUM(provider_cost_usd) AS provider_cost_usd
         FROM (
           SELECT substr(chunk.completed_at, 1, 10) AS metric_date,
             COUNT(*) AS charged_runs,
             COALESCE(SUM(chunk.estimated_cost_usd), 0) AS provider_cost_usd
           FROM entity_extraction_chunks chunk
           JOIN entity_extraction_jobs job ON job.id = chunk.job_id
           WHERE job.workspace_id = ? AND job.run_type = 'live'
             AND (? IS NULL OR job.project_id = ?)
             AND chunk.status = 'completed' AND chunk.completed_at >= ? AND chunk.completed_at < ?
           GROUP BY metric_date
           UNION ALL
           SELECT usage_date, charged_tasks, estimated_cost_usd
           FROM deleted_entity_extraction_usage_daily
           WHERE workspace_id = ? AND (? IS NULL OR project_id = ?)
             AND usage_date >= substr(?, 1, 10) AND usage_date < substr(?, 1, 10)
         ) usage GROUP BY metric_date ORDER BY metric_date`,
      )
        .bind(
          principal.workspaceId,
          scopedProjectId,
          scopedProjectId,
          dates.startTimestamp,
          dates.endExclusiveTimestamp,
          principal.workspaceId,
          scopedProjectId,
          scopedProjectId,
          dates.startTimestamp,
          dates.endExclusiveTimestamp,
        )
        .all<BillingDailyRow>(),
      c.env.CONTROL_DB.prepare(
        `SELECT usage.project_id, COALESCE(project.name, 'Deleted project') AS project_name,
          usage.category, SUM(usage.charged_tasks) AS charged_tasks,
          SUM(usage.cost) AS cost
         FROM (
          SELECT project_id, 'promptTracking' AS category,
            COUNT(*) AS charged_tasks, COALESCE(SUM(request_cost_usd), 0) AS cost
          FROM crawl_jobs
          WHERE workspace_id = ? AND request_cost_usd > 0
            AND COALESCE(submitted_at, created_at) >= ?
            AND COALESCE(submitted_at, created_at) < ?
          GROUP BY project_id
          UNION ALL
          SELECT project_id, 'promptTracking', SUM(charged_runs), SUM(provider_cost_usd)
          FROM deleted_prompt_usage_daily
          WHERE workspace_id = ? AND usage_date >= substr(?, 1, 10)
            AND usage_date < substr(?, 1, 10)
          GROUP BY project_id
          UNION ALL
          SELECT project_id, 'productEnrichment', COUNT(*), COALESCE(SUM(request_cost_usd), 0)
          FROM product_enrichment_jobs
          WHERE workspace_id = ? AND request_cost_usd > 0
            AND COALESCE(submitted_at, created_at) >= ?
            AND COALESCE(submitted_at, created_at) < ?
          GROUP BY project_id
          UNION ALL
          SELECT job.project_id, 'entityExtraction', COUNT(*),
            COALESCE(SUM(chunk.estimated_cost_usd), 0)
          FROM entity_extraction_chunks chunk
          JOIN entity_extraction_jobs job ON job.id = chunk.job_id
          WHERE job.workspace_id = ? AND job.run_type = 'live'
            AND chunk.status = 'completed'
            AND chunk.completed_at >= ? AND chunk.completed_at < ?
          GROUP BY job.project_id
          UNION ALL
          SELECT project_id, 'entityExtraction', SUM(charged_tasks), SUM(estimated_cost_usd)
          FROM deleted_entity_extraction_usage_daily
          WHERE workspace_id = ? AND usage_date >= substr(?, 1, 10)
            AND usage_date < substr(?, 1, 10)
          GROUP BY project_id
         ) usage
         LEFT JOIN projects project ON project.id = usage.project_id
         WHERE (? IS NULL OR usage.project_id = ?)
         GROUP BY usage.project_id, usage.category
         ORDER BY project_name, usage.category`,
      )
        .bind(
          principal.workspaceId, dates.startTimestamp, dates.endExclusiveTimestamp,
          principal.workspaceId, dates.startTimestamp, dates.endExclusiveTimestamp,
          principal.workspaceId, dates.startTimestamp, dates.endExclusiveTimestamp,
          principal.workspaceId, dates.startTimestamp, dates.endExclusiveTimestamp,
          principal.workspaceId, dates.startTimestamp, dates.endExclusiveTimestamp,
          scopedProjectId, scopedProjectId,
        )
        .all<{
          project_id: string;
          project_name: string;
          category: "promptTracking" | "productEnrichment" | "entityExtraction";
          charged_tasks: number;
          cost: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT project_id, delivery_method,
          CASE WHEN tracking_source = 'chatgpt' AND html_r2_key IS NOT NULL
            THEN 1 ELSE 0 END AS retained_page,
          COUNT(*) AS charged_tasks,
          COALESCE(SUM(request_cost_usd), 0) AS cost
         FROM crawl_jobs
         WHERE workspace_id = ?
           AND (? IS NULL OR project_id = ?)
           AND request_cost_usd IS NOT NULL
           AND request_cost_usd > 0
           AND COALESCE(submitted_at, created_at) >= ?
           AND COALESCE(submitted_at, created_at) < ?
         GROUP BY project_id, delivery_method, retained_page`,
      )
        .bind(
          principal.workspaceId,
          scopedProjectId,
          scopedProjectId,
          dates.startTimestamp,
          dates.endExclusiveTimestamp,
        )
        .all<{
          project_id: string;
          delivery_method: "standard" | "standard_priority" | "live";
          retained_page: number;
          charged_tasks: number;
          cost: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT id, name, product_enrichment_warning_usd, entity_extraction_warning_usd
         FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
           AND (? IS NULL OR id = ?)
         ORDER BY name`,
      )
        .bind(principal.workspaceId, scopedProjectId, scopedProjectId)
        .all<{
          id: string;
          name: string;
          product_enrichment_warning_usd: number;
          entity_extraction_warning_usd: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT project_id, COUNT(*) AS charged_tasks,
          COALESCE(SUM(request_cost_usd), 0) AS cost
         FROM product_enrichment_jobs
         WHERE workspace_id = ? AND request_cost_usd > 0
           AND COALESCE(submitted_at, created_at) >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
         GROUP BY project_id`,
      ).bind(principal.workspaceId).all<{ project_id: string; charged_tasks: number; cost: number }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT project_id, SUM(charged_tasks) AS charged_tasks, SUM(cost) AS cost FROM (
          SELECT job.project_id, COUNT(*) AS charged_tasks,
            COALESCE(SUM(chunk.estimated_cost_usd), 0) AS cost
          FROM entity_extraction_chunks chunk
          JOIN entity_extraction_jobs job ON job.id = chunk.job_id
          WHERE job.workspace_id = ? AND job.run_type = 'live'
            AND chunk.status = 'completed'
            AND chunk.completed_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
          GROUP BY job.project_id
          UNION ALL
          SELECT project_id, SUM(charged_tasks), SUM(estimated_cost_usd)
          FROM deleted_entity_extraction_usage_daily
          WHERE workspace_id = ? AND usage_date >= strftime('%Y-%m-01', 'now')
          GROUP BY project_id
        ) usage GROUP BY project_id`,
      ).bind(principal.workspaceId, principal.workspaceId)
        .all<{ project_id: string; charged_tasks: number; cost: number }>(),
    ]);
    const promptReport = buildBillingReport(promptRows.results, dates);
    const highPriorityPromptReport = buildBillingReport(
      promptDetailRows.results.filter((row) => row.delivery_method === "standard_priority"),
      dates,
    );
    const livePromptReport = buildBillingReport(
      promptDetailRows.results.filter((row) => row.delivery_method === "live"),
      dates,
    );
    const retainedPromptReport = buildBillingReport(
      promptDetailRows.results.filter((row) => row.retained_page === 1),
      dates,
    );
    const enrichmentReport = buildBillingReport(enrichmentRows.results, dates);
    const entityReport = buildBillingReport(entityRows.results, dates);
    const mergedReport = mergeBillingReports(
      promptReport,
      enrichmentReport,
      entityReport,
      {
        highPriority: highPriorityPromptReport,
        live: livePromptReport,
        retainedPages: retainedPromptReport,
      },
    );
    const sourceBreakdown = promptSourceRows.results.map((row) => ({
      source: row.tracking_source,
      chargedTasks: Number(row.charged_tasks ?? 0),
      totalCost: Number(row.provider_cost_usd ?? 0),
      failedChargedTasks: Number(row.failed_charged_tasks ?? 0),
      failedCost: Number(row.failed_provider_cost_usd ?? 0),
    }));
    const providerChargedFailures = sourceBreakdown.reduce(
      (total, source) => ({
        chargedTasks: total.chargedTasks + source.failedChargedTasks,
        totalCost: total.totalCost + source.failedCost,
      }),
      { chargedTasks: 0, totalCost: 0 },
    );
    const breakdown = new Map<string, {
      projectId: string;
      projectName: string;
      totalCost: number;
      chargedTasks: number;
      promptTrackingCost: number;
      promptTrackingTasks: number;
      promptTrackingStandardCost: number;
      promptTrackingHighPriorityCost: number;
      promptTrackingLiveCost: number;
      promptTrackingStandardTasks: number;
      promptTrackingHighPriorityTasks: number;
      promptTrackingLiveTasks: number;
      retainedPageCost: number;
      retainedPageTasks: number;
      productEnrichmentCost: number;
      entityExtractionCost: number;
    }>();
    for (const row of projectUsageRows.results) {
      const current = breakdown.get(row.project_id) ?? {
        projectId: row.project_id,
        projectName: row.project_name,
        totalCost: 0,
        chargedTasks: 0,
        promptTrackingCost: 0,
        promptTrackingTasks: 0,
        promptTrackingStandardCost: 0,
        promptTrackingHighPriorityCost: 0,
        promptTrackingLiveCost: 0,
        promptTrackingStandardTasks: 0,
        promptTrackingHighPriorityTasks: 0,
        promptTrackingLiveTasks: 0,
        retainedPageCost: 0,
        retainedPageTasks: 0,
        productEnrichmentCost: 0,
        entityExtractionCost: 0,
      };
      const cost = Number(row.cost ?? 0);
      current.totalCost += cost;
      current.chargedTasks += Number(row.charged_tasks ?? 0);
      current[`${row.category}Cost`] = cost;
      if (row.category === "promptTracking") {
        current.promptTrackingTasks = Number(row.charged_tasks ?? 0);
      }
      breakdown.set(row.project_id, current);
    }
    for (const row of promptDetailProjectRows.results) {
      const current = breakdown.get(row.project_id);
      if (!current) continue;
      const cost = Number(row.cost ?? 0);
      const tasks = Number(row.charged_tasks ?? 0);
      if (row.delivery_method === "standard_priority") {
        current.promptTrackingHighPriorityCost += cost;
        current.promptTrackingHighPriorityTasks += tasks;
      } else if (row.delivery_method === "live") {
        current.promptTrackingLiveCost += cost;
        current.promptTrackingLiveTasks += tasks;
      }
      if (row.retained_page === 1) {
        current.retainedPageCost += cost;
        current.retainedPageTasks += tasks;
      }
    }
    for (const current of breakdown.values()) {
      current.promptTrackingStandardCost = Math.max(
        0,
        current.promptTrackingCost - current.promptTrackingHighPriorityCost -
          current.promptTrackingLiveCost,
      );
      current.promptTrackingStandardTasks = Math.max(
        0,
        current.promptTrackingTasks - current.promptTrackingHighPriorityTasks -
          current.promptTrackingLiveTasks,
      );
    }
    const enrichmentByProject = new Map(monthlyEnrichmentRows.results.map((row) => [row.project_id, row]));
    const entityByProject = new Map(monthlyEntityRows.results.map((row) => [row.project_id, row]));
    const projectAlerts = projectSettings.results.flatMap((project) => {
      const enrichment = enrichmentByProject.get(project.id);
      const entities = entityByProject.get(project.id);
      const productThreshold = Number(project.product_enrichment_warning_usd);
      const entityThreshold = Number(project.entity_extraction_warning_usd);
      const productCost = Number(enrichment?.cost ?? 0);
      const entityCost = Number(entities?.cost ?? 0);
      return [
        {
          projectId: project.id,
          projectName: project.name,
          category: "productEnrichment",
          monthToDateTasks: Number(enrichment?.charged_tasks ?? 0),
          monthToDateCost: productCost,
          threshold: productThreshold,
          exceeded: productThreshold > 0 && productCost >= productThreshold,
          estimated: false,
        },
        {
          projectId: project.id,
          projectName: project.name,
          category: "entityExtraction",
          monthToDateTasks: Number(entities?.charged_tasks ?? 0),
          monthToDateCost: entityCost,
          threshold: entityThreshold,
          exceeded: entityThreshold > 0 && entityCost >= entityThreshold,
          estimated: true,
        },
      ];
    });
    return c.json({
      data: {
        period: input.period,
        projectId: scopedProjectId,
        currency: "USD",
        range: mergedReport.range,
        summary: {
          ...mergedReport.summary,
          promptTrackingBreakdown: {
            ...mergedReport.summary.promptTrackingBreakdown,
            bySource: sourceBreakdown,
            providerChargedFailures,
          },
        },
        series: mergedReport.series,
        projectBreakdown: [...breakdown.values()].sort((left, right) => right.totalCost - left.totalCost),
        projectAlerts,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/overview",
  zValidator("query", OverviewDateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    const dates = range(input);
    const allSources = input.source === "all";
    const [readModelState, configuredSources] = await Promise.all([
      requireAnalyticsProjectContext(
        c.env,
        principal.workspaceId,
        input.projectId,
        c.get("timing"),
      ),
      allSources
        ? projectTrackingSources(c.env, input.projectId)
        : Promise.resolve([] as TrackingSource[]),
    ]);
    const includedSources: TrackingSource[] = allSources
      ? configuredSources
      : [input.source as TrackingSource];
    const singleSource = includedSources[0]!;
    const sourcePlaceholders = includedSources.map(() => "?").join(",");
    const readModelReady =
      (allSources || input.source === "chatgpt") &&
      analyticsReadModelSupports(readModelState);
    const brandReadModelReady = analyticsReadModelSupports(readModelState);
    const [
      summary,
      productCoverage,
      series,
      productIndexes,
      topCitationSources,
      project,
      verifiedBrandMentionReports,
      trackedBrands,
      brandMentionDays,
      projectEventRows,
      platformSummaryRows,
    ] = await c.get("timing").measure("overview_primary_db", () => Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT
          COALESCE(SUM(completed_runs), 0) AS completed_runs,
          COALESCE(SUM(surface_present_runs), 0) AS surface_present_runs,
          COALESCE(SUM(cited_runs), 0) AS cited_runs,
          COALESCE(SUM(brand_mentioned_runs), 0) AS brand_mentioned_runs,
          COALESCE(SUM(product_runs), 0) AS product_runs,
          COALESCE(SUM(total_citations), 0) AS total_citations
        FROM daily_source_project_metrics
        WHERE project_id = ? AND tracking_source IN (${sourcePlaceholders})
          AND metric_date BETWEEN ? AND ?`,
      )
        .bind(input.projectId, ...includedSources, dates.from, dates.to)
        .first<{
          completed_runs: number;
          surface_present_runs: number;
          cited_runs: number;
          brand_mentioned_runs: number;
          product_runs: number;
          total_citations: number;
        }>(),
      allSources
        ? c.env.CONTROL_DB.prepare(
            `SELECT COUNT(id) AS tracked_prompt_count, 0 AS product_prompt_count
             FROM tracked_queries
             WHERE project_id = ? AND is_active = 1 AND deleted_at IS NULL`,
          )
            .bind(input.projectId)
            .first<{
              tracked_prompt_count: number;
              product_prompt_count: number;
            }>()
        : c.env.CONTROL_DB.prepare(
        `SELECT
          COUNT(q.id) AS tracked_prompt_count,
          COALESCE(SUM(
            CASE WHEN (
              SELECT s.has_product_block
              FROM snapshot_index s
              WHERE s.tracked_query_id = q.id
                AND s.tracking_source = ?
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
          input.source,
          `${dates.from}T00:00:00.000Z`,
          exclusiveDateEnd(dates.to),
          input.projectId,
        )
        .first<{
          tracked_prompt_count: number;
          product_prompt_count: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT
           project_id,
           metric_date,
           SUM(completed_runs) AS completed_runs,
           SUM(surface_present_runs) AS surface_present_runs,
           SUM(cited_runs) AS cited_runs,
           SUM(brand_mentioned_runs) AS brand_mentioned_runs,
           SUM(product_runs) AS product_runs,
           SUM(total_citations) AS total_citations,
           MAX(updated_at) AS updated_at
         FROM daily_source_project_metrics
         WHERE project_id = ? AND tracking_source IN (${sourcePlaceholders})
           AND metric_date BETWEEN ? AND ?
         GROUP BY project_id, metric_date
         ORDER BY metric_date`,
      )
        .bind(input.projectId, ...includedSources, dates.from, dates.to)
        .all<{
          project_id: string;
          metric_date: string;
          completed_runs: number;
          cited_runs: number;
          brand_mentioned_runs: number;
          product_runs: number;
          total_citations: number;
          updated_at: string;
        }>(),
      allSources
        ? Promise.resolve({ results: [] as ProductSnapshotIndex[] })
        : readModelReady
        ? Promise.resolve({ results: [] as ProductSnapshotIndex[] })
        : c.env.CONTROL_DB.prepare(
            `SELECT id, shard_id FROM snapshot_index
             WHERE project_id = ? AND captured_at >= ? AND captured_at < ?
               AND tracking_source = ?
               AND products_count > 0
             ORDER BY captured_at DESC`,
          )
            .bind(
              input.projectId,
              `${dates.from}T00:00:00.000Z`,
              exclusiveDateEnd(dates.to),
              input.source,
            )
            .all<ProductSnapshotIndex>(),
      c.env.CONTROL_DB.prepare(
        `SELECT domain, SUM(citation_count) AS total_citations
         FROM daily_source_domain_metrics
         WHERE project_id = ? AND tracking_source IN (${sourcePlaceholders})
           AND metric_date BETWEEN ? AND ?
           AND citation_count > 0
         GROUP BY domain
         ORDER BY total_citations DESC, domain
         LIMIT 5`,
      )
        .bind(input.projectId, ...includedSources, dates.from, dates.to)
        .all<{ domain: string; total_citations: number }>(),
      c.env.CONTROL_DB.prepare(
        "SELECT primary_domain FROM projects WHERE id = ?",
      )
        .bind(input.projectId)
        .first<{ primary_domain: string | null }>(),
      allSources
        ? readModelReady
          ? Promise.all(
              includedSources.map((source) =>
                c.get("timing").measure("analytics_read_model", () =>
                  loadReadModelBrandMentions(
                    c.env,
                    input.projectId,
                    dates.from,
                    dates.to,
                    [],
                    source,
                  ),
                ),
              ),
            )
          : Promise.all(
              includedSources.map((source) =>
                c.get("timing").measure("legacy_shards", () =>
                  verifyStoredBrandMentions(
                    c.env,
                    input.projectId,
                    dates.from,
                    dates.to,
                    [],
                    true,
                    source,
                  ),
                ),
              ),
            )
        : readModelReady
        ? c
            .get("timing")
            .measure("analytics_read_model", () =>
              loadReadModelBrandMentions(
                c.env,
                input.projectId,
                dates.from,
                dates.to,
                [],
                singleSource,
              ),
            ).then((report) => [report])
        : c
            .get("timing")
            .measure("legacy_shards", () =>
              verifyStoredBrandMentions(
                c.env,
                input.projectId,
                dates.from,
                dates.to,
                [],
                true,
                  singleSource,
              ),
            ).then((report) => [report]),
      c.env.CONTROL_DB.prepare(
        `SELECT id, name, kind
         FROM tracked_brands
         WHERE project_id = ?
         ORDER BY kind DESC, name, id`,
      )
        .bind(input.projectId)
        .all<TrackedBrandReportRow>(),
      brandReadModelReady
        ? c.env.CONTROL_DB.prepare(
            `SELECT
              metric.metric_date,
              metric.tracking_source,
              metric.tracked_brand_id AS brand_id,
              metric.mentioned_response_count AS deterministic_responses,
              0 AS extracted_responses,
              0 AS overlap_responses,
              COALESCE(owned.mentioned_response_count, 0) AS owned_mentioned_responses,
              metric.position_sum,
              metric.position_sample_count,
              COALESCE(owned.position_sum, 0) AS owned_position_sum,
              COALESCE(owned.position_sample_count, 0) AS owned_position_sample_count
            FROM analytics_daily_brand_metrics metric
            JOIN projects project ON project.id = metric.project_id
            LEFT JOIN analytics_daily_owned_brand_metrics owned
              ON owned.project_id = metric.project_id
             AND owned.tracking_source = metric.tracking_source
             AND owned.metric_date = metric.metric_date
             AND owned.brand_metrics_revision = metric.brand_metrics_revision
            WHERE metric.project_id = ?
              AND metric.tracking_source IN (${sourcePlaceholders})
              AND metric.metric_date BETWEEN ? AND ?
              AND metric.brand_metrics_revision = project.brand_metrics_revision
            ORDER BY metric.metric_date, metric.tracking_source,
              metric.tracked_brand_id`,
          )
            .bind(
              input.projectId,
              ...includedSources,
              dates.from,
              dates.to,
            )
            .all<SourceBrandMentionDailyRow>()
        : c.env.CONTROL_DB.prepare(
        `WITH mention_candidates AS (
          SELECT
            contribution.metric_date,
            contribution.snapshot_id,
            contribution.tracking_source,
            CAST(brand_value.value AS TEXT) AS brand_id,
            1 AS deterministic_match,
            0 AS extracted_match
          FROM metric_contributions AS contribution
          CROSS JOIN json_each(contribution.brands_json) AS brand_value
          JOIN tracked_brands AS brand
            ON brand.id = CAST(brand_value.value AS TEXT)
           AND brand.project_id = contribution.project_id
          WHERE contribution.project_id = ?
            AND contribution.tracking_source IN (${sourcePlaceholders})
            AND contribution.metric_date BETWEEN ? AND ?

          UNION ALL

          SELECT
            substr(mention.captured_at, 1, 10) AS metric_date,
            mention.snapshot_id,
            mention_snapshot.tracking_source,
            entity.tracked_brand_id AS brand_id,
            0 AS deterministic_match,
            1 AS extracted_match
          FROM entity_mentions AS mention
          JOIN project_entities AS entity ON entity.id = mention.entity_id
          JOIN snapshot_index AS mention_snapshot ON mention_snapshot.id = mention.snapshot_id
          JOIN tracked_brands AS brand
            ON brand.id = entity.tracked_brand_id
           AND brand.project_id = mention.project_id
          WHERE mention.project_id = ?
            AND mention.extractor_version = (
              SELECT active_entity_extractor_version FROM projects
              WHERE id = mention.project_id
            )
            AND mention_snapshot.tracking_source IN (${sourcePlaceholders})
            AND mention.captured_at >= ?
            AND mention.captured_at < ?
            AND entity.tracked_brand_id IS NOT NULL
        ), combined_pairs AS (
          SELECT
            metric_date,
            snapshot_id,
            tracking_source,
            brand_id,
            MAX(deterministic_match) AS deterministic_match,
            MAX(extracted_match) AS extracted_match
          FROM mention_candidates
          GROUP BY metric_date, snapshot_id, tracking_source, brand_id
        ), owned_daily AS (
          SELECT
            pair.metric_date,
            pair.tracking_source,
            COUNT(DISTINCT pair.snapshot_id) AS owned_mentioned_responses
          FROM combined_pairs AS pair
          JOIN tracked_brands AS brand ON brand.id = pair.brand_id
          WHERE brand.kind = 'owned'
          GROUP BY pair.metric_date, pair.tracking_source
        )
        SELECT
          pair.metric_date,
          pair.tracking_source,
          pair.brand_id,
          SUM(pair.deterministic_match) AS deterministic_responses,
          SUM(pair.extracted_match) AS extracted_responses,
          SUM(
            CASE
              WHEN pair.deterministic_match = 1 AND pair.extracted_match = 1
              THEN 1 ELSE 0
            END
          ) AS overlap_responses,
          COALESCE(owned.owned_mentioned_responses, 0) AS owned_mentioned_responses
        FROM combined_pairs AS pair
        LEFT JOIN owned_daily AS owned
          ON owned.metric_date = pair.metric_date
         AND owned.tracking_source = pair.tracking_source
        GROUP BY pair.metric_date, pair.tracking_source, pair.brand_id
        ORDER BY pair.metric_date, pair.tracking_source, pair.brand_id`,
      )
        .bind(
          input.projectId,
          ...includedSources,
          dates.from,
          dates.to,
          input.projectId,
          ...includedSources,
          `${dates.from}T00:00:00.000Z`,
          exclusiveDateEnd(dates.to),
        )
        .all<SourceBrandMentionDailyRow>(),
      c.env.CONTROL_DB.prepare(
        `SELECT id, event_type, tracking_source, event_date, occurred_at,
           payload_json
         FROM project_events
         WHERE project_id = ?
           AND event_date BETWEEN ? AND ?
           AND (
             event_type = 'prompt_set_changed'
             OR (? = 1 AND event_type = 'tracking_sources_changed')
             OR (
               event_type = 'model_detected'
               AND tracking_source IN (${sourcePlaceholders})
             )
           )
         ORDER BY event_date, occurred_at, id`,
      )
        .bind(
          input.projectId,
          dates.from,
          dates.to,
          allSources ? 1 : 0,
          ...includedSources,
        )
        .all<ProjectEventRow>(),
      c.env.CONTROL_DB.prepare(
        `SELECT
           tracking_source,
           metric_date,
           completed_runs,
           surface_present_runs,
           total_citations
         FROM daily_source_project_metrics
         WHERE project_id = ? AND tracking_source IN (${sourcePlaceholders})
           AND metric_date BETWEEN ? AND ?`,
      )
        .bind(input.projectId, ...includedSources, dates.from, dates.to)
        .all<{
          tracking_source: TrackingSource;
          metric_date: string;
          completed_runs: number;
          surface_present_runs: number;
          total_citations: number;
        }>(),
    ]));
    const verifiedBySource = new Map(
      includedSources.map((source, index) => [
        source,
        verifiedBrandMentionReports[index]!,
      ]),
    );
    const verifiedBrandMentions = mergeVerifiedBrandMentions(
      verifiedBrandMentionReports,
    );
    const projectDomain = normalizeHostname(project?.primary_domain)
      .registrableDomain;
    const sourceDomains = topCitationSources.results.map((source) => source.domain);
    if (projectDomain && !sourceDomains.includes(projectDomain)) {
      sourceDomains.push(projectDomain);
    }
    const [sourceMetrics, recentOccurrenceRows] = await Promise.all([
      sourceDomains.length
        ? c.env.CONTROL_DB.prepare(
            `SELECT domain, metric_date, cited_snapshot_count, citation_count
             FROM daily_source_domain_metrics
             WHERE project_id = ? AND tracking_source IN (${sourcePlaceholders})
               AND metric_date BETWEEN ? AND ?
               AND domain IN (${sourceDomains.map(() => "?").join(",")})
             ORDER BY metric_date, domain`,
          )
            .bind(input.projectId, ...includedSources, dates.from, dates.to, ...sourceDomains)
            .all<{
              domain: string;
              metric_date: string;
              cited_snapshot_count: number;
              citation_count: number;
            }>()
        : Promise.resolve({
            results: [] as Array<{
              domain: string;
              metric_date: string;
              cited_snapshot_count: number;
              citation_count: number;
            }>,
          }),
      allSources
        ? Promise.resolve([] as ShoppingProductOccurrence[])
        : readModelReady
          ? c.get("timing").measure("analytics_read_model", () =>
              loadReadModelShoppingProductOccurrences(
                c.env,
                input.projectId,
                `${dates.from}T00:00:00.000Z`,
                exclusiveDateEnd(dates.to),
                undefined,
                singleSource,
              ),
            )
          : c.get("timing").measure("legacy_shards", () =>
              loadShoppingProductOccurrences(c.env, productIndexes.results),
            ),
    ]);
    const sourceMetricsByDate = new Map<
      string,
      Map<string, { citedRuns: number; citations: number }>
    >();
    const sourceCitationTotals = new Map(
      topCitationSources.results.map((source) => [
        source.domain,
        source.total_citations,
      ]),
    );
    const rankedSourceDomains = new Set(
      topCitationSources.results.map((source) => source.domain),
    );
    for (const metric of sourceMetrics.results) {
      const dateMetrics =
        sourceMetricsByDate.get(metric.metric_date) ??
        new Map<string, { citedRuns: number; citations: number }>();
      const existingDateMetric = dateMetrics.get(metric.domain);
      dateMetrics.set(metric.domain, {
        citedRuns:
          (existingDateMetric?.citedRuns ?? 0) + metric.cited_snapshot_count,
        citations:
          (existingDateMetric?.citations ?? 0) + metric.citation_count,
      });
      sourceMetricsByDate.set(metric.metric_date, dateMetrics);
      if (!rankedSourceDomains.has(metric.domain)) {
        sourceCitationTotals.set(
          metric.domain,
          (sourceCitationTotals.get(metric.domain) ?? 0) +
            metric.citation_count,
        );
      }
    }
    const recentOccurrences = recentOccurrenceRows.sort((left, right) =>
      right.captured_at.localeCompare(left.captured_at),
    );
    const recentProducts = new Map<string, ShoppingProductOccurrence>();
    const topProducts = new Map<
      string,
      ShoppingProductOccurrence & { appearances: number }
    >();
    for (const product of recentOccurrences) {
      const key = productIdentity(product);
      if (!recentProducts.has(key)) recentProducts.set(key, product);
      const existing = topProducts.get(key);
      if (existing) {
        existing.appearances += 1;
      } else {
        topProducts.set(key, { ...product, appearances: 1 });
      }
    }
    const completed = summary?.completed_runs ?? 0;
    const trackedPrompts = productCoverage?.tracked_prompt_count ?? 0;
    const consolidatedBrandMentionDays = aggregateBrandMentionDays(
      brandMentionDays.results,
    );
    const brandComparison = buildBrandComparison(
      trackedBrands.results,
      series.results,
      consolidatedBrandMentionDays,
    );
    const positionStatus = brandReadModelReady
      ? "ready"
      : readModelState?.status === "failed"
        ? "failed"
        : "backfilling";
    const platformSummaries = new Map<TrackingSource, {
      completedRuns: number;
      surfacePresentRuns: number;
      totalCitations: number;
    }>();
    for (const row of platformSummaryRows.results) {
      const current = platformSummaries.get(row.tracking_source) ?? {
        completedRuns: 0,
        surfacePresentRuns: 0,
        totalCitations: 0,
      };
      current.completedRuns += Number(row.completed_runs);
      current.surfacePresentRuns += Number(row.surface_present_runs);
      current.totalCitations += Number(row.total_citations);
      platformSummaries.set(row.tracking_source, current);
    }
    const platformBreakdown = includedSources.map((source) => {
      const sourceSummary = platformSummaries.get(source);
      const sourceCompletedDays = platformSummaryRows.results
        .filter((row) => row.tracking_source === source)
        .map((row) => ({
          metric_date: row.metric_date,
          completed_runs: row.completed_runs,
        }));
      const sourceMentionDays = brandMentionDays.results.filter(
        (row) => row.tracking_source === source,
      );
      const sourceCompleted = sourceSummary?.completedRuns ?? 0;
      const sourceComparison = buildBrandComparison(
        trackedBrands.results,
        sourceCompletedDays,
        sourceMentionDays,
      );
      const verified = verifiedBySource.get(source);
      const ownedMentionedResponses = verified?.total ?? 0;
      return {
        trackingSource: source,
        completedRuns: sourceCompleted,
        surfacePresentRuns: sourceSummary?.surfacePresentRuns ?? 0,
        totalCitations: sourceSummary?.totalCitations ?? 0,
        visibility: sourceCompleted
          ? (ownedMentionedResponses / sourceCompleted) * 100
          : null,
        shareOfVoice: sourceCompleted
          ? sourceComparison.summary.ownedShareOfVoice
          : null,
        averagePosition: brandReadModelReady
          ? sourceComparison.summary.ownedAveragePosition
          : null,
      };
    });
    return c.json({
      data: {
        trackingSource: input.source,
        includedSources,
        platformBreakdown: allSources ? platformBreakdown : [],
        summary: {
          ...summary,
          brand_mentioned_runs: verifiedBrandMentions.total,
          trackedPromptCount: trackedPrompts,
          productPromptCount: productCoverage?.product_prompt_count ?? 0,
          productPromptCoverage: trackedPrompts
            ? ((productCoverage?.product_prompt_count ?? 0) / trackedPrompts) * 100
            : 0,
          citationRate: completed ? ((summary?.cited_runs ?? 0) / completed) * 100 : 0,
          brandMentionRate: completed
            ? (verifiedBrandMentions.total / completed) * 100
            : 0,
          productBlockRate: completed
            ? ((summary?.product_runs ?? 0) / completed) * 100
            : 0,
        },
        series: series.results.map((point) => ({
          ...point,
          brand_mentioned_runs:
            verifiedBrandMentions.byDate.get(point.metric_date) ?? 0,
        })),
        citationSourceTrends: {
          sources: sourceDomains.map((domain) => ({
            domain,
            isProjectDomain: domain === projectDomain,
            totalCitations: sourceCitationTotals.get(domain) ?? 0,
          })),
          series: series.results.map((point) => {
            const dateMetrics = sourceMetricsByDate.get(point.metric_date);
            return {
              metric_date: point.metric_date,
              rates: Object.fromEntries(
                sourceDomains.map((domain) => {
                  const citedRuns = dateMetrics?.get(domain)?.citedRuns ?? 0;
                  return [
                    domain,
                    point.completed_runs
                      ? (citedRuns / point.completed_runs) * 100
                      : 0,
                  ];
                }),
              ),
            };
          }),
        },
        brandComparison: {
          ...brandComparison,
          positionStatus,
        },
        annotations: buildChartAnnotations(projectEventRows.results),
        topProducts: [...topProducts.values()]
          .sort(
            (left, right) =>
              right.appearances - left.appearances ||
              right.captured_at.localeCompare(left.captured_at),
          )
          .slice(0, 5)
          .map(serializedShoppingProduct),
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
    await assertProjectAccess(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const dates = range(input);
    const rows = await c.env.CONTROL_DB.prepare(
      `SELECT
        domain,
        SUM(cited_snapshot_count) AS cited_snapshot_count,
        SUM(citation_count) AS citation_count,
        SUM(retrieved_snapshot_count) AS retrieved_snapshot_count,
        SUM(retrieval_count) AS retrieval_count,
        SUM(product_count) AS product_count
      FROM daily_source_domain_metrics
      WHERE project_id = ? AND tracking_source = ?
        AND metric_date BETWEEN ? AND ?
      GROUP BY domain
      ORDER BY citation_count DESC, retrieval_count DESC
      LIMIT 250`,
    )
      .bind(input.projectId, input.source, dates.from, dates.to)
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
    const readModelState = await requireAnalyticsProjectContext(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const readModelReady = analyticsReadModelSupports(readModelState);
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
    const promptCursor = decodeCursor<{ createdAt: string; id: string }>(
      input.cursor,
      "analytics-prompts",
    );
    if (
      promptCursor &&
      (typeof promptCursor.createdAt !== "string" ||
        typeof promptCursor.id !== "string")
    ) {
      throw new ApiError(400, "invalid_cursor", "The prompt cursor is invalid.");
    }
    const totalStatement = c.env.CONTROL_DB.prepare(
      `SELECT COUNT(*) AS total
       FROM tracked_queries q
       WHERE ${clauses.join(" AND ")}`,
    )
      .bind(...bindings);
    if (promptCursor) {
      clauses.push(
        "(q.created_at < ? OR (q.created_at = ? AND q.id < ?))",
      );
      bindings.push(
        promptCursor.createdAt,
        promptCursor.createdAt,
        promptCursor.id,
      );
    }
    bindings.push(input.limit + 1);
    if (!promptCursor && input.offset !== undefined) {
      bindings.push(input.offset);
    }
    const queryStatement = c.env.CONTROL_DB.prepare(
      `SELECT
        q.id, q.query_text, q.location_code, q.language_code, q.created_at,
        q.schedule_cadence, q.schedule_time, q.schedule_timezone, q.is_active,
        q.shard_id,
        (SELECT s.id FROM snapshot_index s WHERE s.tracked_query_id = q.id
          AND s.tracking_source = ?
          ORDER BY s.captured_at DESC LIMIT 1) AS latest_snapshot_id,
        (SELECT s.captured_at FROM snapshot_index s WHERE s.tracked_query_id = q.id
          AND s.tracking_source = ?
          ORDER BY s.captured_at DESC LIMIT 1) AS latest_captured_at,
        (SELECT s.id FROM snapshot_index s WHERE s.tracked_query_id = q.id
          AND s.tracking_source = ?
          ORDER BY s.captured_at DESC LIMIT 1 OFFSET 1) AS previous_snapshot_id,
        (SELECT COUNT(*) FROM snapshot_index s WHERE s.tracked_query_id = q.id
          AND s.tracking_source = ?)
          AS snapshot_count,
        (SELECT j.status FROM crawl_jobs j WHERE j.tracked_query_id = q.id
          AND j.tracking_source = ?
          ORDER BY j.created_at DESC LIMIT 1) AS latest_run_status,
        COALESCE((
          SELECT json_group_array(json_object(
            'id', tag.id,
            'name', tag.name,
            'colorIndex', tag.color_index
          ))
          FROM (
            SELECT t.id, t.name, t.color_index
            FROM tracked_query_tags qt
            JOIN prompt_tags t ON t.id = qt.tag_id
            WHERE qt.tracked_query_id = q.id
            ORDER BY lower(t.name), t.id
          ) tag
        ), '[]') AS tags_json
      FROM tracked_queries q
      WHERE ${clauses.join(" AND ")}
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT ?${!promptCursor && input.offset !== undefined ? " OFFSET ?" : ""}`,
    )
      .bind(
        input.source,
        input.source,
        input.source,
        input.source,
        input.source,
        ...bindings,
      );
    const [totalResult, queryResult] = await c.get("timing").measureD1(
      "prompts_page_db",
      () => c.env.CONTROL_DB.batch([totalStatement, queryStatement]),
    );
    const total = Number(
      (totalResult?.results[0] as { total?: number } | undefined)?.total ?? 0,
    );
    if (!queryResult) throw new Error("Prompts query batch returned no page result.");
    const queryRows = queryResult as D1Result<{
      id: string;
      query_text: string;
      location_code: number;
      language_code: string;
      created_at: string;
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
      tags_json: string;
    }>;
    const hasMore = queryRows.results.length > input.limit;
    const rows = queryRows.results.slice(0, input.limit);
    const snapshotCounts = new Map<
      string,
      { sourceCount: number; citationCount: number }
    >();
    const contributionIds = rows
      .flatMap((row) => [row.latest_snapshot_id, row.previous_snapshot_id])
      .filter((value): value is string => Boolean(value));
    const mentionDates = range({});
    type MentionRateRow = {
      tracked_query_id: string;
      completed_runs: number;
    };
    let verifiedBrandMentions: VerifiedBrandMentions;
    let mentionRates: D1Result<MentionRateRow>;
    if (readModelReady) {
      const snapshotStatements = chunks([...new Set(contributionIds)]).map(
        (snapshotIds) =>
          c.env.CONTROL_DB.prepare(
            `SELECT snapshot_id, retrieved_domains_count, citation_count
             FROM analytics_snapshot_facts
             WHERE snapshot_id IN (${snapshotIds.map(() => "?").join(",")})`,
          ).bind(...snapshotIds),
      );
      const [supplementalResults, brandMentions] = await Promise.all([
        c.get("timing").measureD1("prompts_supplemental_db", () =>
          c.env.CONTROL_DB.batch([
            ...snapshotStatements,
            c.env.CONTROL_DB.prepare(
              `SELECT tracked_query_id, COUNT(*) AS completed_runs
               FROM analytics_snapshot_facts
               WHERE project_id = ? AND tracking_source = ?
                 AND metric_date BETWEEN ? AND ?
               GROUP BY tracked_query_id`,
            ).bind(
              input.projectId,
              input.source,
              mentionDates.from,
              mentionDates.to,
            ),
          ]),
        ),
        c.get("timing").measure("analytics_read_model", () =>
          loadReadModelBrandMentions(
            c.env,
            input.projectId,
            mentionDates.from,
            mentionDates.to,
            contributionIds,
            input.source,
          ),
        ),
      ]);
      const mentionRateResult = supplementalResults.at(-1);
      if (!mentionRateResult) {
        throw new Error("Prompts supplemental batch returned no rate result.");
      }
      for (const result of supplementalResults.slice(0, -1)) {
        for (const value of result.results as Array<{
          snapshot_id: string;
          retrieved_domains_count: number;
          citation_count: number;
        }>) {
          snapshotCounts.set(value.snapshot_id, {
            sourceCount: Number(value.retrieved_domains_count) || 0,
            citationCount: Number(value.citation_count) || 0,
          });
        }
      }
      verifiedBrandMentions = brandMentions;
      mentionRates = mentionRateResult as D1Result<MentionRateRow>;
    } else {
      const grouped = new Map<number, string[]>();
      for (const row of rows) {
        for (const snapshotId of [
          row.latest_snapshot_id,
          row.previous_snapshot_id,
        ]) {
          if (snapshotId) {
            grouped.set(row.shard_id, [
              ...(grouped.get(row.shard_id) ?? []),
              snapshotId,
            ]);
          }
        }
      }
      await c.get("timing").measure("legacy_shards", () =>
        Promise.all(
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
                .all<{
                  id: string;
                  source_count: number;
                  citation_count: number;
                }>();
              for (const value of result.results) {
                snapshotCounts.set(value.id, {
                  sourceCount: value.source_count,
                  citationCount: value.citation_count,
                });
              }
            }),
          ),
        ),
      );
      [verifiedBrandMentions, mentionRates] = await Promise.all([
        c.get("timing").measure("legacy_shards", () =>
          verifyStoredBrandMentions(
            c.env,
            input.projectId,
            mentionDates.from,
            mentionDates.to,
            contributionIds,
            true,
            input.source,
          ),
        ),
        c.env.CONTROL_DB.prepare(
          `SELECT tracked_query_id, SUM(completed_runs) AS completed_runs
           FROM metric_contributions
           WHERE project_id = ? AND tracking_source = ?
             AND metric_date BETWEEN ? AND ?
           GROUP BY tracked_query_id`,
        )
          .bind(input.projectId, input.source, mentionDates.from, mentionDates.to)
          .all<MentionRateRow>(),
      ]);
    }
    const mentionCount = new Map(
      [...verifiedBrandMentions.bySnapshot.entries()].map(
        ([snapshotId, brandIds]) => [snapshotId, brandIds.size],
      ),
    );
    const rates = new Map(
      mentionRates.results.map((value) => [
        value.tracked_query_id,
        value.completed_runs
          ? ((verifiedBrandMentions.byQuery.get(value.tracked_query_id) ?? 0) /
              value.completed_runs) *
            100
          : 0,
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
          tags: jsonParse<Array<{ id: string; name: string; colorIndex: number }>>(
            row.tags_json,
            [],
          ),
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
        nextCursor: hasMore && rows.length
          ? encodeCursor("analytics-prompts", {
              createdAt: rows.at(-1)!.created_at,
              id: rows.at(-1)!.id,
            })
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
    const readModelState = await requireAnalyticsProjectContext(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const dates = range(input);
    const readModelReady =
      input.source === "chatgpt" && analyticsReadModelSupports(readModelState);
    const sourceCursor = decodeCursor<{
      totalCitations: number;
      domain: string;
    }>(input.cursor, "citation-sources");
    if (
      sourceCursor &&
      (typeof sourceCursor.totalCitations !== "number" ||
        typeof sourceCursor.domain !== "string")
    ) {
      throw new ApiError(400, "invalid_cursor", "The source cursor is invalid.");
    }
    const cursorClause = sourceCursor
      ? `AND (
          SUM(citation_count) < ?
          OR (SUM(citation_count) = ? AND domain > ?)
        )`
      : "";
    const pageBindings: Array<string | number> = [
      input.projectId,
      input.source,
      dates.from,
      dates.to,
    ];
    if (sourceCursor) {
      pageBindings.push(
        sourceCursor.totalCitations,
        sourceCursor.totalCitations,
        sourceCursor.domain,
      );
    }
    pageBindings.push(input.limit + 1);
    if (!sourceCursor && input.offset) {
      pageBindings.push(input.offset);
    }
    const [completedResult, totalResult, pageResult] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT COALESCE(SUM(completed_runs), 0) AS completed
         FROM daily_source_project_metrics
         WHERE project_id = ? AND tracking_source = ?
           AND metric_date BETWEEN ? AND ?`,
      )
        .bind(input.projectId, input.source, dates.from, dates.to)
        .first<{ completed: number }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT COUNT(*) AS total
         FROM (
           SELECT domain
           FROM daily_source_domain_metrics
           WHERE project_id = ? AND tracking_source = ?
             AND metric_date BETWEEN ? AND ?
           GROUP BY domain
           HAVING SUM(citation_count) > 0
         )`,
      )
        .bind(input.projectId, input.source, dates.from, dates.to)
        .first<{ total: number }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT
           domain,
           SUM(cited_snapshot_count) AS cited_snapshots,
           SUM(citation_count) AS total_citations
         FROM daily_source_domain_metrics
         WHERE project_id = ? AND tracking_source = ?
           AND metric_date BETWEEN ? AND ?
         GROUP BY domain
         HAVING SUM(citation_count) > 0
         ${cursorClause}
         ORDER BY total_citations DESC, domain ASC
         LIMIT ?
         ${!sourceCursor && input.offset ? "OFFSET ?" : ""}`,
      )
        .bind(...pageBindings)
        .all<{
          domain: string;
          cited_snapshots: number;
          total_citations: number;
        }>(),
    ]);
    const candidates = pageResult.results;
    const pageRows = candidates.slice(0, input.limit);
    const pageDomains = pageRows.map((row) => row.domain);
    const urls = new Map<string, Set<string>>();
    if (pageDomains.length) {
      if (readModelReady) {
        await c.get("timing").measure("analytics_read_model", async () => {
          const result = await c.env.CONTROL_DB.prepare(
            `SELECT registrable_domain, canonical_url, raw_url
             FROM analytics_citation_occurrences
             WHERE project_id = ?
               AND captured_at >= ?
               AND captured_at < ?
               AND registrable_domain IN (${pageDomains.map(() => "?").join(",")})`,
          )
            .bind(
              input.projectId,
              `${dates.from}T00:00:00.000Z`,
              exclusiveDateEnd(dates.to),
              ...pageDomains,
            )
            .all<{
              registrable_domain: string;
              canonical_url: string | null;
              raw_url: string | null;
            }>();
          for (const source of result.results) {
            const url = source.canonical_url ?? source.raw_url;
            if (!url) continue;
            const set = urls.get(source.registrable_domain) ?? new Set<string>();
            set.add(url);
            urls.set(source.registrable_domain, set);
          }
        });
      } else {
        const indexes = await c.env.CONTROL_DB.prepare(
          `SELECT id, shard_id FROM snapshot_index
           WHERE project_id = ? AND tracking_source = ?
             AND captured_at >= ? AND captured_at < ?`,
        )
          .bind(
            input.projectId,
            input.source,
            `${dates.from}T00:00:00.000Z`,
            exclusiveDateEnd(dates.to),
          )
          .all<{ id: string; shard_id: number }>();
        const grouped = new Map<number, string[]>();
        for (const index of indexes.results) {
          grouped.set(index.shard_id, [
            ...(grouped.get(index.shard_id) ?? []),
            index.id,
          ]);
        }
        await c.get("timing").measure("legacy_shards", () =>
          Promise.all(
            [...grouped.entries()].flatMap(([shardId, ids]) =>
              chunks(ids).map(async (snapshotIds) => {
                const snapshotPlaceholders = snapshotIds.map(() => "?").join(",");
                const domainPlaceholders = pageDomains.map(() => "?").join(",");
                const result = await getShard(c.env, shardId)
                  .prepare(
                    `SELECT registrable_domain, canonical_url, raw_url
                     FROM snapshot_sources
                     WHERE snapshot_id IN (${snapshotPlaceholders})
                       AND registrable_domain IN (${domainPlaceholders})`,
                  )
                  .bind(...snapshotIds, ...pageDomains)
                  .all<{
                    registrable_domain: string | null;
                    canonical_url: string | null;
                    raw_url: string | null;
                  }>();
                for (const source of result.results) {
                  if (!source.registrable_domain) continue;
                  const url = source.canonical_url ?? source.raw_url;
                  if (!url) continue;
                  const set =
                    urls.get(source.registrable_domain) ?? new Set<string>();
                  set.add(url);
                  urls.set(source.registrable_domain, set);
                }
              }),
            ),
          ),
        );
      }
    }
    const completed = Number(completedResult?.completed ?? 0);
    const page = pageRows.map((row) => ({
      domain: row.domain,
      citationRate: completed
        ? (Number(row.cited_snapshots) / completed) * 100
        : 0,
      totalUrls: urls.get(row.domain)?.size ?? 0,
      totalCitations: Number(row.total_citations),
      citedSnapshots: Number(row.cited_snapshots),
    }));
    const lastSource = page.at(-1);
    return c.json({
      data: page,
      page: {
        nextCursor:
          candidates.length > input.limit && lastSource
            ? encodeCursor("citation-sources", {
                totalCitations: lastSource.totalCitations,
                domain: lastSource.domain,
              })
            : null,
        total: Number(totalResult?.total ?? 0),
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
    const readModelState = await requireAnalyticsProjectContext(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const dates = range(input);
    const readModelReady =
      input.source === "chatgpt" && analyticsReadModelSupports(readModelState);
    const [dailyMetrics, indexes] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT
          p.metric_date,
          p.completed_runs,
          COALESCE(d.cited_snapshot_count, 0) AS cited_snapshot_count,
          COALESCE(d.citation_count, 0) AS citation_count
         FROM daily_source_project_metrics p
         LEFT JOIN daily_source_domain_metrics d
           ON d.project_id = p.project_id
          AND d.tracking_source = p.tracking_source
          AND d.metric_date = p.metric_date
          AND d.domain = ?
         WHERE p.project_id = ? AND p.tracking_source = ?
           AND p.metric_date BETWEEN ? AND ?
         ORDER BY p.metric_date`,
      )
        .bind(domain, input.projectId, input.source, dates.from, dates.to)
        .all<{
          metric_date: string;
          completed_runs: number;
          cited_snapshot_count: number;
          citation_count: number;
        }>(),
      readModelReady
        ? Promise.resolve({ results: [] as ProductSnapshotIndex[] })
        : c.env.CONTROL_DB.prepare(
            `SELECT id, shard_id FROM snapshot_index
             WHERE project_id = ? AND tracking_source = ?
               AND captured_at >= ? AND captured_at < ?`,
          )
            .bind(
              input.projectId,
              input.source,
              `${dates.from}T00:00:00.000Z`,
              exclusiveDateEnd(dates.to),
            )
            .all<ProductSnapshotIndex>(),
    ]);
    const grouped = new Map<number, string[]>();
    for (const index of indexes.results) {
      grouped.set(index.shard_id, [...(grouped.get(index.shard_id) ?? []), index.id]);
    }
    const sourceOccurrences = readModelReady
      ? await c
          .get("timing")
          .measure("analytics_read_model", () =>
            loadReadModelCitationOccurrences(
              c.env,
              input.projectId,
              domain,
              `${dates.from}T00:00:00.000Z`,
              exclusiveDateEnd(dates.to),
              input.source,
            ),
          )
      : (
          await c.get("timing").measure("legacy_shards", () =>
            Promise.all(
              [...grouped.entries()].flatMap(([shardId, ids]) =>
                chunks(ids).map(async (snapshotIds) => {
                  const placeholders = snapshotIds.map(() => "?").join(",");
                  return (
                    await getShard(c.env, shardId)
                      .prepare(
                      `SELECT
                        c.snapshot_id,
                        s.tracked_query_id,
                        s.keyword,
                        s.location_code,
                        s.language_code,
                        COALESCE(c.canonical_url, c.raw_url) AS url,
                        c.title,
                        c.source_name,
                        s.captured_at
                       FROM snapshot_sources c
                       JOIN snapshots s ON s.id = c.snapshot_id
                       WHERE c.snapshot_id IN (${placeholders})
                         AND c.registrable_domain = ?`,
                    )
                    .bind(...snapshotIds, domain)
                      .all<CitationSourceOccurrence>()
                  ).results;
                }),
              ),
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
        snapshotIds: Set<string>;
        lastCitedAt: string;
      }
    >();
    for (const source of sourceOccurrences) {
      if (!source.url) continue;
      const existing = urls.get(source.url);
      if (existing) {
        existing.citationCount += 1;
        existing.snapshotIds.add(source.snapshot_id);
        if (source.captured_at > existing.lastCitedAt) {
          existing.lastCitedAt = source.captured_at;
          existing.title = source.title ?? existing.title;
          existing.sourceName = source.source_name ?? existing.sourceName;
        }
      } else {
        urls.set(source.url, {
          url: source.url,
          title: source.title,
          sourceName: source.source_name,
          citationCount: 1,
          snapshotIds: new Set([source.snapshot_id]),
          lastCitedAt: source.captured_at,
        });
      }
    }
    const promptMap = new Map<
      string,
      {
        queryId: string;
        prompt: string;
        locationCode: number;
        languageCode: string;
        citationCount: number;
        snapshotIds: Set<string>;
        urls: Set<string>;
        latestSnapshotId: string;
        lastCitedAt: string;
      }
    >();
    for (const source of sourceOccurrences) {
      const existing = promptMap.get(source.tracked_query_id);
      if (existing) {
        existing.citationCount += 1;
        existing.snapshotIds.add(source.snapshot_id);
        if (source.url) existing.urls.add(source.url);
        if (source.captured_at > existing.lastCitedAt) {
          existing.latestSnapshotId = source.snapshot_id;
          existing.lastCitedAt = source.captured_at;
          existing.prompt = source.keyword;
          existing.locationCode = source.location_code;
          existing.languageCode = source.language_code;
        }
        continue;
      }
      promptMap.set(source.tracked_query_id, {
        queryId: source.tracked_query_id,
        prompt: source.keyword,
        locationCode: source.location_code,
        languageCode: source.language_code,
        citationCount: 1,
        snapshotIds: new Set([source.snapshot_id]),
        urls: new Set(source.url ? [source.url] : []),
        latestSnapshotId: source.snapshot_id,
        lastCitedAt: source.captured_at,
      });
    }
    const prompts = [...promptMap.values()]
      .map(({ snapshotIds, urls: citedUrls, ...prompt }) => ({
        ...prompt,
        citedSnapshots: snapshotIds.size,
        citedUrls: citedUrls.size,
      }))
      .sort(
        (left, right) =>
          right.citationCount - left.citationCount ||
          right.citedSnapshots - left.citedSnapshots ||
          right.lastCitedAt.localeCompare(left.lastCitedAt) ||
          left.prompt.localeCompare(right.prompt),
      );
    const rankedUrls = [...urls.values()]
      .map(({ snapshotIds, ...source }) => ({
        url: source.url,
        title: source.title,
        sourceName: source.sourceName,
        citationCount: source.citationCount,
        citedSnapshots: snapshotIds.size,
        lastCitedAt: source.lastCitedAt,
      }))
      .sort(
        (left, right) =>
          right.citationCount - left.citationCount ||
          right.lastCitedAt.localeCompare(left.lastCitedAt) ||
          left.url.localeCompare(right.url),
      );
    const urlCursor = decodeCursor<{
      citationCount: number;
      lastCitedAt: string;
      url: string;
    }>(input.cursor, "citation-source-urls");
    if (
      urlCursor &&
      (typeof urlCursor.citationCount !== "number" ||
        typeof urlCursor.lastCitedAt !== "string" ||
        typeof urlCursor.url !== "string")
    ) {
      throw new ApiError(400, "invalid_cursor", "The cited URL cursor is invalid.");
    }
    const afterCursor = urlCursor
      ? rankedUrls.filter(
          (source) =>
            source.citationCount < urlCursor.citationCount ||
            (source.citationCount === urlCursor.citationCount &&
              (source.lastCitedAt < urlCursor.lastCitedAt ||
                (source.lastCitedAt === urlCursor.lastCitedAt &&
                  source.url.localeCompare(urlCursor.url) > 0))),
        )
      : rankedUrls;
    const start = !urlCursor ? input.offset ?? 0 : 0;
    const candidates = afterCursor.slice(start, start + input.limit + 1);
    const page = candidates.slice(0, input.limit);
    const lastUrl = page.at(-1);
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
          totalPrompts: prompts.length,
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
        prompts,
        urls: page,
      },
      page: {
        nextCursor:
          candidates.length > input.limit && lastUrl
            ? encodeCursor("citation-source-urls", {
                citationCount: lastUrl.citationCount,
                lastCitedAt: lastUrl.lastCitedAt,
                url: lastUrl.url,
              })
            : null,
        total: rankedUrls.length,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/shopping",
  zValidator("query", ShoppingAnalyticsSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    const readModelState = await requireAnalyticsProjectContext(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const dates = range(input);
    const readModelReady =
      input.source === "chatgpt" && analyticsReadModelSupports(readModelState);
    const indexes = readModelReady
      ? { results: [] as ProductSnapshotIndex[] }
      : await c.env.CONTROL_DB.prepare(
          `SELECT id, shard_id FROM snapshot_index
           WHERE project_id = ? AND tracking_source = ?
             AND captured_at >= ? AND captured_at < ?
             AND products_count > 0 ORDER BY captured_at DESC`,
        )
          .bind(
            input.projectId,
            input.source,
            `${dates.from}T00:00:00.000Z`,
            exclusiveDateEnd(dates.to),
          )
          .all<ProductSnapshotIndex>();
    let matchingPromptIds: Set<string> | null = null;
    if (input.tagIds?.length) {
      const tagPlaceholders = input.tagIds.map(() => "?").join(",");
      const promptRows = await c.env.CONTROL_DB.prepare(
        `SELECT q.id
         FROM tracked_queries q
         JOIN tracked_query_tags qt ON qt.tracked_query_id = q.id
         JOIN prompt_tags t ON t.id = qt.tag_id
         WHERE q.project_id = ? AND q.deleted_at IS NULL
           AND t.project_id = ?
           AND t.id IN (${tagPlaceholders})
         GROUP BY q.id
         HAVING COUNT(DISTINCT t.id) = ?`,
      )
        .bind(
          input.projectId,
          input.projectId,
          ...input.tagIds,
          input.tagIds.length,
        )
        .all<{ id: string }>();
      matchingPromptIds = new Set(promptRows.results.map((row) => row.id));
      if (!matchingPromptIds.size) {
        return c.json({
          data: [],
          page: { nextCursor: null, total: 0 },
        });
      }
    }
    const normalizedSearch = input.search?.toLocaleLowerCase();
    const occurrences = (
      readModelReady
        ? await c
            .get("timing")
            .measure("analytics_read_model", () =>
              loadReadModelShoppingProductOccurrences(
                c.env,
                input.projectId,
                `${dates.from}T00:00:00.000Z`,
                exclusiveDateEnd(dates.to),
                undefined,
                input.source,
              ),
            )
        : await c
            .get("timing")
            .measure("legacy_shards", () =>
              loadShoppingProductOccurrences(c.env, indexes.results),
            )
    ).filter((occurrence) => {
      if (
        input.locationCode !== undefined &&
        occurrence.location_code !== input.locationCode
      ) {
        return false;
      }
      if (
        matchingPromptIds &&
        !matchingPromptIds.has(occurrence.tracked_query_id)
      ) {
        return false;
      }
      if (!normalizedSearch) return true;
      return [
        occurrence.title,
        occurrence.merchants,
        occurrence.registrable_domain,
      ].some((value) =>
        value?.toLocaleLowerCase().includes(normalizedSearch),
      );
    });
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
    const enrichedRows = products.size
      ? await c.env.CONTROL_DB.prepare(
          `SELECT DISTINCT product_identity
           FROM product_enrichment_targets
           WHERE project_id = ? AND latest_snapshot_id IS NOT NULL`,
        )
          .bind(input.projectId)
          .all<{ product_identity: string }>()
      : { results: [] as Array<{ product_identity: string }> };
    const enrichedIdentities = new Set(
      enrichedRows.results.map((row) => row.product_identity),
    );
    const sortedProducts = [...products.values()]
      .map((product) => {
        const identity = productIdentity(product);
        return {
          ...product,
          identity,
          enriched: enrichedIdentities.has(identity),
        };
      })
      .filter((product) =>
        input.enrichment === "enriched"
          ? product.enriched
          : input.enrichment === "not_enriched"
            ? !product.enriched
            : true,
      )
      .sort(
        (left, right) =>
          right.appearances - left.appearances ||
          right.captured_at.localeCompare(left.captured_at) ||
          left.identity.localeCompare(right.identity),
      );
    const shoppingCursor = decodeCursor<{
      appearances: number;
      capturedAt: string;
      key: string;
    }>(input.cursor, "shopping");
    if (
      shoppingCursor &&
      (typeof shoppingCursor.appearances !== "number" ||
        typeof shoppingCursor.capturedAt !== "string" ||
        typeof shoppingCursor.key !== "string")
    ) {
      throw new ApiError(400, "invalid_cursor", "The shopping cursor is invalid.");
    }
    const afterCursor = shoppingCursor
      ? sortedProducts.filter(
          (product) =>
            product.appearances < shoppingCursor.appearances ||
            (product.appearances === shoppingCursor.appearances &&
              (product.captured_at < shoppingCursor.capturedAt ||
                (product.captured_at === shoppingCursor.capturedAt &&
                  product.identity.localeCompare(shoppingCursor.key) > 0))),
        )
      : sortedProducts;
    const start = !shoppingCursor ? input.offset ?? 0 : 0;
    const candidates = afterCursor.slice(start, start + input.limit + 1);
    const page = candidates.slice(0, input.limit);
    const lastProduct = page.at(-1);
    return c.json({
      data: page.map(serializedShoppingProduct),
      page: {
        nextCursor:
          candidates.length > input.limit && lastProduct
            ? encodeCursor("shopping", {
                appearances: lastProduct.appearances,
                capturedAt: lastProduct.captured_at,
                key: lastProduct.identity,
              })
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
    const readModelState = await requireAnalyticsProjectContext(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const identity = productIdentityFromKey(routeProductKey);
    if (!identity) {
      throw new ApiError(404, "product_not_found", "Product not found.");
    }
    const dates = productAnalyticsDateRange(input.period);
    const previousDates = productAnalyticsComparisonDateRange(input.period);
    const readModelReady = analyticsReadModelSupports(readModelState);
    const [indexes, projectMetrics, previousIndexes, previousProjectMetrics] = await Promise.all([
      readModelReady
        ? Promise.resolve({ results: [] as ProductSnapshotIndex[] })
        : c.env.CONTROL_DB.prepare(
            `SELECT id, shard_id FROM snapshot_index
             WHERE project_id = ? AND tracking_source = ?
               AND captured_at >= ? AND captured_at < ?
               AND products_count > 0
             ORDER BY captured_at DESC`,
          )
            .bind(
              input.projectId,
              input.source,
              dates.startTimestamp,
              dates.endExclusiveTimestamp,
            )
            .all<ProductSnapshotIndex>(),
      c.env.CONTROL_DB.prepare(
        `SELECT metric_date, completed_runs
         FROM daily_source_project_metrics
         WHERE project_id = ? AND tracking_source = ?
           AND metric_date BETWEEN ? AND ?
         ORDER BY metric_date`,
      )
        .bind(input.projectId, input.source, dates.from, dates.to)
        .all<{ metric_date: string; completed_runs: number }>(),
      readModelReady
        ? Promise.resolve({ results: [] as ProductSnapshotIndex[] })
        : c.env.CONTROL_DB.prepare(
            `SELECT id, shard_id FROM snapshot_index
             WHERE project_id = ? AND tracking_source = ?
               AND captured_at >= ? AND captured_at < ?
               AND products_count > 0
             ORDER BY captured_at DESC`,
          )
            .bind(
              input.projectId,
              input.source,
              previousDates.startTimestamp,
              previousDates.endExclusiveTimestamp,
            )
            .all<ProductSnapshotIndex>(),
      c.env.CONTROL_DB.prepare(
        `SELECT metric_date, completed_runs
         FROM daily_source_project_metrics
         WHERE project_id = ? AND tracking_source = ?
           AND metric_date BETWEEN ? AND ?
         ORDER BY metric_date`,
      )
        .bind(
          input.projectId,
          input.source,
          previousDates.from,
          previousDates.to,
        )
        .all<{ metric_date: string; completed_runs: number }>(),
    ]);
    const [currentOccurrenceRows, previousOccurrenceRows] = await Promise.all([
      readModelReady
        ? c.get("timing").measure("analytics_read_model", () =>
            loadReadModelShoppingProductOccurrences(
              c.env,
              input.projectId,
              dates.startTimestamp,
              dates.endExclusiveTimestamp,
              identity,
              input.source,
            ),
          )
        : c.get("timing").measure("legacy_shards", () =>
            loadShoppingProductOccurrences(c.env, indexes.results, identity),
          ),
      readModelReady
        ? c.get("timing").measure("analytics_comparison_read_model", () =>
            loadReadModelShoppingProductOccurrences(
              c.env,
              input.projectId,
              previousDates.startTimestamp,
              previousDates.endExclusiveTimestamp,
              identity,
              input.source,
            ),
          )
        : c.get("timing").measure("legacy_comparison_shards", () =>
            loadShoppingProductOccurrences(
              c.env,
              previousIndexes.results,
              identity,
            ),
          ),
    ]);
    const occurrences = currentOccurrenceRows
      .filter((occurrence) => productIdentity(occurrence) === identity)
      .sort(
        (left, right) =>
          right.captured_at.localeCompare(left.captured_at) ||
          right.id.localeCompare(left.id),
      );
    const previousOccurrences = previousOccurrenceRows
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
    const previousCompletedRuns = previousProjectMetrics.results.reduce(
      (total, metric) => total + (Number(metric.completed_runs) || 0),
      0,
    );
    const performance = summarizeProductPerformance(occurrences, completedRuns);
    const previousPerformance = summarizeProductPerformance(
      previousOccurrences,
      previousCompletedRuns,
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
    const latest = occurrences[0]!;
    const priceSummary = summarizeProductPrices(occurrences);
    const previousPriceSummary = summarizeProductPrices(previousOccurrences);
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
    const previousRatingOccurrence = previousOccurrences.find(
      (occurrence) =>
        occurrence.rating_value !== null ||
        occurrence.rating_votes_count !== null,
    );
    const comparablePreviousPrice =
      priceSummary &&
      previousPriceSummary &&
      priceSummary.currency === previousPriceSummary.currency
        ? previousPriceSummary.latest
        : null;
    const comparablePreviousRating =
      ratingSummary &&
      previousRatingOccurrence &&
      ratingSummary.maximum === previousRatingOccurrence.rating_max
        ? previousRatingOccurrence.rating_value
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
      winningCaptures: number;
      appearances: number;
      appearanceRate: number;
      winRate: number | null;
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
      const dayCompletedRuns = completedByDate.get(date) ?? 0;
      const dayPerformance = summarizeProductPerformance(
        day,
        dayCompletedRuns,
      );
      visibilityTrend.push({
        date,
        completedRuns: dayCompletedRuns,
        appearingCaptures: dayPerformance.appearingCaptures,
        winningCaptures: dayPerformance.winningCaptures,
        appearances: dayPerformance.appearances,
        appearanceRate: dayPerformance.appearanceRate,
        winRate: dayPerformance.appearingCaptures
          ? dayPerformance.winRate
          : null,
        averagePosition: dayPerformance.averagePosition,
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

    const occurrenceCursor = decodeCursor<{
      capturedAt: string;
      id: string;
    }>(input.cursor, "shopping-product-occurrences");
    if (
      occurrenceCursor &&
      (typeof occurrenceCursor.capturedAt !== "string" ||
        typeof occurrenceCursor.id !== "string")
    ) {
      throw new ApiError(
        400,
        "invalid_cursor",
        "The product observation cursor is invalid.",
      );
    }
    const afterCursor = occurrenceCursor
      ? occurrences.filter(
          (occurrence) =>
            occurrence.captured_at < occurrenceCursor.capturedAt ||
            (occurrence.captured_at === occurrenceCursor.capturedAt &&
              occurrence.id < occurrenceCursor.id),
        )
      : occurrences;
    const start = !occurrenceCursor ? input.offset ?? 0 : 0;
    const occurrenceCandidates = afterCursor.slice(
      start,
      start + input.limit + 1,
    );
    const occurrencePage = occurrenceCandidates.slice(0, input.limit);
    const lastOccurrence = occurrencePage.at(-1);
    const targetSnapshotIds = new Set(
      occurrences.map((occurrence) => occurrence.snapshot_id),
    );
    const [market, coFeaturedOccurrences] = await Promise.all([
      loadProductMarket(
        c.env,
        input.projectId,
        identity,
        dates,
        occurrences,
        {
          locationCode: input.marketLocationCode,
          languageCode: input.marketLanguageCode,
        },
      ),
      readModelReady
        ? c.get("timing").measure("analytics_product_competition", () =>
            loadReadModelCoFeaturedProductOccurrences(
              c.env,
              input.projectId,
              dates.startTimestamp,
              dates.endExclusiveTimestamp,
              identity,
              input.source,
            ),
          )
        : c.get("timing").measure("legacy_product_competition", () =>
            loadShoppingProductOccurrences(
              c.env,
              indexes.results.filter((index) => targetSnapshotIds.has(index.id)),
            ),
          ),
    ]);
    const competition = buildProductCompetition(
      identity,
      occurrences,
      coFeaturedOccurrences,
    );
    return c.json({
      data: {
        product: serializedShoppingProduct(latest),
        range: { from: dates.from, to: dates.to, period: input.period },
        summary: {
          completedRuns,
          appearingCaptures: performance.appearingCaptures,
          winningCaptures: performance.winningCaptures,
          appearanceRate: performance.appearanceRate,
          winRate: performance.winRate,
          appearances: performance.appearances,
          prompts: promptIds.size,
          merchants: merchantLabels.size,
          firstSeen: occurrences.at(-1)?.captured_at ?? latest.captured_at,
          latestSeen: latest.captured_at,
          latestPosition: latest.ordinal + 1,
          averagePosition: performance.averagePosition,
          price: priceSummary,
          rating: ratingSummary,
          comparison: {
            range: {
              from: previousDates.from,
              to: previousDates.to,
            },
            appearanceRate: {
              previous: previousCompletedRuns
                ? previousPerformance.appearanceRate
                : null,
              delta: previousCompletedRuns
                ? performance.appearanceRate -
                  previousPerformance.appearanceRate
                : null,
            },
            winRate: {
              previous: previousPerformance.appearingCaptures
                ? previousPerformance.winRate
                : null,
              delta: previousPerformance.appearingCaptures
                ? performance.winRate - previousPerformance.winRate
                : null,
            },
            averagePosition: {
              previous: previousPerformance.averagePosition,
              delta:
                performance.averagePosition !== null &&
                previousPerformance.averagePosition !== null
                  ? performance.averagePosition -
                    previousPerformance.averagePosition
                  : null,
            },
            appearances: {
              previous: previousPerformance.appearances,
              delta:
                performance.appearances - previousPerformance.appearances,
            },
            price: priceSummary
              ? {
                  currency: priceSummary.currency,
                  previous: comparablePreviousPrice,
                  delta:
                    comparablePreviousPrice === null ||
                    priceSummary.latest === null
                      ? null
                      : priceSummary.latest - comparablePreviousPrice,
                  deltaPercent:
                    comparablePreviousPrice && priceSummary.latest !== null
                      ? ((priceSummary.latest - comparablePreviousPrice) /
                          comparablePreviousPrice) *
                        100
                      : null,
                }
              : null,
            rating: ratingSummary
              ? {
                  previousValue: comparablePreviousRating,
                  valueDelta:
                    comparablePreviousRating === null ||
                    ratingSummary.value === null
                      ? null
                      : ratingSummary.value - comparablePreviousRating,
                  previousReviews:
                    previousRatingOccurrence?.rating_votes_count ?? null,
                  reviewsDelta:
                    previousRatingOccurrence?.rating_votes_count === null ||
                    previousRatingOccurrence?.rating_votes_count === undefined ||
                    ratingSummary.reviews === null
                      ? null
                      : ratingSummary.reviews -
                        previousRatingOccurrence.rating_votes_count,
                }
              : null,
          },
        },
        visibilityTrend,
        priceTrend,
        reviewTrend,
        prompts,
        merchants,
        competition,
        market,
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
          occurrenceCandidates.length > input.limit && lastOccurrence
            ? encodeCursor("shopping-product-occurrences", {
                capturedAt: lastOccurrence.captured_at,
                id: lastOccurrence.id,
              })
            : null,
        total: occurrences.length,
      },
    });
  },
);

analyticsRoutes.post(
  "/analytics/shopping/:productKey/enrichment/touch",
  zValidator("param", ShoppingProductParamSchema),
  zValidator("json", ProductEnrichmentRequestSchema),
  async (c) => {
    const principal = c.get("principal");
    const { productKey: routeProductKey } = c.req.valid("param");
    const input = c.req.valid("json");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId, c.get("timing"));
    const identity = productIdentityFromKey(routeProductKey);
    if (!identity) throw new ApiError(404, "product_not_found", "Product not found.");
    const occurrence = await latestEnrichmentOccurrence(
      c.env,
      input.projectId,
      identity,
      input.locationCode,
      input.languageCode,
    );
    if (!occurrence || occurrence.workspace_id !== principal.workspaceId) {
      throw new ApiError(404, "product_not_found", "Product not found for this locale.");
    }
    const result = await ensureProductEnrichmentTarget(c.env, {
      workspaceId: principal.workspaceId,
      projectId: input.projectId,
      productIdentity: identity,
      productKey: occurrence.product_key,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      productIds: jsonParse<unknown[]>(occurrence.product_ids_json, []),
      activity: "view",
    });
    return c.json({ data: { targetId: result.target.id, jobId: result.jobId, status: result.status } }, 202);
  },
);

analyticsRoutes.post(
  "/analytics/shopping/:productKey/enrichment/refresh",
  zValidator("param", ShoppingProductParamSchema),
  zValidator("json", ProductEnrichmentRequestSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { productKey: routeProductKey } = c.req.valid("param");
    const input = c.req.valid("json");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId, c.get("timing"));
    const identity = productIdentityFromKey(routeProductKey);
    if (!identity) throw new ApiError(404, "product_not_found", "Product not found.");
    const occurrence = await latestEnrichmentOccurrence(
      c.env,
      input.projectId,
      identity,
      input.locationCode,
      input.languageCode,
    );
    if (!occurrence || occurrence.workspace_id !== principal.workspaceId) {
      throw new ApiError(404, "product_not_found", "Product not found for this locale.");
    }
    const ensured = await ensureProductEnrichmentTarget(c.env, {
      workspaceId: principal.workspaceId,
      projectId: input.projectId,
      productIdentity: identity,
      productKey: occurrence.product_key,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      productIds: jsonParse<unknown[]>(occurrence.product_ids_json, []),
      activity: "view",
      queue: false,
    });
    const result = await requestTargetRefresh(c.env, ensured.target.id, true);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "product_enrichment.manual_refresh_requested",
      resourceType: "product",
      resourceId: routeProductKey,
    });
    return c.json({ data: { targetId: ensured.target.id, ...result } }, 202);
  },
);

analyticsRoutes.patch(
  "/analytics/shopping/:productKey/enrichment",
  zValidator("param", ShoppingProductParamSchema),
  zValidator("json", ProductEnrichmentPreferenceSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { productKey: routeProductKey } = c.req.valid("param");
    const input = c.req.valid("json");
    await assertProjectAccess(c.env, principal.workspaceId, input.projectId, c.get("timing"));
    const identity = productIdentityFromKey(routeProductKey);
    if (!identity) throw new ApiError(404, "product_not_found", "Product not found.");
    const updatedAt = new Date().toISOString();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO product_enrichment_preferences (
        project_id, product_identity, automatic_refresh_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, product_identity) DO UPDATE SET
        automatic_refresh_enabled = excluded.automatic_refresh_enabled,
        updated_at = excluded.updated_at`,
    )
      .bind(
        input.projectId,
        identity,
        input.automaticRefreshEnabled ? 1 : 0,
        updatedAt,
        updatedAt,
      )
      .run();
    if (!input.automaticRefreshEnabled) {
      await c.env.CONTROL_DB.batch([
        c.env.CONTROL_DB.prepare(
          `UPDATE product_enrichment_jobs SET status = 'cancelled', active_slot = NULL,
            error_code = 'product_paused', error_message = 'Automatic enrichment is paused for this product.',
            updated_at = ?
           WHERE project_id = ? AND product_identity = ? AND reason != 'manual'
             AND status IN ('queued', 'submission_unknown')`,
        ).bind(updatedAt, input.projectId, identity),
        c.env.CONTROL_DB.prepare(
          `UPDATE product_enrichment_targets SET
            status = CASE WHEN latest_snapshot_id IS NULL THEN 'paused' ELSE 'available' END,
            current_job_id = CASE
              WHEN current_job_id IN (
                SELECT id FROM product_enrichment_jobs
                WHERE project_id = ? AND product_identity = ? AND status = 'cancelled'
              ) THEN NULL ELSE current_job_id END,
            updated_at = ? WHERE project_id = ? AND product_identity = ?`,
        ).bind(input.projectId, identity, updatedAt, input.projectId, identity),
      ]);
    } else {
      const targets = await c.env.CONTROL_DB.prepare(
        `SELECT id FROM product_enrichment_targets
         WHERE project_id = ? AND product_identity = ?`,
      )
        .bind(input.projectId, identity)
        .all<{ id: string }>();
      for (const target of targets.results) await requestTargetRefresh(c.env, target.id, false);
    }
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: input.automaticRefreshEnabled
        ? "product_enrichment.resumed"
        : "product_enrichment.paused",
      resourceType: "product",
      resourceId: routeProductKey,
    });
    return c.json({ data: { automaticRefreshEnabled: input.automaticRefreshEnabled } });
  },
);

analyticsRoutes.get(
  "/analytics/brands",
  zValidator("query", TrackedBrandAnalyticsSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const dates = range(input);
    const clauses = ["brand.project_id = ?"];
    const filterBindings: Array<string | number> = [input.projectId];
    if (input.search) {
      clauses.push("LOWER(brand.name) LIKE ?");
      filterBindings.push(`%${input.search.toLocaleLowerCase()}%`);
    }
    if (input.kind) {
      clauses.push("brand.kind = ?");
      filterBindings.push(input.kind);
    }
    const brandCursor = decodeCursor<{
      kindRank: number;
      mentionedSnapshotCount: number;
      name: string;
      id: string;
    }>(input.cursor, "analytics-brands");
    if (
      brandCursor &&
      (typeof brandCursor.kindRank !== "number" ||
        typeof brandCursor.mentionedSnapshotCount !== "number" ||
        typeof brandCursor.name !== "string" ||
        typeof brandCursor.id !== "string")
    ) {
      throw new ApiError(400, "invalid_cursor", "The tracked entity cursor is invalid.");
    }
    const cursorClause = brandCursor
      ? `WHERE kind_rank > ?
          OR (kind_rank = ? AND mentioned_snapshot_count < ?)
          OR (kind_rank = ? AND mentioned_snapshot_count = ? AND name > ?)
          OR (kind_rank = ? AND mentioned_snapshot_count = ? AND name = ? AND id > ?)`
      : "";
    const cursorBindings = brandCursor
      ? [
          brandCursor.kindRank,
          brandCursor.kindRank,
          brandCursor.mentionedSnapshotCount,
          brandCursor.kindRank,
          brandCursor.mentionedSnapshotCount,
          brandCursor.name,
          brandCursor.kindRank,
          brandCursor.mentionedSnapshotCount,
          brandCursor.name,
          brandCursor.id,
        ]
      : [];
    const [totalResult, pageResult] = await c.get("timing").measureD1(
      "brand_metrics_page_db",
      () => c.env.CONTROL_DB.batch([
        c.env.CONTROL_DB.prepare(
          `SELECT COUNT(*) AS total FROM tracked_brands AS brand
           WHERE ${clauses.join(" AND ")}`,
        ).bind(...filterBindings),
        c.env.CONTROL_DB.prepare(
          `WITH brand_page AS (
             SELECT brand.id, brand.name, brand.kind,
               CASE brand.kind WHEN 'owned' THEN 0 ELSE 1 END AS kind_rank,
               COALESCE(SUM(metric.mentioned_snapshot_count), 0) AS mentioned_snapshot_count
             FROM tracked_brands AS brand
             LEFT JOIN daily_source_brand_metrics AS metric
               ON metric.project_id = brand.project_id
              AND metric.tracking_source = ?
              AND metric.tracked_brand_id = brand.id
              AND metric.metric_date BETWEEN ? AND ?
             WHERE ${clauses.join(" AND ")}
             GROUP BY brand.id, brand.name, brand.kind
           )
           SELECT id, name, kind, kind_rank, mentioned_snapshot_count
           FROM brand_page
           ${cursorClause}
           ORDER BY kind_rank, mentioned_snapshot_count DESC, name, id
           LIMIT ?`,
        ).bind(
          input.source,
          dates.from,
          dates.to,
          ...filterBindings,
          ...cursorBindings,
          input.limit + 1,
        ),
      ]),
    );
    const total = Number(
      (totalResult?.results[0] as { total?: number } | undefined)?.total ?? 0,
    );
    if (!pageResult) throw new Error("Tracked entity query returned no page result.");
    const candidates = pageResult.results as Array<{
      id: string;
      name: string;
      kind: "owned" | "competitor";
      kind_rank: number;
      mentioned_snapshot_count: number;
    }>;
    const hasMore = candidates.length > input.limit;
    const rows = candidates.slice(0, input.limit);
    const last = rows.at(-1);
    return c.json({
      data: rows,
      page: {
        nextCursor: hasMore && last
          ? encodeCursor("analytics-brands", {
              kindRank: Number(last.kind_rank),
              mentionedSnapshotCount: Number(last.mentioned_snapshot_count),
              name: last.name,
              id: last.id,
            })
          : null,
        total,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/entities",
  zValidator("query", EntityAnalyticsSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const dates = range(input);
    const clauses = [
      "entity.project_id = ?",
      "entity.status != 'merged'",
      input.status === "all"
        ? "entity.status IN ('candidate', 'ignored')"
        : "entity.status = ?",
      `(entity.status = 'ignored' OR EXISTS (
         SELECT 1 FROM entity_mentions active_mention
         WHERE active_mention.entity_id = entity.id
           AND active_mention.extractor_version = project.active_entity_extractor_version
       ))`,
    ];
    const filterBindings: Array<string | number> = [input.projectId];
    if (input.status !== "all") filterBindings.push(input.status);
    if (input.search) {
      clauses.push("LOWER(entity.canonical_name) LIKE ?");
      filterBindings.push(`%${input.search.toLocaleLowerCase()}%`);
    }
    if (input.group === "brands") clauses.push("entity.entity_type = 'brand'");
    if (input.group === "companies") {
      clauses.push("entity.entity_type IN ('company', 'organization')");
    }
    if (input.group === "places") clauses.push("entity.entity_type = 'place'");
    if (input.group === "other") {
      clauses.push(
        "entity.entity_type NOT IN ('brand', 'company', 'organization', 'place')",
      );
    }
    const entityCursor = decodeCursor<{
      groupRank: number;
      periodSnapshotCount: number;
      name: string;
      id: string;
    }>(input.cursor, "analytics-entities");
    if (
      entityCursor &&
      (typeof entityCursor.groupRank !== "number" ||
        typeof entityCursor.periodSnapshotCount !== "number" ||
        typeof entityCursor.name !== "string" ||
        typeof entityCursor.id !== "string")
    ) {
      throw new ApiError(400, "invalid_cursor", "The discovered entity cursor is invalid.");
    }
    const cursorClause = entityCursor
      ? `WHERE group_rank > ?
          OR (group_rank = ? AND period_snapshot_count < ?)
          OR (group_rank = ? AND period_snapshot_count = ? AND canonical_name > ?)
          OR (group_rank = ? AND period_snapshot_count = ? AND canonical_name = ? AND id > ?)`
      : "";
    const cursorBindings = entityCursor
      ? [
          entityCursor.groupRank,
          entityCursor.groupRank,
          entityCursor.periodSnapshotCount,
          entityCursor.groupRank,
          entityCursor.periodSnapshotCount,
          entityCursor.name,
          entityCursor.groupRank,
          entityCursor.periodSnapshotCount,
          entityCursor.name,
          entityCursor.id,
        ]
      : [];
    const start = `${dates.from}T00:00:00.000Z`;
    const end = exclusiveDateEnd(dates.to);
    const [totalResult, pageResult] = await c.get("timing").measureD1(
      "entities_page_db",
      () => c.env.CONTROL_DB.batch([
        c.env.CONTROL_DB.prepare(
          `SELECT COUNT(*) AS total
           FROM project_entities entity
           JOIN projects project ON project.id = entity.project_id
           WHERE ${clauses.join(" AND ")}`,
        ).bind(...filterBindings),
        c.env.CONTROL_DB.prepare(
          `WITH entity_page AS (
           SELECT entity.id, entity.canonical_name, entity.entity_type,
        CASE entity.entity_type
          WHEN 'brand' THEN 0
          WHEN 'company' THEN 1
          WHEN 'organization' THEN 1
          WHEN 'place' THEN 2
          ELSE 3
        END AS group_rank,
        COALESCE((
          SELECT latest_relationship.relationship FROM entity_mentions latest_relationship
          WHERE latest_relationship.entity_id = entity.id
            AND latest_relationship.extractor_version = project.active_entity_extractor_version
          ORDER BY latest_relationship.captured_at DESC, latest_relationship.id DESC LIMIT 1
        ), entity.relationship) AS relationship,
        entity.status, entity.aliases_json, entity.domains_json,
        entity.provider_corroborated, entity.domain_corroborated,
        entity.snapshot_count, entity.prompt_count,
        entity.competitor_snapshot_count, entity.competitor_prompt_count,
        entity.first_seen_at, entity.last_seen_at, entity.tracked_brand_id,
        COUNT(DISTINCT mention.snapshot_id) AS period_snapshot_count,
        COUNT(DISTINCT mention.tracked_query_id) AS period_prompt_count,
        MAX(mention.confidence) AS confidence,
        CASE
          WHEN SUM(CASE WHEN mention.evidence_tier = 'strong' THEN 1 ELSE 0 END) > 0 THEN 'strong'
          WHEN SUM(CASE WHEN mention.evidence_tier = 'moderate' THEN 1 ELSE 0 END) > 0 THEN 'moderate'
          ELSE 'weak'
        END AS evidence_tier,
        (
          SELECT latest.evidence_json FROM entity_mentions latest
          WHERE latest.entity_id = entity.id
            AND latest.extractor_version = project.active_entity_extractor_version
            AND latest.captured_at >= ? AND latest.captured_at < ?
          ORDER BY latest.captured_at DESC, latest.id DESC
          LIMIT 1
        ) AS latest_evidence_json,
        (
          SELECT latest.relationship_reason FROM entity_mentions latest
          WHERE latest.entity_id = entity.id
            AND latest.extractor_version = project.active_entity_extractor_version
            AND latest.captured_at >= ? AND latest.captured_at < ?
          ORDER BY latest.captured_at DESC, latest.id DESC
          LIMIT 1
        ) AS relationship_reason,
        (
          SELECT latest.sources_json FROM entity_mentions latest
          WHERE latest.entity_id = entity.id
            AND latest.extractor_version = project.active_entity_extractor_version
            AND latest.captured_at >= ? AND latest.captured_at < ?
          ORDER BY latest.captured_at DESC, latest.id DESC
          LIMIT 1
        ) AS latest_sources_json
       FROM project_entities entity
       JOIN projects project ON project.id = entity.project_id
       LEFT JOIN entity_mentions mention ON mention.entity_id = entity.id
         AND mention.extractor_version = project.active_entity_extractor_version
         AND mention.captured_at >= ? AND mention.captured_at < ?
       WHERE ${clauses.join(" AND ")}
       GROUP BY entity.id
       )
       SELECT * FROM entity_page
       ${cursorClause}
       ORDER BY group_rank, period_snapshot_count DESC, canonical_name, id
       LIMIT ?`,
        ).bind(
          start,
          end,
          start,
          end,
          start,
          end,
          start,
          end,
          ...filterBindings,
          ...cursorBindings,
          input.limit + 1,
        ),
      ]),
    );
    const total = Number(
      (totalResult?.results[0] as { total?: number } | undefined)?.total ?? 0,
    );
    if (!pageResult) throw new Error("Discovered entity query returned no page result.");
    const candidates = pageResult.results as Array<Record<string, unknown> & {
      id: string;
      canonical_name: string;
      group_rank: number;
      period_snapshot_count: number;
      aliases_json: string;
      domains_json: string;
      latest_evidence_json: string | null;
      latest_sources_json: string | null;
    }>;
    const hasMore = candidates.length > input.limit;
    const rows = candidates.slice(0, input.limit);
    const last = rows.at(-1);
    return c.json({
      data: rows.map((entity) => ({
        ...entity,
        aliases: jsonParse<string[]>(entity.aliases_json, []),
        domains: jsonParse<string[]>(entity.domains_json, []),
        latestEvidence: jsonParse<string[]>(entity.latest_evidence_json, []),
        evidenceTier: entity.evidence_tier,
        relationshipReason: entity.relationship_reason,
        latestSources: jsonParse<string[]>(entity.latest_sources_json, []),
      })),
      page: {
        nextCursor: hasMore && last
          ? encodeCursor("analytics-entities", {
              groupRank: Number(last.group_rank),
              periodSnapshotCount: Number(last.period_snapshot_count),
              name: last.canonical_name,
              id: last.id,
            })
          : null,
        total,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/products",
  zValidator("query", DateRangeSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const dates = range(input);
    const indexes = await c.env.CONTROL_DB.prepare(
      `SELECT id, shard_id FROM snapshot_index
       WHERE project_id = ? AND tracking_source = ?
         AND captured_at >= ? AND captured_at < ?
         AND products_count > 0
       ORDER BY captured_at DESC LIMIT 500`,
    )
      .bind(
        input.projectId,
        input.source,
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
      source: TrackingSourceSchema.default("chatgpt"),
      queryId: z.string().uuid().optional(),
      cursor: z.string().max(4096).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  ),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    await assertProjectAccess(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const clauses = ["s.project_id = ?", "s.tracking_source = ?"];
    const bindings: Array<string | number> = [input.projectId, input.source];
    if (input.queryId) {
      clauses.push("s.tracked_query_id = ?");
      bindings.push(input.queryId);
    }
    const snapshotCursor = decodeCursor<{
      capturedAt: string;
      id: string;
    }>(input.cursor, "snapshots");
    if (
      snapshotCursor &&
      (typeof snapshotCursor.capturedAt !== "string" ||
        typeof snapshotCursor.id !== "string")
    ) {
      throw new ApiError(400, "invalid_cursor", "The snapshot cursor is invalid.");
    }
    if (snapshotCursor) {
      clauses.push(
        "(s.captured_at < ? OR (s.captured_at = ? AND s.id < ?))",
      );
      bindings.push(
        snapshotCursor.capturedAt,
        snapshotCursor.capturedAt,
        snapshotCursor.id,
      );
    }
    bindings.push(input.limit + 1);
    const rows = await c.env.CONTROL_DB.prepare(
      `SELECT s.*, q.query_text
       FROM snapshot_index s
       JOIN tracked_queries q ON q.id = s.tracked_query_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY s.captured_at DESC, s.id DESC LIMIT ?`,
    )
      .bind(...bindings)
      .all<{ id: string; captured_at: string }>();
    const results = rows.results.slice(0, input.limit);
    return c.json({
      data: results,
      page: {
        nextCursor:
          rows.results.length > input.limit
            ? encodeCursor("snapshots", {
                capturedAt: results.at(-1)?.captured_at ?? "",
                id: String(results.at(-1)?.id ?? ""),
              })
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
      detectedEntities,
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
          `SELECT mention.id, mention.entity_id, mention.surface_text,
            mention.occurrence_count, mention.entity_type, mention.relationship,
            mention.confidence, mention.evidence_tier, mention.relationship_reason,
            mention.evidence_json, mention.sources_json,
            entity.canonical_name, entity.status, entity.tracked_brand_id
           FROM entity_mentions mention
           JOIN project_entities entity ON entity.id = mention.entity_id
           JOIN projects project ON project.id = mention.project_id
           WHERE mention.snapshot_id = ?
             AND mention.extractor_version = project.active_entity_extractor_version
           ORDER BY mention.confidence DESC, entity.canonical_name`,
        )
          .bind(id)
          .all<Record<string, unknown> & {
            evidence_json: string;
            sources_json: string;
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
    // Provider items are the source of truth for snapshot display. Keeping this
    // read independent from the derived snapshot_ads table prevents a pending
    // migration or backfill from making the entire captured response unavailable.
    const snapshotAds = items.results.flatMap((item) => {
      const ad = normalizeAdItem(jsonParse<unknown>(item.payload_json, {}));
      return ad ? [{
        id: `ad:${String(item.id)}`,
        snapshot_item_id: String(item.id),
        ordinal: Number(item.ordinal),
        rank_group: ad.rankGroup,
        rank_absolute: ad.rankAbsolute,
        is_rendered: ad.isRendered,
        advertiser_identity: ad.advertiserIdentity,
        advertiser_key: ad.advertiserKey,
        advertiser_name: ad.advertiserName,
        advertiser_canonical_url: ad.advertiserCanonicalUrl,
        advertiser_domain: ad.advertiserDomain,
        title: ad.title,
        snippet: ad.snippet,
        canonical_url: ad.canonicalUrl,
        destination_domain: ad.destinationDomain,
        image_source_url: ad.imageSourceUrl,
        favicon_source_url: ad.faviconSourceUrl,
        creative_key: ad.creativeKey,
      }] : [];
    });
    const adSourceUrls = [...new Set(snapshotAds.flatMap((ad) => [
      ad.image_source_url,
      ad.favicon_source_url,
    ]).filter((value): value is string => typeof value === "string" && Boolean(value)))];
    const adAssets = adSourceUrls.length
      ? await c.env.CONTROL_DB.prepare(
          `SELECT source_url, asset_key, status FROM ad_assets
           WHERE source_url IN (${adSourceUrls.map(() => "?").join(",")})`,
        )
          .bind(...adSourceUrls)
          .all<{ source_url: string; asset_key: string; status: string }>()
      : { results: [] as Array<{ source_url: string; asset_key: string; status: string }> };
    const adAssetMap = new Map(adAssets.results.map((asset) => [asset.source_url, asset]));
    const adAssetUrl = (sourceUrl: unknown) => {
      if (typeof sourceUrl !== "string") return null;
      const asset = adAssetMap.get(sourceUrl);
      if (asset?.status === "ready") {
        const key = asset.asset_key.split("/").at(-1);
        if (key) {
          return `/api/v1/ads/assets/${key}?projectId=${encodeURIComponent(index.project_id)}`;
        }
      }
      return allowedAdAssetUrl(sourceUrl)?.href ?? null;
    };
    const structuredAds = snapshotAds.map((ad) => ({
      ...ad,
      image_url: adAssetUrl(ad.image_source_url),
      image_fallback_url: typeof ad.image_source_url === "string"
        ? allowedAdAssetUrl(ad.image_source_url)?.href ?? null
        : null,
      favicon_url: adAssetUrl(ad.favicon_source_url),
      favicon_fallback_url: typeof ad.favicon_source_url === "string"
        ? allowedAdAssetUrl(ad.favicon_source_url)?.href ?? null
        : null,
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
        ads: structuredAds,
        brandMentions,
        detectedEntities: detectedEntities.results.map((entity) => ({
          ...entity,
          evidence: jsonParse<string[]>(entity.evidence_json, []),
          sources: jsonParse<string[]>(entity.sources_json, []),
        })),
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
      `SELECT id, tracked_query_id, shard_id, tracking_source, captured_at, model, answer_hash, has_product_block
       FROM snapshot_index WHERE id = ? AND workspace_id = ?`,
    )
      .bind(id, principal.workspaceId)
      .first<{
        id: string;
        tracked_query_id: string;
        shard_id: number;
        tracking_source: TrackingSource;
        captured_at: string;
        model: string | null;
        answer_hash: string;
        has_product_block: number;
      }>();
    if (!current) throw new ApiError(404, "snapshot_not_found", "Snapshot not found.");
    const previous = await c.env.CONTROL_DB.prepare(
      `SELECT id, model, answer_hash, has_product_block, captured_at
       FROM snapshot_index
       WHERE tracked_query_id = ? AND tracking_source = ? AND captured_at < ?
       ORDER BY captured_at DESC LIMIT 1`,
    )
      .bind(current.tracked_query_id, current.tracking_source, current.captured_at)
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
  "/analytics/related-queries",
  zValidator("query", RelatedQueriesSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    const readModelState = await requireAnalyticsProjectContext(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const ready = analyticsReadModelSupports(
      readModelState,
      RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION,
    );
    if (!ready) {
      return c.json({
        data: {
          period: input.period,
          indexing: true,
          summary: {
            appearances: 0,
            uniqueQueries: 0,
            responsesWithQueries: 0,
            completedResponses: 0,
          },
          queries: [],
        },
        page: { nextCursor: null, total: 0 },
      });
    }

    const dates = relatedQueryRange(input.period);
    const search = input.search
      ? normalizeRelatedQuery(input.search)
      : null;
    const cursor = decodeCursor<{
      appearances: number;
      lastSeen: string;
      normalizedQuery: string;
    }>(input.cursor, "related-query-list");
    const where = [
      "related.project_id = ?",
      "fact.tracking_source = ?",
      "related.captured_at >= ?",
      "related.captured_at < ?",
      ...(search ? ["INSTR(related.normalized_query, ?) > 0"] : []),
    ];
    const bindings: Array<string | number> = [
      input.projectId,
      input.source,
      dates.from,
      dates.to,
      ...(search ? [search] : []),
    ];
    const countBindings = [...bindings];
    const having = cursor
      ? `HAVING COUNT(*) < ?
        OR (COUNT(*) = ? AND MAX(related.captured_at) < ?)
        OR (COUNT(*) = ? AND MAX(related.captured_at) = ?
          AND related.normalized_query > ?)`
      : "";
    if (cursor) {
      bindings.push(
        cursor.appearances,
        cursor.appearances,
        cursor.lastSeen,
        cursor.appearances,
        cursor.lastSeen,
        cursor.normalizedQuery,
      );
    }
    const [rows, summary, filteredTotal, tracked] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT related.normalized_query,
          COUNT(*) AS appearances,
          COUNT(DISTINCT related.tracked_query_id) AS parent_prompts,
          MIN(related.captured_at) AS first_seen,
          MAX(related.captured_at) AS last_seen,
          (
            SELECT latest.query_text
            FROM analytics_related_query_occurrences latest
            JOIN analytics_snapshot_facts latest_fact
              ON latest_fact.snapshot_id = latest.snapshot_id
            WHERE latest.project_id = related.project_id
              AND latest.normalized_query = related.normalized_query
              AND latest_fact.tracking_source = ?
              AND latest.captured_at >= ? AND latest.captured_at < ?
            ORDER BY latest.captured_at DESC, latest.snapshot_id DESC
            LIMIT 1
          ) AS query_text
         FROM analytics_related_query_occurrences related
         JOIN analytics_snapshot_facts fact ON fact.snapshot_id = related.snapshot_id
         WHERE ${where.join(" AND ")}
         GROUP BY related.normalized_query
         ${having}
         ORDER BY appearances DESC, last_seen DESC, related.normalized_query
         LIMIT ?`,
      )
        .bind(input.source, dates.from, dates.to, ...bindings, input.limit + 1)
        .all<{
          normalized_query: string;
          query_text: string;
          appearances: number;
          parent_prompts: number;
          first_seen: string;
          last_seen: string;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT
          COUNT(*) AS appearances,
          COUNT(DISTINCT related.normalized_query) AS unique_queries,
          COUNT(DISTINCT related.snapshot_id) AS responses_with_queries,
          (SELECT COUNT(*) FROM analytics_snapshot_facts fact
            WHERE fact.project_id = ? AND fact.tracking_source = ?
              AND fact.captured_at >= ? AND fact.captured_at < ?
          ) AS completed_responses
         FROM analytics_related_query_occurrences related
         JOIN analytics_snapshot_facts fact ON fact.snapshot_id = related.snapshot_id
         WHERE related.project_id = ? AND fact.tracking_source = ?
           AND related.captured_at >= ? AND related.captured_at < ?`,
      )
        .bind(
          input.projectId, input.source, dates.from, dates.to,
          input.projectId, input.source, dates.from, dates.to,
        )
        .first<{
          appearances: number;
          unique_queries: number;
          responses_with_queries: number;
          completed_responses: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT COUNT(*) AS count FROM (
          SELECT 1
          FROM analytics_related_query_occurrences related
          JOIN analytics_snapshot_facts fact ON fact.snapshot_id = related.snapshot_id
          WHERE ${where.join(" AND ")}
          GROUP BY related.normalized_query
        )`,
      )
        .bind(...countBindings)
        .first<{ count: number }>(),
      trackedRelatedQueries(c.env, input.projectId),
    ]);
    const hasMore = rows.results.length > input.limit;
    const visible = rows.results.slice(0, input.limit);
    const last = visible.at(-1);
    return c.json({
      data: {
        period: input.period,
        indexing: false,
        summary: {
          appearances: Number(summary?.appearances ?? 0),
          uniqueQueries: Number(summary?.unique_queries ?? 0),
          responsesWithQueries: Number(summary?.responses_with_queries ?? 0),
          completedResponses: Number(summary?.completed_responses ?? 0),
        },
        queries: visible.map((row) => {
          const trackedPrompt = tracked.get(row.normalized_query) ?? null;
          return {
            queryKey: relatedQueryKey(row.normalized_query),
            query: row.query_text,
            appearances: Number(row.appearances),
            parentPrompts: Number(row.parent_prompts),
            firstSeen: row.first_seen,
            lastSeen: row.last_seen,
            trackedPrompt: trackedPrompt
              ? { id: trackedPrompt.id, query: trackedPrompt.query_text }
              : null,
          };
        }),
      },
      page: {
        total: Number(filteredTotal?.count ?? 0),
        nextCursor: hasMore && last
          ? encodeCursor("related-query-list", {
              appearances: Number(last.appearances),
              lastSeen: last.last_seen,
              normalizedQuery: last.normalized_query,
            })
          : null,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/related-queries/:queryKey",
  zValidator("param", RelatedQueryParamSchema),
  zValidator("query", RelatedQueryDetailSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    const normalizedQuery = decodedRelatedQuery(c.req.valid("param").queryKey);
    const readModelState = await requireAnalyticsProjectContext(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const ready = analyticsReadModelSupports(
      readModelState,
      RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION,
    );
    if (!ready) return c.json({ data: { indexing: true } });
    const dates = relatedQueryRange(input.period);
    const [summary, parentPrompts, tracked] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT COUNT(*) AS appearances,
          COUNT(DISTINCT related.tracked_query_id) AS parent_prompts,
          MIN(related.captured_at) AS first_seen,
          MAX(related.captured_at) AS last_seen,
          (SELECT latest.query_text
           FROM analytics_related_query_occurrences latest
           JOIN analytics_snapshot_facts latest_fact
             ON latest_fact.snapshot_id = latest.snapshot_id
           WHERE latest.project_id = ? AND latest.normalized_query = ?
             AND latest_fact.tracking_source = ?
             AND latest.captured_at >= ? AND latest.captured_at < ?
           ORDER BY latest.captured_at DESC, latest.snapshot_id DESC LIMIT 1
          ) AS query_text
         FROM analytics_related_query_occurrences related
         JOIN analytics_snapshot_facts fact
           ON fact.snapshot_id = related.snapshot_id
         WHERE related.project_id = ? AND related.normalized_query = ?
           AND fact.tracking_source = ?
           AND related.captured_at >= ? AND related.captured_at < ?`,
      )
        .bind(
          input.projectId, normalizedQuery, input.source, dates.from, dates.to,
          input.projectId, normalizedQuery, input.source, dates.from, dates.to,
        )
        .first<{
          appearances: number;
          parent_prompts: number;
          first_seen: string | null;
          last_seen: string | null;
          query_text: string | null;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT query.id, query.query_text, query.location_code, query.language_code,
          COUNT(*) AS appearances, MAX(related.captured_at) AS last_seen,
          (SELECT latest.snapshot_id
           FROM analytics_related_query_occurrences latest
           JOIN analytics_snapshot_facts latest_fact
             ON latest_fact.snapshot_id = latest.snapshot_id
           WHERE latest.project_id = ? AND latest.normalized_query = ?
             AND latest.tracked_query_id = query.id
             AND latest_fact.tracking_source = ?
             AND latest.captured_at >= ? AND latest.captured_at < ?
           ORDER BY latest.captured_at DESC, latest.snapshot_id DESC LIMIT 1
          ) AS latest_snapshot_id
         FROM analytics_related_query_occurrences related
         JOIN analytics_snapshot_facts fact ON fact.snapshot_id = related.snapshot_id
         JOIN tracked_queries query ON query.id = related.tracked_query_id
         WHERE related.project_id = ? AND related.normalized_query = ?
           AND fact.tracking_source = ?
           AND related.captured_at >= ? AND related.captured_at < ?
         GROUP BY query.id
         ORDER BY appearances DESC, last_seen DESC, query.id`,
      )
        .bind(
          input.projectId, normalizedQuery, input.source, dates.from, dates.to,
          input.projectId, normalizedQuery, input.source, dates.from, dates.to,
        )
        .all<{
          id: string;
          query_text: string;
          location_code: number;
          language_code: string;
          appearances: number;
          last_seen: string;
          latest_snapshot_id: string;
        }>(),
      trackedRelatedQueries(c.env, input.projectId),
    ]);
    const fallback = summary?.query_text
      ? null
      : await c.env.CONTROL_DB.prepare(
          `SELECT related.query_text
           FROM analytics_related_query_occurrences related
           JOIN analytics_snapshot_facts fact
             ON fact.snapshot_id = related.snapshot_id
           WHERE related.project_id = ? AND related.normalized_query = ?
             AND fact.tracking_source = ?
           ORDER BY related.captured_at DESC, related.snapshot_id DESC LIMIT 1`,
        )
          .bind(input.projectId, normalizedQuery, input.source)
          .first<{ query_text: string }>();
    const queryText = summary?.query_text ?? fallback?.query_text;
    if (!queryText) {
      throw new ApiError(404, "related_query_not_found", "Related query not found.");
    }
    const trackedPrompt = tracked.get(normalizedQuery) ?? null;
    const latestParent = parentPrompts.results
      .slice()
      .sort((left, right) => right.last_seen.localeCompare(left.last_seen))[0] ?? null;
    return c.json({
      data: {
        indexing: false,
        period: input.period,
        queryKey: relatedQueryKey(normalizedQuery),
        query: queryText,
        summary: {
          appearances: Number(summary?.appearances ?? 0),
          parentPrompts: Number(summary?.parent_prompts ?? 0),
          firstSeen: summary?.first_seen ?? null,
          lastSeen: summary?.last_seen ?? null,
        },
        trackedPrompt: trackedPrompt
          ? { id: trackedPrompt.id, query: trackedPrompt.query_text }
          : null,
        suggestedLocale: latestParent
          ? { locationCode: latestParent.location_code, languageCode: latestParent.language_code }
          : null,
        parentPrompts: parentPrompts.results.map((row) => ({
          id: row.id,
          query: row.query_text,
          locationCode: row.location_code,
          languageCode: row.language_code,
          appearances: Number(row.appearances),
          lastSeen: row.last_seen,
          latestSnapshotId: row.latest_snapshot_id,
        })),
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/related-queries/:queryKey/occurrences",
  zValidator("param", RelatedQueryParamSchema),
  zValidator("query", RelatedQueryPageSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    const normalizedQuery = decodedRelatedQuery(c.req.valid("param").queryKey);
    const readModelState = await requireAnalyticsProjectContext(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const ready = analyticsReadModelSupports(
      readModelState,
      RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION,
    );
    if (!ready) return c.json({ data: [], page: { nextCursor: null, total: 0 } });
    const dates = relatedQueryRange(input.period);
    const cursor = decodeCursor<{ capturedAt: string; snapshotId: string }>(
      input.cursor,
      "related-query-occurrences",
    );
    const cursorClause = cursor
      ? "AND (related.captured_at < ? OR (related.captured_at = ? AND related.snapshot_id < ?))"
      : "";
    const cursorBindings = cursor
      ? [cursor.capturedAt, cursor.capturedAt, cursor.snapshotId]
      : [];
    const [rows, total] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT related.snapshot_id, related.query_text, related.captured_at,
          query.id AS prompt_id, query.query_text AS prompt_text,
          query.location_code, query.language_code,
          fact.citation_count, fact.retrieved_domains_count
         FROM analytics_related_query_occurrences related
         JOIN tracked_queries query ON query.id = related.tracked_query_id
         JOIN analytics_snapshot_facts fact ON fact.snapshot_id = related.snapshot_id
         WHERE related.project_id = ? AND related.normalized_query = ?
           AND fact.tracking_source = ?
           AND related.captured_at >= ? AND related.captured_at < ?
           ${cursorClause}
         ORDER BY related.captured_at DESC, related.snapshot_id DESC
         LIMIT ?`,
      )
        .bind(
          input.projectId, normalizedQuery, input.source, dates.from, dates.to,
          ...cursorBindings, input.limit + 1,
        )
        .all<{
          snapshot_id: string;
          query_text: string;
          captured_at: string;
          prompt_id: string;
          prompt_text: string;
          location_code: number;
          language_code: string;
          citation_count: number;
          retrieved_domains_count: number;
        }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT COUNT(*) AS count
         FROM analytics_related_query_occurrences related
         JOIN analytics_snapshot_facts fact
           ON fact.snapshot_id = related.snapshot_id
         WHERE related.project_id = ? AND related.normalized_query = ?
           AND fact.tracking_source = ?
           AND related.captured_at >= ? AND related.captured_at < ?`,
      )
        .bind(input.projectId, normalizedQuery, input.source, dates.from, dates.to)
        .first<{ count: number }>(),
    ]);
    const hasMore = rows.results.length > input.limit;
    const visible = rows.results.slice(0, input.limit);
    const last = visible.at(-1);
    return c.json({
      data: visible.map((row) => ({
        snapshotId: row.snapshot_id,
        capturedAt: row.captured_at,
        query: row.query_text,
        prompt: {
          id: row.prompt_id,
          query: row.prompt_text,
          locationCode: row.location_code,
          languageCode: row.language_code,
        },
        citationCount: Number(row.citation_count),
        retrievedDomainsCount: Number(row.retrieved_domains_count),
      })),
      page: {
        total: Number(total?.count ?? 0),
        nextCursor: hasMore && last
          ? encodeCursor("related-query-occurrences", {
              capturedAt: last.captured_at,
              snapshotId: last.snapshot_id,
            })
          : null,
      },
    });
  },
);

analyticsRoutes.get(
  "/analytics/related-queries/:queryKey/sources",
  zValidator("param", RelatedQueryParamSchema),
  zValidator("query", RelatedQuerySourcesSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    const normalizedQuery = decodedRelatedQuery(c.req.valid("param").queryKey);
    const readModelState = await requireAnalyticsProjectContext(
      c.env,
      principal.workspaceId,
      input.projectId,
      c.get("timing"),
    );
    const ready = analyticsReadModelSupports(
      readModelState,
      RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION,
    );
    if (!ready) return c.json({ data: [], page: { nextCursor: null, total: 0 } });
    const dates = relatedQueryRange(input.period);
    const cursor = decodeCursor<{ offset: number }>(
      input.cursor,
      `related-query-sources-${input.kind}`,
    );
    const offset = Number(cursor?.offset ?? 0);
    const sourceTable = input.kind === "cited"
      ? "analytics_citation_occurrences"
      : "analytics_retrieval_occurrences";
    const [rows, total] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `WITH matching_snapshots AS (
          SELECT related.snapshot_id
          FROM analytics_related_query_occurrences related
          JOIN analytics_snapshot_facts fact
            ON fact.snapshot_id = related.snapshot_id
          WHERE related.project_id = ? AND related.normalized_query = ?
            AND fact.tracking_source = ?
            AND related.captured_at >= ? AND related.captured_at < ?
        )
        SELECT COALESCE(source.canonical_url, source.raw_url) AS url,
          MAX(source.registrable_domain) AS domain,
          MAX(source.title) AS title,
          COUNT(*) AS appearances,
          COUNT(DISTINCT source.snapshot_id) AS responses,
          MAX(source.captured_at) AS last_seen
        FROM ${sourceTable} source
        JOIN matching_snapshots matching ON matching.snapshot_id = source.snapshot_id
        WHERE COALESCE(source.canonical_url, source.raw_url) IS NOT NULL
        GROUP BY COALESCE(source.canonical_url, source.raw_url)
        ORDER BY appearances DESC, last_seen DESC, url
        LIMIT ? OFFSET ?`,
      )
        .bind(
          input.projectId, normalizedQuery, input.source, dates.from, dates.to,
          input.limit + 1, offset,
        )
        .all<{
          url: string;
          domain: string | null;
          title: string | null;
          appearances: number;
          responses: number;
          last_seen: string;
        }>(),
      c.env.CONTROL_DB.prepare(
        `WITH matching_snapshots AS (
          SELECT related.snapshot_id
          FROM analytics_related_query_occurrences related
          JOIN analytics_snapshot_facts fact
            ON fact.snapshot_id = related.snapshot_id
          WHERE related.project_id = ? AND related.normalized_query = ?
            AND fact.tracking_source = ?
            AND related.captured_at >= ? AND related.captured_at < ?
        )
        SELECT COUNT(*) AS count FROM (
          SELECT 1
          FROM ${sourceTable} source
          JOIN matching_snapshots matching ON matching.snapshot_id = source.snapshot_id
          WHERE COALESCE(source.canonical_url, source.raw_url) IS NOT NULL
          GROUP BY COALESCE(source.canonical_url, source.raw_url)
        )`,
      )
        .bind(input.projectId, normalizedQuery, input.source, dates.from, dates.to)
        .first<{ count: number }>(),
    ]);
    const hasMore = rows.results.length > input.limit;
    return c.json({
      data: rows.results.slice(0, input.limit).map((row) => ({
        url: row.url,
        domain: row.domain,
        title: row.title,
        appearances: Number(row.appearances),
        responses: Number(row.responses),
        lastSeen: row.last_seen,
      })),
      page: {
        total: Number(total?.count ?? 0),
        nextCursor: hasMore
          ? encodeCursor(`related-query-sources-${input.kind}`, {
              offset: offset + input.limit,
            })
          : null,
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
