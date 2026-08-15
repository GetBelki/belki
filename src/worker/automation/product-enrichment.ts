import type { ProductEnrichmentQueueMessage } from "../../shared/contracts";
import { createScopedSignedJobTag, verifyScopedSignedJobTag } from "../lib/crypto";
import {
  getProductInfoTaskResult,
  getProductInfoTasksReady,
  parseProductInfoPayload,
  postProductInfoTask,
} from "../lib/dataforseo-merchant";
import { platformDataForSeoCredentials } from "../lib/provider-credentials";
import { commitUsage, releaseUsage, reserveUsage, USAGE_UNITS } from "../lib/usage";
import { normalizeUrl } from "../lib/domain";
import { ApiError, jsonParse, nowIso } from "../lib/http";
import {
  finiteInteger,
  finiteNumber,
  googleProductIdentifiers,
  productEnrichmentDue,
} from "../lib/product-enrichment";

const TAG_SCOPE = "product";
const ACTIVE_STATUSES = new Set([
  "queued",
  "submitting",
  "submission_unknown",
  "awaiting_result",
  "normalizing",
]);

type EnrichmentReason = "observation" | "view" | "manual" | "recovery";

interface TargetRow {
  id: string;
  workspace_id: string;
  project_id: string;
  product_identity: string;
  product_key: string;
  location_code: number;
  language_code: string;
  google_product_id: string | null;
  data_docid: string | null;
  gid: string | null;
  status: string;
  current_job_id: string | null;
  last_success_at: string | null;
  next_refresh_at: string | null;
}

interface JobRow {
  id: string;
  target_id: string;
  workspace_id: string;
  project_id: string;
  reason: EnrichmentReason;
  priority: 1 | 2;
  status: string;
  provider_tag: string;
  provider_task_id: string | null;
  submit_attempts: number;
  public_base_url: string;
  product_enrichment_enabled: number;
  automatic_refresh_enabled: number;
  location_code: number;
  language_code: string;
  google_product_id: string | null;
  data_docid: string | null;
  gid: string | null;
}

function providerDate(value: unknown): string {
  if (typeof value !== "string" || !value) return nowIso();
  const normalized = value
    .replace(/^(\d{4}-\d{2}-\d{2}) /u, "$1T")
    .replace(" +00:00", "Z");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
}

function text(value: unknown, maximum = 50_000): string | null {
  return typeof value === "string" && value.trim()
    ? value.slice(0, maximum)
    : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
      )
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

async function projectAllowsEnrichment(env: Env, projectId: string): Promise<boolean> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT product_enrichment_enabled FROM projects
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(projectId)
    .first<{ product_enrichment_enabled: number }>();
  return row?.product_enrichment_enabled === 1;
}

async function autoRefreshEnabled(
  env: Env,
  projectId: string,
  productIdentity: string,
): Promise<boolean> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT automatic_refresh_enabled FROM product_enrichment_preferences
     WHERE project_id = ? AND product_identity = ?`,
  )
    .bind(projectId, productIdentity)
    .first<{ automatic_refresh_enabled: number }>();
  return row?.automatic_refresh_enabled !== 0;
}

function productUsage(jobId: string) {
  return {
    reservationId: jobId,
    sku: "product_enrichment" as const,
    units: USAGE_UNITS.product_enrichment,
    resourceType: "product_enrichment_job",
    resourceId: jobId,
  };
}

async function cancelJob(
  env: Env,
  jobId: string,
  targetId: string,
  workspaceId: string,
  message: string,
): Promise<void> {
  const updatedAt = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE product_enrichment_jobs
       SET status = 'cancelled', active_slot = NULL, error_code = 'enrichment_paused',
         error_message = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'submission_unknown')`,
    ).bind(message, updatedAt, jobId),
    env.CONTROL_DB.prepare(
      `UPDATE product_enrichment_targets
       SET status = 'paused', current_job_id = NULL, updated_at = ?
       WHERE id = ? AND current_job_id = ?`,
    ).bind(updatedAt, targetId, jobId),
  ]);
  try {
    await releaseUsage(env, workspaceId, productUsage(jobId));
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "product_usage_release_failed",
      jobId,
      error: String(error),
    }));
  }
}

async function failJob(
  env: Env,
  jobId: string,
  targetId: string,
  code: string,
  message: string,
): Promise<void> {
  const updatedAt = nowIso();
  const nextRefreshAt = new Date(Date.parse(updatedAt) + 86_400_000).toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE product_enrichment_jobs
       SET status = 'failed', active_slot = NULL, error_code = ?, error_message = ?,
         completed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(code, message.slice(0, 2_000), updatedAt, updatedAt, jobId),
    env.CONTROL_DB.prepare(
      `UPDATE product_enrichment_targets
       SET status = CASE WHEN latest_snapshot_id IS NULL THEN 'failed' ELSE 'available' END,
         current_job_id = NULL, next_refresh_at = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND current_job_id = ?`,
    ).bind(nextRefreshAt, message.slice(0, 2_000), updatedAt, targetId, jobId),
  ]);
}

async function queueTarget(
  env: Env,
  target: TargetRow,
  reason: EnrichmentReason,
): Promise<{ jobId: string | null; status: string }> {
  if (!(await projectAllowsEnrichment(env, target.project_id))) {
    return { jobId: null, status: "project_paused" };
  }
  if (reason !== "manual" && !(await autoRefreshEnabled(env, target.project_id, target.product_identity))) {
    return { jobId: null, status: "product_paused" };
  }
  if (!target.google_product_id && !target.data_docid && !target.gid) {
    return { jobId: null, status: "unsupported" };
  }
  if (target.current_job_id && ACTIVE_STATUSES.has(target.status)) {
    return { jobId: target.current_job_id, status: target.status };
  }
  if (
    reason !== "manual" &&
    target.next_refresh_at &&
    Date.parse(target.next_refresh_at) > Date.now()
  ) {
    return { jobId: null, status: "deferred" };
  }
  if (reason !== "manual" && !productEnrichmentDue(target.last_success_at)) {
    return { jobId: null, status: "fresh" };
  }

  const jobId = crypto.randomUUID();
  const providerTag = await createScopedSignedJobTag(TAG_SCOPE, jobId, env.APP_CRYPTO_KEY);
  const createdAt = nowIso();
  try {
    await reserveUsage(env, target.workspace_id, productUsage(jobId));
  } catch (error) {
    if (reason !== "manual" && error instanceof ApiError && ["usage_limit", "payment_required", "read_only"].includes(error.code)) {
      return { jobId: null, status: "allowance_exhausted" };
    }
    throw error;
  }
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `INSERT INTO product_enrichment_jobs (
          id, target_id, active_slot, workspace_id, project_id, product_identity,
          reason, priority, status, provider_tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      ).bind(
        jobId,
        target.id,
        target.id,
        target.workspace_id,
        target.project_id,
        target.product_identity,
        reason,
        reason === "manual" ? 2 : 1,
        providerTag,
        createdAt,
        createdAt,
      ),
      env.CONTROL_DB.prepare(
        `UPDATE product_enrichment_targets
         SET status = 'queued', current_job_id = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      ).bind(jobId, createdAt, target.id),
    ]);
  } catch {
    const existing = await env.CONTROL_DB.prepare(
      `SELECT id, status FROM product_enrichment_jobs
       WHERE target_id = ? AND active_slot = ?`,
    )
      .bind(target.id, target.id)
      .first<{ id: string; status: string }>();
    await releaseUsage(env, target.workspace_id, productUsage(jobId));
    if (existing) return { jobId: existing.id, status: existing.status };
    throw new Error("Unable to queue product enrichment");
  }
  await env.PRODUCT_ENRICHMENT_QUEUE.send({ kind: "submit", jobId } satisfies ProductEnrichmentQueueMessage);
  return { jobId, status: "queued" };
}

export async function ensureProductEnrichmentTarget(
  env: Env,
  input: {
    workspaceId: string;
    projectId: string;
    productIdentity: string;
    productKey: string;
    locationCode: number;
    languageCode: string;
    productIds: unknown;
    activity: "observation" | "view";
    activityAt?: string;
    queue?: boolean;
  },
): Promise<{ target: TargetRow; jobId: string | null; status: string }> {
  const identifiers = googleProductIdentifiers(input.productIds);
  const activityAt = input.activityAt ?? nowIso();
  const existing = await env.CONTROL_DB.prepare(
    `SELECT * FROM product_enrichment_targets
     WHERE project_id = ? AND product_identity = ? AND location_code = ? AND language_code = ?`,
  )
    .bind(input.projectId, input.productIdentity, input.locationCode, input.languageCode)
    .first<TargetRow>();
  const targetId = existing?.id ?? crypto.randomUUID();
  const createdAt = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO product_enrichment_preferences (
        project_id, product_identity, automatic_refresh_enabled, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?)`,
    ).bind(input.projectId, input.productIdentity, createdAt, createdAt),
    env.CONTROL_DB.prepare(
      `INSERT INTO product_enrichment_targets (
        id, workspace_id, project_id, product_identity, product_key,
        location_code, language_code, google_product_id, data_docid, gid,
        last_seen_at, last_opened_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, product_identity, location_code, language_code) DO UPDATE SET
        product_key = excluded.product_key,
        google_product_id = COALESCE(excluded.google_product_id, product_enrichment_targets.google_product_id),
        data_docid = COALESCE(excluded.data_docid, product_enrichment_targets.data_docid),
        gid = COALESCE(excluded.gid, product_enrichment_targets.gid),
        last_seen_at = COALESCE(excluded.last_seen_at, product_enrichment_targets.last_seen_at),
        last_opened_at = COALESCE(excluded.last_opened_at, product_enrichment_targets.last_opened_at),
        status = CASE
          WHEN product_enrichment_targets.status IN ('queued','submitting','awaiting_result','normalizing','available')
            THEN product_enrichment_targets.status
          WHEN excluded.google_product_id IS NULL AND excluded.data_docid IS NULL AND excluded.gid IS NULL
            THEN 'unsupported'
          ELSE 'idle'
        END,
        updated_at = excluded.updated_at`,
    ).bind(
      targetId,
      input.workspaceId,
      input.projectId,
      input.productIdentity,
      input.productKey,
      input.locationCode,
      input.languageCode,
      identifiers?.productId ?? null,
      identifiers?.dataDocid ?? null,
      identifiers?.gid ?? null,
      input.activity === "observation" ? activityAt : null,
      input.activity === "view" ? activityAt : null,
      identifiers ? "idle" : "unsupported",
      createdAt,
      createdAt,
    ),
  ]);
  const target = await env.CONTROL_DB.prepare(
    "SELECT * FROM product_enrichment_targets WHERE id = ?",
  )
    .bind(targetId)
    .first<TargetRow>();
  if (!target) throw new Error("Product enrichment target was not created");
  const queued = input.queue === false
    ? { jobId: null, status: target.status }
    : await queueTarget(env, target, input.activity);
  return { target, ...queued };
}

export async function registerSnapshotProductsForEnrichment(
  env: Env,
  snapshotId: string,
): Promise<number> {
  const rows = await env.CONTROL_DB.prepare(
    `SELECT p.project_id, project.workspace_id, p.product_identity, p.product_key,
      q.location_code, q.language_code, p.product_ids_json, p.captured_at
     FROM analytics_product_occurrences p
     JOIN tracked_queries q ON q.id = p.tracked_query_id
     JOIN projects project ON project.id = p.project_id
     WHERE p.snapshot_id = ?`,
  )
    .bind(snapshotId)
    .all<{
      project_id: string;
      workspace_id: string;
      product_identity: string;
      product_key: string;
      location_code: number;
      language_code: string;
      product_ids_json: string;
      captured_at: string;
    }>();
  let queued = 0;
  for (const row of rows.results) {
    const result = await ensureProductEnrichmentTarget(env, {
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      productIdentity: row.product_identity,
      productKey: row.product_key,
      locationCode: row.location_code,
      languageCode: row.language_code,
      productIds: jsonParse<unknown[]>(row.product_ids_json, []),
      activity: "observation",
      activityAt: row.captured_at,
    });
    if (result.jobId) queued += 1;
  }
  return queued;
}

export async function requestTargetRefresh(
  env: Env,
  targetId: string,
  manual: boolean,
): Promise<{ jobId: string | null; status: string }> {
  const target = await env.CONTROL_DB.prepare(
    "SELECT * FROM product_enrichment_targets WHERE id = ?",
  )
    .bind(targetId)
    .first<TargetRow>();
  if (!target) throw new Error("Product enrichment target not found");
  return queueTarget(env, target, manual ? "manual" : "view");
}

export async function enqueueDueProductEnrichments(env: Env): Promise<number> {
  const targets = await env.CONTROL_DB.prepare(
    `SELECT target.id
     FROM product_enrichment_targets target
     JOIN projects project ON project.id = target.project_id
     LEFT JOIN product_enrichment_preferences preference
       ON preference.project_id = target.project_id
      AND preference.product_identity = target.product_identity
     WHERE project.product_enrichment_enabled = 1
       AND project.deleted_at IS NULL
       AND COALESCE(preference.automatic_refresh_enabled, 1) = 1
       AND target.current_job_id IS NULL
       AND (target.google_product_id IS NOT NULL OR target.data_docid IS NOT NULL OR target.gid IS NOT NULL)
       AND julianday(target.last_seen_at) >= julianday('now', '-30 days')
       AND (target.next_refresh_at IS NULL OR target.next_refresh_at <= ?)
     ORDER BY COALESCE(target.next_refresh_at, target.created_at) ASC
     LIMIT 200`,
  )
    .bind(nowIso())
    .all<{ id: string }>();
  let queued = 0;
  for (const target of targets.results) {
    const result = await requestTargetRefresh(env, target.id, false);
    if (result.jobId) queued += 1;
  }
  return queued;
}

async function loadJob(env: Env, jobId: string): Promise<JobRow | null> {
  return env.CONTROL_DB.prepare(
    `SELECT job.id, job.target_id, job.workspace_id, job.project_id, job.reason,
      job.priority, job.status, job.provider_tag, job.provider_task_id,
      job.submit_attempts, workspace.public_base_url,
      project.product_enrichment_enabled,
      COALESCE(preference.automatic_refresh_enabled, 1) AS automatic_refresh_enabled,
      target.location_code, target.language_code, target.google_product_id,
      target.data_docid, target.gid
     FROM product_enrichment_jobs job
     JOIN product_enrichment_targets target ON target.id = job.target_id
     JOIN workspaces workspace ON workspace.id = job.workspace_id
     JOIN projects project ON project.id = job.project_id
     LEFT JOIN product_enrichment_preferences preference
       ON preference.project_id = job.project_id
      AND preference.product_identity = job.product_identity
     WHERE job.id = ?`,
  )
    .bind(jobId)
    .first<JobRow>();
}

async function submitJob(env: Env, jobId: string): Promise<void> {
  const job = await loadJob(env, jobId);
  // An ambiguous response may still represent a charged, accepted provider task.
  // Recover it by signed tag through tasks_ready instead of risking a duplicate POST.
  if (!job || job.status !== "queued") return;
  if (job.product_enrichment_enabled !== 1) {
    await cancelJob(env, job.id, job.target_id, job.workspace_id, "Project product enrichment is paused.");
    return;
  }
  if (job.reason !== "manual" && job.automatic_refresh_enabled !== 1) {
    await cancelJob(env, job.id, job.target_id, job.workspace_id, "Automatic enrichment is paused for this product.");
    return;
  }
  const updatedAt = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE product_enrichment_jobs SET status = 'submitting',
        submit_attempts = submit_attempts + 1, updated_at = ? WHERE id = ?`,
    ).bind(updatedAt, job.id),
    env.CONTROL_DB.prepare(
      "UPDATE product_enrichment_targets SET status = 'submitting', updated_at = ? WHERE id = ?",
    ).bind(updatedAt, job.target_id),
  ]);
  try {
    const response = await postProductInfoTask(platformDataForSeoCredentials(env), {
      ...(job.google_product_id ? { product_id: job.google_product_id } : {}),
      ...(job.data_docid ? { data_docid: job.data_docid } : {}),
      ...(job.gid ? { gid: job.gid } : {}),
      location_code: job.location_code,
      language_code: job.language_code,
      priority: job.priority,
      tag: job.provider_tag,
      postback_url: `${job.public_base_url}/api/webhooks/dataforseo/product-info?token=${encodeURIComponent(env.DATAFORSEO_WEBHOOK_TOKEN)}&id=$id&tag=$tag`,
      postback_data: "advanced",
    });
    const task = response.tasks[0];
    const accepted = task?.id && [20000, 20100].includes(task.status_code ?? 0);
    if (!accepted) {
      await failJob(
        env,
        job.id,
        job.target_id,
        "provider_rejected",
        task?.status_message ?? response.status_message ?? "DataForSEO rejected product enrichment.",
      );
      await releaseUsage(env, job.workspace_id, productUsage(job.id));
      return;
    }
    const submittedAt = nowIso();
    await commitUsage(env, job.workspace_id, productUsage(job.id));
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE product_enrichment_jobs SET status = 'awaiting_result', provider_task_id = ?,
          request_cost_usd = ?, task_status_code = ?, task_status_message = ?,
          submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'submitting'`,
      ).bind(
        task.id,
        task.cost ?? null,
        task.status_code ?? null,
        task.status_message ?? null,
        submittedAt,
        submittedAt,
        job.id,
      ),
      env.CONTROL_DB.prepare(
        `UPDATE product_enrichment_targets SET status = 'awaiting_result', updated_at = ?
         WHERE id = ? AND status = 'submitting'`,
      ).bind(submittedAt, job.target_id),
    ]);
  } catch (error) {
    const message = String(error).slice(0, 2_000);
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE product_enrichment_jobs SET status = 'submission_unknown',
          error_code = 'submission_ambiguous', error_message = ?, updated_at = ?
         WHERE id = ? AND status = 'submitting'`,
      ).bind(message, nowIso(), job.id),
      env.CONTROL_DB.prepare(
        `UPDATE product_enrichment_targets SET status = 'queued', last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'submitting'`,
      ).bind(message, nowIso(), job.target_id),
    ]);
    throw error;
  }
}

async function readRawPayload(
  env: Env,
  message: Extract<ProductEnrichmentQueueMessage, { kind: "normalize" }>,
): Promise<unknown> {
  const object = await env.EVIDENCE_BUCKET.get(message.rawR2Key);
  if (!object) throw new Error(`Raw enrichment evidence not found: ${message.rawR2Key}`);
  if (object.size > 20 * 1024 * 1024) throw new Error("Raw enrichment evidence exceeds limit");
  let stream: ReadableStream = object.body;
  if (message.contentEncoding === "gzip") stream = stream.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

async function normalizeJob(
  env: Env,
  message: Extract<ProductEnrichmentQueueMessage, { kind: "normalize" }>,
): Promise<void> {
  const job = await loadJob(env, message.jobId);
  if (!job || job.status === "completed" || job.status === "cancelled") return;
  const payload = parseProductInfoPayload(await readRawPayload(env, message));
  const task = payload.tasks.find((candidate) => candidate.id === message.taskId) ?? payload.tasks[0];
  const result = records(task?.result)[0];
  const item = records(result?.items).find((candidate) => candidate.type === "product_info_element") ?? records(result?.items)[0];
  if (!task || !result || !item) {
    await failJob(
      env,
      job.id,
      job.target_id,
      "no_product_info",
      task?.status_message ?? "DataForSEO returned no product information.",
    );
    return;
  }
  const rating = typeof item.rating === "object" && item.rating !== null
    ? item.rating as Record<string, unknown>
    : {};
  const offers = records(item.sellers);
  const [project, ownedBrands] = await Promise.all([
    env.CONTROL_DB.prepare("SELECT primary_domain FROM projects WHERE id = ?")
      .bind(job.project_id)
      .first<{ primary_domain: string | null }>(),
    env.CONTROL_DB.prepare(
      "SELECT domains_json FROM tracked_brands WHERE project_id = ? AND kind = 'owned'",
    )
      .bind(job.project_id)
      .all<{ domains_json: string }>(),
  ]);
  const ownedDomains = new Set<string>();
  if (project?.primary_domain) ownedDomains.add(project.primary_domain);
  for (const brand of ownedBrands.results) {
    for (const domain of jsonParse<string[]>(brand.domains_json, [])) ownedDomains.add(domain);
  }
  const capturedAt = providerDate(result.datetime);
  const snapshotId = crypto.randomUUID();
  const createdAt = nowIso();
  const normalizedOffers = offers.map((offer, ordinal) => {
    const sellerRating = typeof offer.seller_rating === "object" && offer.seller_rating !== null
      ? offer.seller_rating as Record<string, unknown>
      : {};
    const price = typeof offer.price === "object" && offer.price !== null
      ? offer.price as Record<string, unknown>
      : {};
    const delivery = typeof offer.delivery_info === "object" && offer.delivery_info !== null
      ? offer.delivery_info as Record<string, unknown>
      : {};
    const normalizedUrl = normalizeUrl(text(offer.url));
    return {
      id: crypto.randomUUID(),
      ordinal,
      sellerName: text(offer.title, 2_000),
      sellerUrl: normalizedUrl.rawUrl,
      sellerDomain: normalizedUrl.registrableDomain,
      sellerRatingValue: finiteNumber(sellerRating.value),
      sellerRatingVotes: finiteInteger(sellerRating.votes_count),
      sellerRatingMax: finiteNumber(sellerRating.rating_max),
      sellerReviews: finiteInteger(offer.seller_reviews_count ?? offer.seller_review_count),
      current: finiteNumber(price.current),
      regular: finiteNumber(price.regular),
      maximum: finiteNumber(price.max_value),
      currency: text(price.currency, 20),
      isRange: price.is_price_range === true ? 1 : 0,
      displayedPrice: text(price.displayed_price, 2_000),
      deliveryMessage: text(delivery.delivery_message, 2_000),
      deliveryJson: JSON.stringify(delivery),
      availability: text(offer.product_availability, 100),
      isOwned: normalizedUrl.registrableDomain && ownedDomains.has(normalizedUrl.registrableDomain) ? 1 : 0,
    };
  });
  const inStockCount = normalizedOffers.filter((offer) => offer.availability === "in_stock").length;
  const nextRefreshAt = new Date(Date.parse(capturedAt) + 7 * 86_400_000).toISOString();
  const statements: D1PreparedStatement[] = [
    env.CONTROL_DB.prepare(
      `INSERT INTO product_market_snapshots (
        id, job_id, target_id, captured_at, provider_product_id, data_docid, gid,
        se_domain, check_url, product_url, title, description, tags_json, images_json,
        features_json, specifications_json, variations_json, rating_value,
        rating_votes_count, rating_max, seller_reviews_count, seller_count,
        in_stock_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      snapshotId,
      job.id,
      job.target_id,
      capturedAt,
      text(item.product_id),
      text(item.data_docid),
      text(item.gid),
      text(result.se_domain),
      text(result.check_url),
      text(item.url),
      text(item.title ?? result.title, 20_000),
      text(item.description ?? result.description, 100_000),
      JSON.stringify(strings(result.tags ?? item.tags)),
      JSON.stringify(strings(item.images ?? (result.image_url ? [result.image_url] : []))),
      JSON.stringify(strings(item.features)),
      JSON.stringify(records(item.specifications)),
      JSON.stringify(records(item.variations)),
      finiteNumber(rating.value),
      finiteInteger(rating.votes_count),
      finiteNumber(rating.rating_max),
      finiteInteger(item.seller_reviews_count),
      normalizedOffers.length,
      inStockCount,
      createdAt,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE product_enrichment_jobs SET status = 'completed', active_slot = NULL,
        provider_task_id = COALESCE(provider_task_id, ?), raw_r2_key = ?,
        task_status_code = ?, task_status_message = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      message.taskId,
      message.rawR2Key,
      task.status_code ?? null,
      task.status_message ?? null,
      createdAt,
      createdAt,
      job.id,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE product_enrichment_targets SET status = 'available', current_job_id = NULL,
        latest_snapshot_id = ?, last_success_at = ?, next_refresh_at = ?,
        last_error = NULL, updated_at = ? WHERE id = ?`,
    ).bind(snapshotId, capturedAt, nextRefreshAt, createdAt, job.target_id),
  ];
  for (const offer of normalizedOffers) {
    statements.push(
      env.CONTROL_DB.prepare(
        `INSERT INTO product_market_offers (
          id, snapshot_id, ordinal, seller_name, seller_url, seller_domain,
          seller_rating_value, seller_rating_votes_count, seller_rating_max,
          seller_reviews_count, price_current, price_regular, price_max, currency,
          is_price_range, displayed_price, delivery_message, delivery_json,
          availability, is_owned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        offer.id,
        snapshotId,
        offer.ordinal,
        offer.sellerName,
        offer.sellerUrl,
        offer.sellerDomain,
        offer.sellerRatingValue,
        offer.sellerRatingVotes,
        offer.sellerRatingMax,
        offer.sellerReviews,
        offer.current,
        offer.regular,
        offer.maximum,
        offer.currency,
        offer.isRange,
        offer.displayedPrice,
        offer.deliveryMessage,
        offer.deliveryJson,
        offer.availability,
        offer.isOwned,
      ),
    );
  }
  for (let index = 0; index < statements.length; index += 100) {
    await env.CONTROL_DB.batch(statements.slice(index, index + 100));
  }
}

export async function productEnrichmentBatch(
  env: Env,
  batch: MessageBatch<ProductEnrichmentQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (message.body.kind === "submit") await submitJob(env, message.body.jobId);
      else await normalizeJob(env, message.body);
      message.ack();
    } catch {
      message.retry({ delaySeconds: Math.min(600, 30 * 2 ** message.attempts) });
    }
  }
}

export async function acceptProductInfoPayload(
  env: Env,
  input: {
    jobId: string;
    taskId: string;
    body: ReadableStream;
    contentEncoding: "gzip" | "identity";
  },
): Promise<boolean> {
  const job = await env.CONTROL_DB.prepare(
    `SELECT id, workspace_id, project_id FROM product_enrichment_jobs
     WHERE id = ? AND status IN ('submitting', 'submission_unknown', 'awaiting_result')`,
  )
    .bind(input.jobId)
    .first<{ id: string; workspace_id: string; project_id: string }>();
  if (!job) return false;
  const rawR2Key = `raw/product-info/${job.workspace_id}/${job.project_id}/${new Date().toISOString().slice(0, 7)}/${input.taskId}.json${
    input.contentEncoding === "gzip" ? ".gz" : ""
  }`;
  await env.EVIDENCE_BUCKET.put(rawR2Key, input.body, {
    httpMetadata: {
      contentType: "application/json",
      ...(input.contentEncoding === "gzip" ? { contentEncoding: "gzip" } : {}),
    },
    customMetadata: { jobId: input.jobId, taskId: input.taskId, source: "product-info-postback" },
  });
  const updatedAt = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE product_enrichment_jobs SET status = 'normalizing',
        provider_task_id = COALESCE(provider_task_id, ?), raw_r2_key = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(input.taskId, rawR2Key, updatedAt, input.jobId),
    env.CONTROL_DB.prepare(
      `UPDATE product_enrichment_targets SET status = 'normalizing', updated_at = ?
       WHERE current_job_id = ?`,
    ).bind(updatedAt, input.jobId),
  ]);
  await env.PRODUCT_ENRICHMENT_QUEUE.send({
    kind: "normalize",
    jobId: input.jobId,
    taskId: input.taskId,
    rawR2Key,
    contentEncoding: input.contentEncoding,
  } satisfies ProductEnrichmentQueueMessage);
  return true;
}

export async function verifyProductEnrichmentTag(
  tag: string,
  env: Env,
): Promise<string | null> {
  return verifyScopedSignedJobTag(tag, TAG_SCOPE, env.APP_CRYPTO_KEY);
}

export async function collectReadyProductInfoTasks(env: Env): Promise<number> {
  const credentials = platformDataForSeoCredentials(env);
  const ready = await getProductInfoTasksReady(credentials);
  let recovered = 0;
  for (const task of ready) {
    if (!task.tag || !task.endpointAdvanced) continue;
    const jobId = await verifyProductEnrichmentTag(task.tag, env);
    if (!jobId) continue;
    const job = await env.CONTROL_DB.prepare(
      `SELECT id, workspace_id, project_id FROM product_enrichment_jobs
       WHERE id = ? AND provider_tag = ?
         AND status IN ('submitting', 'submission_unknown', 'awaiting_result')`,
    )
      .bind(jobId, task.tag)
      .first<{ id: string; workspace_id: string; project_id: string }>();
    if (!job) continue;
    const bytes = await getProductInfoTaskResult(credentials, task.endpointAdvanced);
    const rawR2Key = `raw/product-info/${job.workspace_id}/${job.project_id}/${new Date().toISOString().slice(0, 7)}/${task.id}.json`;
    await env.EVIDENCE_BUCKET.put(rawR2Key, bytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { jobId, taskId: task.id, source: "product-info-recovery" },
    });
    const updatedAt = nowIso();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE product_enrichment_jobs SET status = 'normalizing', provider_task_id = ?,
          raw_r2_key = ?, updated_at = ? WHERE id = ?`,
      ).bind(task.id, rawR2Key, updatedAt, jobId),
      env.CONTROL_DB.prepare(
        `UPDATE product_enrichment_targets SET status = 'normalizing', updated_at = ?
         WHERE current_job_id = ?`,
      ).bind(updatedAt, jobId),
    ]);
    await env.PRODUCT_ENRICHMENT_QUEUE.send({
      kind: "normalize",
      jobId,
      taskId: task.id,
      rawR2Key,
      contentEncoding: "identity",
    } satisfies ProductEnrichmentQueueMessage);
    recovered += 1;
  }
  return recovered;
}

export async function reconcileProductEnrichmentJobs(env: Env): Promise<number> {
  const jobs = await env.CONTROL_DB.prepare(
    `SELECT id FROM product_enrichment_jobs
     WHERE status = 'queued' AND julianday(updated_at) < julianday('now', '-5 minutes')
     ORDER BY updated_at LIMIT 200`,
  ).all<{ id: string }>();
  for (const job of jobs.results) {
    await env.PRODUCT_ENRICHMENT_QUEUE.send({ kind: "submit", jobId: job.id } satisfies ProductEnrichmentQueueMessage);
  }
  const abandoned = await env.CONTROL_DB.prepare(
    `SELECT id, target_id FROM product_enrichment_jobs
     WHERE status = 'submission_unknown'
       AND julianday(updated_at) < julianday('now', '-2 hours')
     ORDER BY updated_at LIMIT 200`,
  ).all<{ id: string; target_id: string }>();
  for (const job of abandoned.results) {
    await failJob(
      env,
      job.id,
      job.target_id,
      "submission_unresolved",
      "The provider submission could not be confirmed without risking a duplicate charge.",
    );
  }
  return jobs.results.length + abandoned.results.length;
}
