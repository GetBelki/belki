import { productIdentity, productKey } from "../lib/reporting";
import { getShard } from "../lib/shards";
import { jsonParse, nowIso } from "../lib/http";
import { matchedBrandTerms } from "../lib/domain";

interface SnapshotReadModelRow {
  id: string;
  project_id: string;
  tracked_query_id: string;
  captured_at: string;
  provider_cost_usd: number | null;
  answer_markdown: string | null;
}

interface OwnedBrandRow {
  name: string;
  aliases_json: string;
}

interface CitationReadModelRow {
  ordinal: number;
  registrable_domain: string | null;
  canonical_url: string | null;
  raw_url: string | null;
  title: string | null;
  source_name: string | null;
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
  const [snapshot, citations, retrievedDomains, products, ownedBrands] =
    await Promise.all([
      shard
        .prepare(
          `SELECT id, project_id, tracked_query_id, captured_at, provider_cost_usd,
            answer_markdown
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
          `SELECT COUNT(DISTINCT registrable_domain) AS count
           FROM snapshot_search_results
           WHERE snapshot_id = ? AND registrable_domain IS NOT NULL`,
        )
        .bind(payload.snapshotId)
        .first<{ count: number }>(),
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
        `SELECT name, aliases_json
         FROM tracked_brands
         WHERE project_id = ? AND kind = 'owned'`,
      )
        .bind(payload.projectId)
        .all<OwnedBrandRow>(),
    ]);
  if (!snapshot) {
    throw new Error(`Snapshot ${payload.snapshotId} is missing from shard ${shardId}`);
  }

  const updatedAt = nowIso();
  const brandMentionsCount = ownedBrands.results.filter(
    (brand) =>
      matchedBrandTerms(
        snapshot.answer_markdown ?? "",
        brand.name,
        jsonParse<string[]>(brand.aliases_json, []),
      ).length > 0,
  ).length;
  const brandMentionedRuns = brandMentionsCount > 0 ? 1 : 0;
  const citedDomainsCount = new Set(
    citations.results.map((citation) => citation.registrable_domain),
  ).size;
  const statements: D1PreparedStatement[] = [
    env.CONTROL_DB.prepare(
      `INSERT INTO analytics_snapshot_facts (
        snapshot_id, project_id, tracked_query_id, shard_id, captured_at,
        metric_date, cited_domains_count, retrieved_domains_count, citation_count,
        brand_mentioned_runs, brand_mentions_count, products_count, provider_cost_usd,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        cited_domains_count = excluded.cited_domains_count,
        retrieved_domains_count = excluded.retrieved_domains_count,
        citation_count = excluded.citation_count,
        brand_mentioned_runs = excluded.brand_mentioned_runs,
        brand_mentions_count = excluded.brand_mentions_count,
        products_count = excluded.products_count,
        provider_cost_usd = excluded.provider_cost_usd,
        updated_at = excluded.updated_at`,
    ).bind(
      payload.snapshotId,
      payload.projectId,
      payload.trackedQueryId,
      shardId,
      snapshot.captured_at,
      payload.metricDate,
      citedDomainsCount,
      Number(retrievedDomains?.count ?? 0),
      citations.results.length,
      brandMentionedRuns,
      brandMentionsCount,
      products.results.length,
      snapshot.provider_cost_usd,
      updatedAt,
      updatedAt,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO analytics_read_model_projects (
        project_id, status, schema_version, last_ingested_at, updated_at
      ) VALUES (?, 'pending', 1, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        last_ingested_at = excluded.last_ingested_at,
        updated_at = excluded.updated_at`,
    ).bind(payload.projectId, snapshot.captured_at, updatedAt),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_citation_occurrences WHERE snapshot_id = ?",
    ).bind(payload.snapshotId),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_product_occurrences WHERE snapshot_id = ?",
    ).bind(payload.snapshotId),
  ];

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

  for (let index = 0; index < statements.length; index += 100) {
    await env.CONTROL_DB.batch(statements.slice(index, index + 100));
  }
}
