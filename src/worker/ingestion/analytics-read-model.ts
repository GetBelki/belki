import {
  classifyRelatedQueries,
  normalizeRelatedQuery,
  productIdentity,
  productKey,
  relatedQueryLabel,
} from "../lib/reporting";
import { getShard } from "../lib/shards";
import { jsonParse, nowIso } from "../lib/http";
import { matchedBrandTerms, normalizeBrand, normalizeHostname } from "../lib/domain";
import { normalizeAdItem } from "../lib/ads";
import { ANALYTICS_READ_MODEL_SCHEMA_VERSION } from "../lib/analytics-read-model";
import { registerAdAssetSources } from "../automation/ad-assets";

interface SnapshotReadModelRow {
  id: string;
  project_id: string;
  tracked_query_id: string;
  captured_at: string;
  provider_cost_usd: number | null;
  answer_markdown: string | null;
  fan_out_queries_json: string;
  tracking_source: string;
  surface_present: number;
}

interface OwnedBrandRow {
  id: string;
  kind: "owned" | "competitor";
  name: string;
  aliases_json: string;
  domains_json: string;
}

interface CitationReadModelRow {
  ordinal: number;
  registrable_domain: string | null;
  canonical_url: string | null;
  raw_url: string | null;
  title: string | null;
  source_name: string | null;
}

interface RetrievalReadModelRow {
  ordinal: number;
  registrable_domain: string | null;
  canonical_url: string | null;
  raw_url: string | null;
  title: string | null;
  description: string | null;
}

interface ProductReadModelRow {
  id: string;
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
}

interface AdReadModelRow {
  id: string;
  snapshot_item_id: string;
  ordinal: number;
  rank_group: number | null;
  rank_absolute: number | null;
  advertiser_identity: string;
  advertiser_key: string;
  advertiser_name: string | null;
  advertiser_raw_url: string | null;
  advertiser_canonical_url: string | null;
  advertiser_hostname: string | null;
  advertiser_domain: string | null;
  title: string | null;
  snippet: string | null;
  raw_url: string | null;
  canonical_url: string | null;
  destination_hostname: string | null;
  destination_domain: string | null;
  image_source_url: string | null;
  favicon_source_url: string | null;
  creative_identity: string;
  creative_key: string;
  is_rendered: number;
}

async function loadSnapshotAds(
  shard: D1Database,
  snapshotId: string,
): Promise<AdReadModelRow[]> {
  const items = await shard
    .prepare(
      `SELECT id, ordinal, payload_json
       FROM snapshot_items
       WHERE snapshot_id = ? AND type = 'chat_gpt_ad'
       ORDER BY ordinal`,
    )
    .bind(snapshotId)
    .all<{ id: string; ordinal: number; payload_json: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const item of items.results) {
    const ad = normalizeAdItem(jsonParse<unknown>(item.payload_json, {}));
    if (!ad) continue;
    statements.push(
      shard
        .prepare(
          `INSERT INTO snapshot_ads (
            id, snapshot_id, snapshot_item_id, ordinal, rank_group,
            rank_absolute, advertiser_identity, advertiser_key,
            advertiser_name, advertiser_raw_url, advertiser_canonical_url,
            advertiser_hostname, advertiser_domain, title, snippet, raw_url,
            canonical_url, destination_hostname, destination_domain,
            image_source_url, favicon_source_url, creative_identity, creative_key,
            is_rendered
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(snapshot_item_id) DO UPDATE SET
            is_rendered = excluded.is_rendered`,
        )
        .bind(
          crypto.randomUUID(), snapshotId, item.id, item.ordinal,
          ad.rankGroup, ad.rankAbsolute, ad.advertiserIdentity, ad.advertiserKey,
          ad.advertiserName, ad.advertiserRawUrl, ad.advertiserCanonicalUrl,
          ad.advertiserHostname, ad.advertiserDomain, ad.title, ad.snippet,
          ad.rawUrl, ad.canonicalUrl, ad.destinationHostname,
          ad.destinationDomain, ad.imageSourceUrl, ad.faviconSourceUrl,
          ad.creativeIdentity, ad.creativeKey, ad.isRendered ? 1 : 0,
        ),
    );
  }
  if (statements.length) await shard.batch(statements);
  const ads = await shard
    .prepare(
      `SELECT id, snapshot_item_id, ordinal, rank_group, rank_absolute,
        advertiser_identity, advertiser_key, advertiser_name, advertiser_raw_url,
        advertiser_canonical_url, advertiser_hostname, advertiser_domain, title,
        snippet, raw_url, canonical_url, destination_hostname, destination_domain,
        image_source_url, favicon_source_url, creative_identity, creative_key,
        is_rendered
       FROM snapshot_ads WHERE snapshot_id = ? ORDER BY ordinal`,
    )
    .bind(snapshotId)
    .all<AdReadModelRow>();
  return ads.results;
}

export interface AnalyticsReadModelPayload {
  snapshotId: string;
  projectId: string;
  trackedQueryId: string;
  metricDate: string;
}

export async function syncAnalyticsReadModel(
  env: Env,
  shardId: number,
  payload: AnalyticsReadModelPayload,
): Promise<void> {
  const shard = getShard(env, shardId);
  const [snapshot, citations, retrievals, products, trackedBrands, project, ads] =
    await Promise.all([
      shard
        .prepare(
          `SELECT id, project_id, tracked_query_id, captured_at, provider_cost_usd,
            answer_markdown, fan_out_queries_json, tracking_source, surface_present
           FROM snapshots WHERE id = ?`,
        )
        .bind(payload.snapshotId)
        .first<SnapshotReadModelRow>(),
      shard
        .prepare(
          `SELECT ordinal, registrable_domain, canonical_url, raw_url, title, source_name
           FROM snapshot_sources
           WHERE snapshot_id = ? AND registrable_domain IS NOT NULL
           ORDER BY ordinal`,
        )
        .bind(payload.snapshotId)
        .all<CitationReadModelRow>(),
      shard
        .prepare(
          `SELECT ordinal, registrable_domain, canonical_url, raw_url, title,
            description
           FROM snapshot_search_results
           WHERE snapshot_id = ?
           ORDER BY ordinal`,
        )
        .bind(payload.snapshotId)
        .all<RetrievalReadModelRow>(),
      shard
        .prepare(
          `SELECT id, ordinal, rank_absolute, provider_product_id, merchants, title,
            price, currency, tag, raw_url, canonical_url, registrable_domain,
            rating_value, rating_votes_count, rating_max, images_json, product_ids_json
           FROM snapshot_products
           WHERE snapshot_id = ?
           ORDER BY ordinal`,
        )
        .bind(payload.snapshotId)
        .all<ProductReadModelRow>(),
      env.CONTROL_DB.prepare(
        `SELECT id, kind, name, aliases_json, domains_json
         FROM tracked_brands
         WHERE project_id = ?`,
      )
        .bind(payload.projectId)
        .all<OwnedBrandRow>(),
      env.CONTROL_DB.prepare(
        "SELECT primary_domain FROM projects WHERE id = ?",
      )
        .bind(payload.projectId)
        .first<{ primary_domain: string | null }>(),
      loadSnapshotAds(shard, payload.snapshotId),
    ]);
  if (!snapshot) {
    throw new Error(`Snapshot ${payload.snapshotId} is missing from shard ${shardId}`);
  }

  const updatedAt = nowIso();
  const brandMentionsCount = trackedBrands.results.filter(
    (brand) =>
      brand.kind === "owned" &&
      matchedBrandTerms(
        snapshot.answer_markdown ?? "",
        brand.name,
        jsonParse<string[]>(brand.aliases_json, []),
      ).length > 0,
  ).length;
  const ownedProjectDomain = normalizeHostname(project?.primary_domain).registrableDomain;
  const adRelationships = new Map<string, {
    relationship: "owned" | "competitor" | "untracked";
    trackedBrandId: string | null;
  }>();
  for (const ad of ads) {
    const adDomains = new Set(
      [ad.advertiser_domain, ad.destination_domain].filter(
        (domain): domain is string => Boolean(domain),
      ),
    );
    if (ownedProjectDomain && adDomains.has(ownedProjectDomain)) {
      adRelationships.set(ad.id, { relationship: "owned", trackedBrandId: null });
      continue;
    }
    const adName = normalizeBrand(ad.advertiser_name ?? "");
    const matched = trackedBrands.results.find((brand) => {
      const domains = jsonParse<string[]>(brand.domains_json, [])
        .map((domain) => normalizeHostname(domain).registrableDomain)
        .filter((domain): domain is string => Boolean(domain));
      if (domains.some((domain) => adDomains.has(domain))) return true;
      return [brand.name, ...jsonParse<string[]>(brand.aliases_json, [])]
        .some((name) => normalizeBrand(name) === adName);
    });
    adRelationships.set(ad.id, matched
      ? { relationship: matched.kind, trackedBrandId: matched.id }
      : { relationship: "untracked", trackedBrandId: null });
  }
  const brandMentionedRuns = brandMentionsCount > 0 ? 1 : 0;
  const citedDomainsCount = new Set(
    citations.results.map((citation) => citation.registrable_domain),
  ).size;
  const retrievedDomainsCount = new Set(
    retrievals.results
      .map((retrieval) => retrieval.registrable_domain)
      .filter((domain): domain is string => Boolean(domain)),
  ).size;
  const relatedQueries = new Map<
    string,
    { ordinal: number; queryText: string }
  >();
  const storedFanOutQueries = jsonParse<unknown>(
    snapshot.fan_out_queries_json,
    [],
  );
  const fanOutQueries = Array.isArray(storedFanOutQueries)
    ? storedFanOutQueries
    : [];
  for (const [ordinal, value] of fanOutQueries.entries()) {
    const queryText = relatedQueryLabel(value);
    if (!queryText) continue;
    const normalizedQuery = normalizeRelatedQuery(queryText);
    if (!normalizedQuery || relatedQueries.has(normalizedQuery)) continue;
    relatedQueries.set(normalizedQuery, { ordinal, queryText });
  }
  const relatedQueryClassification = classifyRelatedQueries(
    [...relatedQueries.values()].map((query) => query.queryText),
  );
  const statements: D1PreparedStatement[] = [
    env.CONTROL_DB.prepare(
      `INSERT INTO analytics_snapshot_facts (
        snapshot_id, project_id, tracked_query_id, shard_id, tracking_source,
        surface_present, captured_at,
        metric_date, cited_domains_count, retrieved_domains_count, citation_count,
        brand_mentioned_runs, brand_mentions_count, products_count, ads_count,
        rendered_ads_count, ads_indexed_at, ad_render_status_indexed_at,
        related_queries_count, related_queries_indexed_at,
        related_site_query_present, related_review_query_present,
        related_query_years_json, related_query_insights_indexed_at,
        provider_cost_usd, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        tracking_source = excluded.tracking_source,
        surface_present = excluded.surface_present,
        cited_domains_count = excluded.cited_domains_count,
        retrieved_domains_count = excluded.retrieved_domains_count,
        citation_count = excluded.citation_count,
        brand_mentioned_runs = excluded.brand_mentioned_runs,
        brand_mentions_count = excluded.brand_mentions_count,
        products_count = excluded.products_count,
        ads_count = excluded.ads_count,
        rendered_ads_count = excluded.rendered_ads_count,
        ads_indexed_at = excluded.ads_indexed_at,
        ad_render_status_indexed_at = excluded.ad_render_status_indexed_at,
        related_queries_count = excluded.related_queries_count,
        related_queries_indexed_at = excluded.related_queries_indexed_at,
        related_site_query_present = excluded.related_site_query_present,
        related_review_query_present = excluded.related_review_query_present,
        related_query_years_json = excluded.related_query_years_json,
        related_query_insights_indexed_at = excluded.related_query_insights_indexed_at,
        provider_cost_usd = excluded.provider_cost_usd,
        updated_at = excluded.updated_at`,
    ).bind(
      payload.snapshotId,
      payload.projectId,
      payload.trackedQueryId,
      shardId,
      snapshot.tracking_source,
      snapshot.surface_present,
      snapshot.captured_at,
      payload.metricDate,
      citedDomainsCount,
      retrievedDomainsCount,
      citations.results.length,
      brandMentionedRuns,
      brandMentionsCount,
      products.results.length,
      ads.length,
      ads.filter((ad) => ad.is_rendered === 1).length,
      updatedAt,
      updatedAt,
      relatedQueries.size,
      updatedAt,
      relatedQueryClassification.sitePresent ? 1 : 0,
      relatedQueryClassification.reviewPresent ? 1 : 0,
      JSON.stringify(relatedQueryClassification.years),
      updatedAt,
      snapshot.provider_cost_usd,
      updatedAt,
      updatedAt,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO analytics_read_model_projects (
        project_id, status, schema_version, last_ingested_at, updated_at
      ) VALUES (?, 'pending', ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        last_ingested_at = excluded.last_ingested_at,
        schema_version = MAX(schema_version, excluded.schema_version),
        updated_at = excluded.updated_at`,
    ).bind(
      payload.projectId,
      ANALYTICS_READ_MODEL_SCHEMA_VERSION,
      snapshot.captured_at,
      updatedAt,
    ),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_citation_occurrences WHERE snapshot_id = ?",
    ).bind(payload.snapshotId),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_product_occurrences WHERE snapshot_id = ?",
    ).bind(payload.snapshotId),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_ad_occurrences WHERE snapshot_id = ?",
    ).bind(payload.snapshotId),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_related_query_occurrences WHERE snapshot_id = ?",
    ).bind(payload.snapshotId),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_retrieval_occurrences WHERE snapshot_id = ?",
    ).bind(payload.snapshotId),
  ];

  for (const [normalizedQuery, relatedQuery] of relatedQueries) {
    statements.push(
      env.CONTROL_DB.prepare(
        `INSERT INTO analytics_related_query_occurrences (
          snapshot_id, normalized_query, project_id, tracked_query_id,
          captured_at, ordinal, query_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        payload.snapshotId,
        normalizedQuery,
        payload.projectId,
        payload.trackedQueryId,
        snapshot.captured_at,
        relatedQuery.ordinal,
        relatedQuery.queryText,
      ),
    );
  }

  for (const retrieval of retrievals.results) {
    statements.push(
      env.CONTROL_DB.prepare(
        `INSERT INTO analytics_retrieval_occurrences (
          snapshot_id, ordinal, project_id, tracked_query_id, captured_at,
          registrable_domain, canonical_url, raw_url, title, description
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        payload.snapshotId,
        retrieval.ordinal,
        payload.projectId,
        payload.trackedQueryId,
        snapshot.captured_at,
        retrieval.registrable_domain,
        retrieval.canonical_url,
        retrieval.raw_url,
        retrieval.title,
        retrieval.description,
      ),
    );
  }

  for (const citation of citations.results) {
    statements.push(
      env.CONTROL_DB.prepare(
        `INSERT INTO analytics_citation_occurrences (
          snapshot_id, ordinal, project_id, tracked_query_id, captured_at,
          registrable_domain, canonical_url, raw_url, title, source_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        payload.snapshotId,
        citation.ordinal,
        payload.projectId,
        payload.trackedQueryId,
        snapshot.captured_at,
        citation.registrable_domain,
        citation.canonical_url,
        citation.raw_url,
        citation.title,
        citation.source_name,
      ),
    );
  }

  for (const product of products.results) {
    const identity = productIdentity(product);
    statements.push(
      env.CONTROL_DB.prepare(
        `INSERT INTO analytics_product_occurrences (
          product_row_id, snapshot_id, project_id, tracked_query_id, captured_at,
          product_identity, product_key, ordinal, rank_absolute, provider_product_id,
          merchants, title, price, currency, tag, raw_url, canonical_url,
          registrable_domain, rating_value, rating_votes_count, rating_max,
          images_json, product_ids_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        product.id,
        payload.snapshotId,
        payload.projectId,
        payload.trackedQueryId,
        snapshot.captured_at,
        identity,
        productKey(product),
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
      ),
    );
  }

  for (const ad of ads) {
    statements.push(
      env.CONTROL_DB.prepare(
        `INSERT INTO analytics_ad_occurrences (
          ad_row_id, snapshot_id, snapshot_item_id, project_id, tracked_query_id,
          captured_at, advertiser_identity, advertiser_key, advertiser_name,
          advertiser_raw_url, advertiser_canonical_url, advertiser_hostname,
          advertiser_domain, title, snippet, raw_url, canonical_url,
          destination_hostname, destination_domain, image_source_url,
          favicon_source_url, creative_identity, creative_key, relationship,
          matched_tracked_brand_id, rank_group, rank_absolute, is_rendered
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        ad.id, payload.snapshotId, ad.snapshot_item_id, payload.projectId,
        payload.trackedQueryId, snapshot.captured_at, ad.advertiser_identity,
        ad.advertiser_key, ad.advertiser_name, ad.advertiser_raw_url,
        ad.advertiser_canonical_url, ad.advertiser_hostname,
        ad.advertiser_domain, ad.title, ad.snippet, ad.raw_url,
        ad.canonical_url, ad.destination_hostname, ad.destination_domain,
        ad.image_source_url, ad.favicon_source_url, ad.creative_identity,
        ad.creative_key, adRelationships.get(ad.id)?.relationship ?? "untracked",
        adRelationships.get(ad.id)?.trackedBrandId ?? null,
        ad.rank_group, ad.rank_absolute, ad.is_rendered,
      ),
    );
  }

  for (let index = 0; index < statements.length; index += 100) {
    await env.CONTROL_DB.batch(statements.slice(index, index + 100));
  }
  await registerAdAssetSources(
    env,
    ads.flatMap((ad) => [
      { sourceUrl: ad.image_source_url, kind: "creative" as const },
      { sourceUrl: ad.favicon_source_url, kind: "favicon" as const },
    ]),
  );
}
