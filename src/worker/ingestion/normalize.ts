import type { NormalizeQueueMessage, RollupQueueMessage } from "../../shared/contracts";
import { resolveProviderCost } from "../../shared/provider-cost";
import {
  extractDomainsFromText,
  matchedBrandTerms,
  normalizeBrand,
  normalizeUrl,
} from "../lib/domain";
import { getTaskHtml } from "../lib/dataforseo";
import { jsonParse, nowIso } from "../lib/http";
import { sha256 } from "../lib/crypto";
import { getShard } from "../lib/shards";
import { promptPurgeRequested } from "../lib/prompt-purges";
import { parseAdvancedPayload } from "./dataforseo-schema";
import { enqueueEntityExtractionForSnapshot } from "../automation/entity-extraction";
import { normalizeAdItem } from "../lib/ads";

interface JobRow {
  id: string;
  workspace_id: string;
  project_id: string;
  tracked_query_id: string;
  shard_id: number;
  capture_html: number;
  delivery_method: string;
  request_cost_usd: number | null;
  status: string;
  deleted_at: string | null;
  purging: number;
}

interface BrandRow {
  id: string;
  kind: "owned" | "competitor";
  name: string;
  aliases_json: string;
  domains_json: string;
}

interface DomainMetric {
  citedSnapshotCount: number;
  citationCount: number;
  retrievedSnapshotCount: number;
  retrievalCount: number;
  productCount: number;
}

interface MetricPayload {
  snapshotId: string;
  projectId: string;
  trackedQueryId: string;
  metricDate: string;
  completedRuns: number;
  citedRuns: number;
  brandMentionedRuns: number;
  productRuns: number;
  totalCitations: number;
  domains: Record<string, DomainMetric>;
  brands: string[];
}

function safeText(value: string | null | undefined, maximum = 200_000): string | null {
  return value ? value.slice(0, maximum) : null;
}

function uniqueEvidenceKeys(rawKey: string, htmlKey: string | null): string[] {
  return [...new Set([rawKey, htmlKey].filter((key): key is string => Boolean(key)))];
}

function providerDate(value: string | null | undefined): string {
  if (!value) return nowIso();
  const normalized = value
    .replace(/^(\d{4}-\d{2}-\d{2}) /u, "$1T")
    .replace(" +00:00", "Z");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
}

function productNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function productText(value: unknown): string | null {
  return typeof value === "string" ? safeText(value, 20_000) : null;
}

async function readRawPayload(
  env: Env,
  message: NormalizeQueueMessage,
): Promise<unknown> {
  const object = await env.EVIDENCE_BUCKET.get(message.rawR2Key);
  if (!object) throw new Error(`Raw evidence not found: ${message.rawR2Key}`);
  if (object.size > 20 * 1024 * 1024) throw new Error("Raw evidence exceeds normalization limit");
  let stream: ReadableStream = object.body;
  if (message.contentEncoding === "gzip") {
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  return new Response(stream).json();
}

export async function normalizeSnapshot(
  env: Env,
  message: NormalizeQueueMessage,
): Promise<string | null> {
  const job = await env.CONTROL_DB.prepare(
    `SELECT
      job.id, job.workspace_id, job.project_id, job.tracked_query_id, job.shard_id,
      job.capture_html, job.delivery_method, job.request_cost_usd, job.status,
      query.deleted_at,
      EXISTS(
        SELECT 1 FROM prompt_purge_jobs purge
        WHERE purge.tracked_query_id = job.tracked_query_id
      ) AS purging
     FROM crawl_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     WHERE job.id = ?`,
  )
    .bind(message.jobId)
    .first<JobRow>();
  if (!job) {
    await env.EVIDENCE_BUCKET.delete(message.rawR2Key);
    return null;
  }
  if (job.deleted_at || job.purging || job.status === "cancelled") {
    await env.EVIDENCE_BUCKET.delete(message.rawR2Key);
    return null;
  }

  const shard = getShard(env, job.shard_id);
  const existing = await shard
    .prepare("SELECT id FROM snapshots WHERE dataforseo_task_id = ?")
    .bind(message.taskId)
    .first<{ id: string }>();
  if (existing) {
    if (await promptPurgeRequested(env.CONTROL_DB, job.tracked_query_id)) {
      await shard.prepare("DELETE FROM snapshots WHERE id = ?").bind(existing.id).run();
      await env.EVIDENCE_BUCKET.delete(message.rawR2Key);
      return null;
    }
    await env.CONTROL_DB.prepare(
      `UPDATE crawl_jobs SET status = 'completed', completed_at = ?, updated_at = ?
       WHERE id = ? AND status != 'cancelled'`,
    )
      .bind(nowIso(), nowIso(), job.id)
      .run();
    await enqueueEntityExtractionForSnapshot(env, {
      id: existing.id,
      workspaceId: job.workspace_id,
      projectId: job.project_id,
      trackedQueryId: job.tracked_query_id,
      shardId: job.shard_id,
    });
    return existing.id;
  }

  const rawPayload = await readRawPayload(env, message);
  const payload = parseAdvancedPayload(rawPayload);
  const providerTask =
    payload.tasks.find((task) => task.id === message.taskId) ?? payload.tasks[0];
  const result = providerTask?.result?.[0];
  if (!providerTask || !result) {
    throw new Error(providerTask?.status_message ?? "DataForSEO returned no Advanced result");
  }
  const providerCost = resolveProviderCost(
    job.request_cost_usd,
    providerTask.cost,
  );

  const brandsResult = await env.CONTROL_DB.prepare(
    `SELECT id, kind, name, aliases_json, domains_json
     FROM tracked_brands WHERE project_id = ?`,
  )
    .bind(job.project_id)
    .all<BrandRow>();
  const brands = brandsResult.results;
  const brandAliases = new Map<string, BrandRow>();
  const brandDomains = new Map<string, string[]>();
  const ownedDomains = new Set<string>();
  for (const brand of brands) {
    brandAliases.set(normalizeBrand(brand.name), brand);
    for (const alias of jsonParse<string[]>(brand.aliases_json, [])) {
      brandAliases.set(normalizeBrand(alias), brand);
    }
    const normalizedBrandDomains = jsonParse<string[]>(brand.domains_json, [])
      .map((domain) => normalizeUrl(domain).registrableDomain)
      .filter((domain): domain is string => Boolean(domain));
    brandDomains.set(brand.id, [...new Set(normalizedBrandDomains)]);
    if (brand.kind === "owned") {
      for (const domain of normalizedBrandDomains) ownedDomains.add(domain);
    }
  }

  let htmlR2Key: string | null = null;
  if (job.capture_html === 1 && job.delivery_method !== "live") {
    const html = await getTaskHtml(env, message.taskId);
    htmlR2Key = `html/${new Date().toISOString().slice(0, 7)}/${message.taskId}.html`;
    await env.EVIDENCE_BUCKET.put(htmlR2Key, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { jobId: job.id, taskId: message.taskId },
    });
    await env.CONTROL_DB.prepare(
      "UPDATE crawl_jobs SET html_r2_key = ?, updated_at = ? WHERE id = ?",
    )
      .bind(htmlR2Key, nowIso(), job.id)
      .run();
  }

  const snapshotId = crypto.randomUUID();
  const createdAt = nowIso();
  const capturedAt = providerDate(result.datetime);
  const answerHash = await sha256(result.markdown ?? "");
  const statements: D1PreparedStatement[] = [];
  statements.push(
    shard
      .prepare(
        `INSERT INTO snapshots (
          id, crawl_job_id, workspace_id, project_id, tracked_query_id,
          dataforseo_task_id, keyword, location_code, language_code, model,
          check_url, captured_at, answer_markdown, answer_hash, se_results_count,
          items_count, item_types_json, fan_out_queries_json, raw_r2_key,
          html_r2_key, provider_cost_usd, provider_status_code,
          provider_status_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        snapshotId,
        job.id,
        job.workspace_id,
        job.project_id,
        job.tracked_query_id,
        message.taskId,
        result.keyword,
        result.location_code,
        result.language_code,
        result.model ?? null,
        result.check_url ?? null,
        capturedAt,
        safeText(result.markdown),
        answerHash,
        result.se_results_count ?? null,
        result.items_count ?? null,
        JSON.stringify(result.item_types),
        JSON.stringify(result.fan_out_queries),
        message.rawR2Key,
        htmlR2Key,
        providerCost,
        providerTask.status_code ?? null,
        providerTask.status_message ?? null,
        createdAt,
      ),
  );

  const domainFacts = new Map<
    string,
    {
      hostname: string | null;
      citedCount: number;
      retrievedCount: number;
      brandUrlCount: number;
      productCount: number;
    }
  >();
  const metricDomains: Record<string, DomainMetric> = {};
  const distinctCitations = new Set<string>();
  const distinctRetrieved = new Set<string>();

  function domainFact(domain: string, hostname: string | null) {
    const current = domainFacts.get(domain) ?? {
      hostname,
      citedCount: 0,
      retrievedCount: 0,
      brandUrlCount: 0,
      productCount: 0,
    };
    domainFacts.set(domain, current);
    return current;
  }

  result.sources.forEach((source, ordinal) => {
    const normalized = normalizeUrl(source.url ?? source.domain);
    statements.push(
      shard
        .prepare(
          `INSERT INTO snapshot_sources (
            id, snapshot_id, ordinal, title, snippet, source_name, raw_domain,
            hostname, registrable_domain, raw_url, canonical_url, thumbnail,
            publication_date, markdown
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          snapshotId,
          ordinal,
          safeText(source.title, 10_000),
          safeText(source.snippet, 50_000),
          safeText(source.source_name, 2_000),
          source.domain ?? null,
          normalized.hostname,
          normalized.registrableDomain,
          normalized.rawUrl,
          normalized.canonicalUrl,
          source.thumbnail ?? null,
          source.publication_date ?? null,
          safeText(source.markdown, 50_000),
        ),
    );
    if (normalized.registrableDomain) {
      domainFact(normalized.registrableDomain, normalized.hostname).citedCount += 1;
      distinctCitations.add(
        normalized.canonicalUrl ?? `${normalized.registrableDomain}:${ordinal}`,
      );
    }
  });

  result.search_results.forEach((searchResult, ordinal) => {
    const normalized = normalizeUrl(searchResult.url ?? searchResult.domain);
    statements.push(
      shard
        .prepare(
          `INSERT INTO snapshot_search_results (
            id, snapshot_id, ordinal, title, description, breadcrumb, raw_domain,
            hostname, registrable_domain, raw_url, canonical_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          snapshotId,
          ordinal,
          safeText(searchResult.title, 10_000),
          safeText(searchResult.description, 50_000),
          safeText(searchResult.breadcrumb, 2_000),
          searchResult.domain ?? null,
          normalized.hostname,
          normalized.registrableDomain,
          normalized.rawUrl,
          normalized.canonicalUrl,
        ),
    );
    if (normalized.registrableDomain) {
      domainFact(normalized.registrableDomain, normalized.hostname).retrievedCount += 1;
      distinctRetrieved.add(
        normalized.canonicalUrl ?? `${normalized.registrableDomain}:${ordinal}`,
      );
    }
  });

  const matchedBrands = new Set<string>();
  const matchedOwnedBrands = new Set<string>();
  result.brand_entities.forEach((entity, ordinal) => {
    const normalizedTitle = normalizeBrand(entity.title);
    const trackedBrand = brandAliases.get(normalizedTitle);
    const entityId = crypto.randomUUID();
    if (trackedBrand) {
      matchedBrands.add(trackedBrand.id);
      if (trackedBrand.kind === "owned") matchedOwnedBrands.add(trackedBrand.id);
    }
    statements.push(
      shard
        .prepare(
          `INSERT INTO snapshot_brand_entities (
            id, snapshot_id, ordinal, title, normalized_title, category,
            markdown, matched_tracked_brand_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          entityId,
          snapshotId,
          ordinal,
          entity.title,
          normalizedTitle,
          entity.category ?? null,
          safeText(entity.markdown, 50_000),
          trackedBrand?.id ?? null,
        ),
    );
    entity.urls.forEach((url, urlOrdinal) => {
      const normalized = normalizeUrl(url.url ?? url.domain);
      statements.push(
        shard
          .prepare(
            `INSERT INTO brand_entity_urls (
              id, brand_entity_id, ordinal, raw_url, canonical_url,
              hostname, registrable_domain
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            entityId,
            urlOrdinal,
            normalized.rawUrl,
            normalized.canonicalUrl,
            normalized.hostname,
            normalized.registrableDomain,
          ),
      );
      if (normalized.registrableDomain) {
        domainFact(normalized.registrableDomain, normalized.hostname).brandUrlCount += 1;
      }
    });
  });
  for (const brand of brands) {
    const aliases = jsonParse<string[]>(brand.aliases_json, []);
    if (matchedBrandTerms(result.markdown ?? "", brand.name, aliases).length === 0) {
      continue;
    }
    matchedBrands.add(brand.id);
    if (brand.kind === "owned") matchedOwnedBrands.add(brand.id);
  }

  let productsCount = 0;
  result.items.forEach((item, ordinal) => {
    const itemId = crypto.randomUUID();
    statements.push(
      shard
        .prepare(
          `INSERT INTO snapshot_items (
            id, snapshot_id, ordinal, type, rank_group, rank_absolute,
            markdown, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          itemId,
          snapshotId,
          ordinal,
          item.type,
          item.rank_group ?? null,
          item.rank_absolute ?? null,
          safeText(item.markdown, 100_000),
          safeText(JSON.stringify(item), 200_000) ?? "{}",
        ),
    );
    if (item.type === "chat_gpt_ad") {
      const ad = normalizeAdItem(item);
      if (ad) {
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
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              crypto.randomUUID(),
              snapshotId,
              itemId,
              ordinal,
              ad.rankGroup,
              ad.rankAbsolute,
              ad.advertiserIdentity,
              ad.advertiserKey,
              ad.advertiserName,
              ad.advertiserRawUrl,
              ad.advertiserCanonicalUrl,
              ad.advertiserHostname,
              ad.advertiserDomain,
              ad.title,
              ad.snippet,
              ad.rawUrl,
              ad.canonicalUrl,
              ad.destinationHostname,
              ad.destinationDomain,
              ad.imageSourceUrl,
              ad.faviconSourceUrl,
              ad.creativeIdentity,
              ad.creativeKey,
              ad.isRendered ? 1 : 0,
            ),
        );
      }
      return;
    }
    if (item.type !== "chat_gpt_products") return;
    (item.items ?? []).forEach((product, productOrdinal) => {
      const merchants = productText(product.merchants);
      const normalized = normalizeUrl(productText(product.url) ?? productText(product.domain));
      const attributedDomains = new Set(extractDomainsFromText(merchants));
      if (normalized.registrableDomain) attributedDomains.add(normalized.registrableDomain);
      if (merchants) {
        for (const brand of brands) {
          const aliases = jsonParse<string[]>(brand.aliases_json, []);
          if (matchedBrandTerms(merchants, brand.name, aliases).length === 0) continue;
          for (const domain of brandDomains.get(brand.id) ?? []) {
            attributedDomains.add(domain);
          }
        }
      }
      const primaryDomain =
        normalized.registrableDomain ?? attributedDomains.values().next().value ?? null;
      const primaryHostname = normalized.hostname ?? primaryDomain;
      const rating =
        typeof product.rating === "object" && product.rating !== null
          ? (product.rating as Record<string, unknown>)
          : {};
      productsCount += 1;
      statements.push(
        shard
          .prepare(
            `INSERT INTO snapshot_products (
              id, snapshot_id, snapshot_item_id, ordinal, rank_absolute,
              provider_product_id, merchants, id_to_token_map, title, price,
              currency, tag, raw_url, canonical_url, hostname, registrable_domain,
              rating_value, rating_votes_count, rating_max, images_json, product_ids_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            snapshotId,
            itemId,
            productOrdinal,
            item.rank_absolute ?? null,
            productText(product.product_id),
            merchants,
            productText(product.id_to_token_map),
            productText(product.title),
            productNumber(product.price),
            productText(product.currency),
            productText(product.tag),
            normalized.rawUrl,
            normalized.canonicalUrl,
            primaryHostname,
            primaryDomain,
            productNumber(rating.value),
            productNumber(rating.votes_count),
            productNumber(rating.rating_max),
            JSON.stringify(Array.isArray(product.images) ? product.images : []),
            JSON.stringify(Array.isArray(product.product_ids) ? product.product_ids : []),
          ),
      );
      for (const domain of attributedDomains) {
        domainFact(
          domain,
          domain === normalized.registrableDomain ? normalized.hostname : domain,
        ).productCount += 1;
      }
    });
  });

  for (const [domain, facts] of domainFacts) {
    statements.push(
      shard
        .prepare(
          `INSERT INTO snapshot_domains (
            snapshot_id, registrable_domain, hostname, cited_count, retrieved_count,
            brand_url_count, product_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          snapshotId,
          domain,
          facts.hostname,
          facts.citedCount,
          facts.retrievedCount,
          facts.brandUrlCount,
          facts.productCount,
        ),
    );
    metricDomains[domain] = {
      citedSnapshotCount: facts.citedCount > 0 ? 1 : 0,
      citationCount: facts.citedCount,
      retrievedSnapshotCount: facts.retrievedCount > 0 ? 1 : 0,
      retrievalCount: facts.retrievedCount,
      productCount: facts.productCount,
    };
  }

  const citedOwnedDomain = [...domainFacts.entries()].some(
    ([domain, facts]) => ownedDomains.has(domain) && facts.citedCount > 0,
  );
  const metricPayload: MetricPayload = {
    snapshotId,
    projectId: job.project_id,
    trackedQueryId: job.tracked_query_id,
    metricDate: capturedAt.slice(0, 10),
    completedRuns: 1,
    citedRuns: citedOwnedDomain ? 1 : 0,
    brandMentionedRuns: matchedOwnedBrands.size > 0 ? 1 : 0,
    productRuns: productsCount > 0 ? 1 : 0,
    totalCitations: distinctCitations.size,
    domains: metricDomains,
    brands: [...matchedBrands],
  };
  statements.push(
    shard
      .prepare(
        `INSERT INTO metric_outbox (
          snapshot_id, project_id, tracked_query_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        snapshotId,
        job.project_id,
        job.tracked_query_id,
        JSON.stringify(metricPayload),
        createdAt,
      ),
  );
  if (await promptPurgeRequested(env.CONTROL_DB, job.tracked_query_id)) {
    await env.EVIDENCE_BUCKET.delete(
      uniqueEvidenceKeys(message.rawR2Key, htmlR2Key),
    );
    return null;
  }
  await shard.batch(statements);

  if (await promptPurgeRequested(env.CONTROL_DB, job.tracked_query_id)) {
    await shard.prepare("DELETE FROM snapshots WHERE id = ?").bind(snapshotId).run();
    await env.EVIDENCE_BUCKET.delete(
      uniqueEvidenceKeys(message.rawR2Key, htmlR2Key),
    );
    return null;
  }

  try {
    await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO snapshot_index (
        id, crawl_job_id, workspace_id, project_id, tracked_query_id, shard_id,
        dataforseo_task_id, captured_at, model, check_url, answer_hash,
        cited_domains_count, retrieved_domains_count, brand_entities_count,
        products_count, has_product_block, raw_r2_key, html_r2_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      snapshotId,
      job.id,
      job.workspace_id,
      job.project_id,
      job.tracked_query_id,
      job.shard_id,
      message.taskId,
      capturedAt,
      result.model ?? null,
      result.check_url ?? null,
      answerHash,
      [...domainFacts.values()].filter((facts) => facts.citedCount > 0).length,
      [...domainFacts.values()].filter((facts) => facts.retrievedCount > 0).length,
      result.brand_entities.length,
      productsCount,
      productsCount > 0 ? 1 : 0,
      message.rawR2Key,
      htmlR2Key,
      createdAt,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE crawl_jobs SET
        status = 'completed', dataforseo_task_id = ?, completed_at = ?,
        raw_r2_key = ?, html_r2_key = ?,
        error_code = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
    ).bind(
      message.taskId,
      nowIso(),
      message.rawR2Key,
      htmlR2Key,
      nowIso(),
      job.id,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE shard_registry SET
        completed_snapshots = completed_snapshots + 1, updated_at = ?
       WHERE shard_id = ?`,
    ).bind(nowIso(), job.shard_id),
    env.CONTROL_DB.prepare(
      `INSERT INTO ingest_events (
        id, crawl_job_id, dataforseo_task_id, event_type, status, r2_key, received_at
      ) VALUES (?, ?, ?, 'normalized', 'completed', ?, ?)`,
    ).bind(crypto.randomUUID(), job.id, message.taskId, message.rawR2Key, nowIso()),
    ]);
  } catch (error) {
    if (await promptPurgeRequested(env.CONTROL_DB, job.tracked_query_id)) {
      await shard.prepare("DELETE FROM snapshots WHERE id = ?").bind(snapshotId).run();
      await env.EVIDENCE_BUCKET.delete(
        uniqueEvidenceKeys(message.rawR2Key, htmlR2Key),
      );
      return null;
    }
    throw error;
  }

  await env.ROLLUP_QUEUE.send({
    snapshotId,
    shardId: job.shard_id,
  } satisfies RollupQueueMessage);
  await enqueueEntityExtractionForSnapshot(env, {
    id: snapshotId,
    workspaceId: job.workspace_id,
    projectId: job.project_id,
    trackedQueryId: job.tracked_query_id,
    shardId: job.shard_id,
  });
  return snapshotId;
}

export async function normalizeBatch(
  env: Env,
  batch: MessageBatch<NormalizeQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await normalizeSnapshot(env, message.body);
      message.ack();
    } catch (error) {
      await env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET
          status = 'failed', error_code = 'normalization_failed',
          error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(String(error).slice(0, 1000), nowIso(), message.body.jobId)
        .run();
      message.retry({ delaySeconds: Math.min(300, 30 * 2 ** message.attempts) });
    }
  }
}
