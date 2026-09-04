import type {
  JobQueueMessage,
  NormalizeQueueMessage,
  RollupQueueMessage,
  TrackingSource,
} from "../../shared/contracts";
import { createSignedJobTag } from "../lib/crypto";
import { getLocaleCatalog } from "../lib/dataforseo";
import { ApiError, nowIso } from "../lib/http";
import { calculateNextRun, scheduleFromRow } from "../lib/schedule";
import { getShard, SHARD_COUNT } from "../lib/shards";
import { registeredDataForSeoCredentials } from "../providers/dataforseo-credentials";
import { scheduledJobDelivery } from "../lib/job-delivery";
import { releaseUsage, reserveUsage, USAGE_UNITS } from "../lib/usage";
import {
  scheduledForTrackingSource,
} from "../lib/tracking-sources";
import {
  captureProviderJobRoute,
  prepareCaptureProviderAttempt,
  resolveCaptureProviderAccount,
  type ResolvedCaptureProviderAccount,
} from "../providers/accounts";
import { captureProviderDetectedEventStatement } from "../lib/project-events";

interface DueQueryRow {
  id: string;
  workspace_id: string;
  project_id: string;
  shard_id: number;
  next_run_at: string;
  schedule_cadence: string;
  schedule_time: string;
  schedule_timezone: string;
  schedule_weekday: number | null;
  html_capture_enabled: number;
  tracking_source: TrackingSource;
}

export async function enqueueDueQueries(env: Env): Promise<number> {
  const due = await env.CONTROL_DB.prepare(
    `SELECT
      q.id, p.workspace_id, q.project_id, q.shard_id, q.next_run_at,
      q.schedule_cadence, q.schedule_time, q.schedule_timezone,
      q.schedule_weekday, p.html_capture_enabled, source.source AS tracking_source
    FROM tracked_queries q
    JOIN projects p ON p.id = q.project_id
    JOIN project_tracking_sources source ON source.project_id = p.id AND source.enabled = 1
    WHERE q.is_active = 1 AND q.deleted_at IS NULL AND p.deleted_at IS NULL
      AND p.archived_at IS NULL
      AND p.paused_at IS NULL
      AND q.next_run_at <= ?
    ORDER BY q.next_run_at
    LIMIT 5000`,
  )
    .bind(nowIso())
    .all<DueQueryRow>();
  if (due.results.length === 0) return 0;

  const messages: JobQueueMessage[] = [];
  const providerRoutes = new Map<
    TrackingSource,
    Promise<ResolvedCaptureProviderAccount>
  >();
  for (const query of due.results) {
    let resolvedProvider: ResolvedCaptureProviderAccount;
    try {
      let pendingRoute = providerRoutes.get(query.tracking_source);
      if (!pendingRoute) {
        pendingRoute = resolveCaptureProviderAccount(env, query.tracking_source);
        providerRoutes.set(query.tracking_source, pendingRoute);
      }
      resolvedProvider = await pendingRoute;
    } catch (error) {
      if (!(error instanceof ApiError) || ![
        "tracking_source_disabled",
        "capture_provider_unavailable",
      ].includes(error.code)) throw error;
      const nextRunAt = calculateNextRun(
        scheduleFromRow(query),
        new Date(Date.parse(query.next_run_at) + 1),
      );
      await env.CONTROL_DB.prepare(
        "UPDATE tracked_queries SET next_run_at = ?, updated_at = ? WHERE id = ?",
      ).bind(nextRunAt, nowIso(), query.id).run();
      continue;
    }
    const jobId = crypto.randomUUID();
    const providerRoute = captureProviderJobRoute(resolvedProvider);
    const tag = await createSignedJobTag(jobId, env.APP_CRYPTO_KEY);
    const createdAt = nowIso();
    const delivery = scheduledJobDelivery(
      query.tracking_source,
      query.html_capture_enabled === 1,
    );
    const reservation = {
      reservationId: jobId,
      sku: delivery.sku,
      units: USAGE_UNITS[delivery.sku],
      resourceType: "crawl_job",
      resourceId: jobId,
    } as const;
    const nextRunAt = calculateNextRun(
      scheduleFromRow(query),
      new Date(Date.parse(query.next_run_at) + 1),
    );
    try {
      await reserveUsage(env, query.workspace_id, reservation);
    } catch (error) {
      if (
        error instanceof ApiError &&
        ["usage_limit", "payment_required", "read_only"].includes(error.code)
      ) {
        await env.CONTROL_DB.prepare(
          "UPDATE tracked_queries SET next_run_at = ?, updated_at = ? WHERE id = ?",
        ).bind(nextRunAt, createdAt, query.id).run();
        continue;
      }
      throw error;
    }
    try {
      const results = await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare(
          `INSERT OR IGNORE INTO crawl_jobs (
            id, workspace_id, project_id, tracked_query_id, shard_id, tracking_source, run_type,
            delivery_method, status, scheduled_for, provider_tag, capture_html,
            provider_account_id, capture_provider, capture_provider_attempt_id,
            capture_adapter_version, usage_reservation_id, usage_units, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, 'scheduled', ?, 'queued', ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?
          )`,
        ).bind(
          jobId,
          query.workspace_id,
          query.project_id,
          query.id,
          query.shard_id,
          query.tracking_source,
          delivery.deliveryMethod,
          scheduledForTrackingSource(query.next_run_at, query.tracking_source),
          tag,
          delivery.captureHtml ? 1 : 0,
          providerRoute.providerAccountId,
          providerRoute.provider,
          providerRoute.attemptId,
          providerRoute.adapterVersion,
          jobId,
          reservation.units,
          createdAt,
          createdAt,
        ),
        prepareCaptureProviderAttempt(
          env.CONTROL_DB,
          jobId,
          providerRoute,
          createdAt,
        ),
        captureProviderDetectedEventStatement(env.CONTROL_DB, {
          projectId: query.project_id,
          trackingSource: query.tracking_source,
          captureProvider: providerRoute.provider,
          occurredAt: createdAt,
        }),
        env.CONTROL_DB.prepare(
          "UPDATE tracked_queries SET next_run_at = ?, updated_at = ? WHERE id = ?",
        ).bind(nextRunAt, createdAt, query.id),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        await releaseUsage(env, query.workspace_id, reservation);
        continue;
      }
      messages.push({ jobId });
    } catch (error) {
      await releaseUsage(env, query.workspace_id, reservation);
      throw error;
    }
  }
  for (let start = 0; start < messages.length; start += 100) {
    await env.STANDARD_QUEUE.sendBatch(
      messages.slice(start, start + 100).map((body) => ({ body })),
    );
  }
  return messages.length;
}

export async function reconcileJobs(env: Env): Promise<number> {
  const stale = await env.CONTROL_DB.prepare(
    `SELECT job.id, job.delivery_method FROM crawl_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     WHERE query.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM prompt_purge_jobs purge
         WHERE purge.tracked_query_id = query.id
       ) AND (
         (
           job.status = 'queued'
           AND julianday(job.updated_at) < julianday('now', '-5 minutes')
         ) OR (
           job.status = 'submission_unknown'
           AND julianday(job.updated_at) < julianday('now', '-60 minutes')
           AND job.submit_attempts < 2
         )
       )
     ORDER BY job.updated_at
     LIMIT 500`,
  ).all<{ id: string; delivery_method: string }>();
  for (const job of stale.results) {
    await env.CONTROL_DB.prepare(
      "UPDATE crawl_jobs SET status = 'queued', updated_at = ? WHERE id = ?",
    )
      .bind(nowIso(), job.id)
      .run();
    const queue = job.delivery_method === "live" ? env.LIVE_QUEUE : env.STANDARD_QUEUE;
    await queue.send({ jobId: job.id } satisfies JobQueueMessage);
  }

  const staleBrightData = await env.CONTROL_DB.prepare(
    `SELECT job.id, job.delivery_method
     FROM crawl_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     WHERE job.capture_provider = 'brightdata'
       AND job.status = 'awaiting_result'
       AND julianday(job.updated_at) < julianday('now', '-2 minutes')
       AND query.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM prompt_purge_jobs purge
         WHERE purge.tracked_query_id = query.id
       )
     ORDER BY job.updated_at
     LIMIT 500`,
  ).all<{ id: string; delivery_method: string }>();
  for (const job of staleBrightData.results) {
    const updatedAt = nowIso();
    const claimed = await env.CONTROL_DB.prepare(
      `UPDATE crawl_jobs SET updated_at = ?
       WHERE id = ? AND status = 'awaiting_result'
         AND julianday(updated_at) < julianday('now', '-2 minutes')`,
    ).bind(updatedAt, job.id).run();
    if (claimed.meta.changes === 0) continue;
    const queue = job.delivery_method === "live" ? env.LIVE_QUEUE : env.STANDARD_QUEUE;
    await queue.send({ jobId: job.id } satisfies JobQueueMessage);
  }

  const recoverableNormalizationFailures = await env.CONTROL_DB.prepare(
    `SELECT job.id, job.dataforseo_task_id, job.raw_r2_key
     FROM crawl_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     WHERE job.status = 'failed'
       AND job.error_code = 'normalization_failed'
       AND job.dataforseo_task_id IS NOT NULL
       AND job.raw_r2_key IS NOT NULL
       AND query.deleted_at IS NULL
       AND julianday(job.updated_at) < julianday('now', '-10 minutes')
       AND NOT EXISTS (
         SELECT 1 FROM prompt_purge_jobs purge
         WHERE purge.tracked_query_id = query.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM ingest_events event
         WHERE event.crawl_job_id = job.id
           AND event.event_type = 'normalization_recovery'
       )
     ORDER BY job.updated_at
     LIMIT 100`,
  ).all<{
    id: string;
    dataforseo_task_id: string;
    raw_r2_key: string;
  }>();

  if (recoverableNormalizationFailures.results.length) {
    const now = nowIso();
    await env.NORMALIZE_QUEUE.sendBatch(
      recoverableNormalizationFailures.results.map((job) => ({
        body: {
          jobId: job.id,
          taskId: job.dataforseo_task_id,
          rawR2Key: job.raw_r2_key,
          contentEncoding: job.raw_r2_key.endsWith(".gz") ? "gzip" : "identity",
        } satisfies NormalizeQueueMessage,
      })),
    );
    await env.CONTROL_DB.batch(
      recoverableNormalizationFailures.results.flatMap((job) => [
        env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET status = 'normalizing', updated_at = ?
           WHERE id = ? AND status = 'failed' AND error_code = 'normalization_failed'`,
        ).bind(now, job.id),
        env.CONTROL_DB.prepare(
          `INSERT INTO ingest_events (
            id, crawl_job_id, dataforseo_task_id, event_type, status, r2_key, received_at
          ) VALUES (?, ?, ?, 'normalization_recovery', 'queued', ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          job.id,
          job.dataforseo_task_id,
          job.raw_r2_key,
          now,
        ),
      ]),
    );
  }

  return stale.results.length + staleBrightData.results.length +
    recoverableNormalizationFailures.results.length;
}

function flattenCatalogResults(payload: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (
      typeof record.location_code === "number" ||
      typeof record.language_code === "string"
    ) {
      found.push(record);
    }
    Object.values(record).forEach(visit);
  }
  visit(payload);
  return found;
}

export async function refreshLocaleCatalog(env: Env): Promise<number> {
  const credentials = await registeredDataForSeoCredentials(env);
  const [locations, languages] = await Promise.all([
    getLocaleCatalog(credentials, "locations"),
    getLocaleCatalog(credentials, "languages"),
  ]);
  const rows = [
    ...flattenCatalogResults(locations).map((row) => ({
      kind: "location" as const,
      code: String(row.location_code),
      name: String(row.location_name ?? row.location_code),
      payload: row,
    })),
    ...flattenCatalogResults(languages).map((row) => ({
      kind: "language" as const,
      code: String(row.language_code),
      name: String(row.language_name ?? row.language_code),
      payload: row,
    })),
  ];
  for (let start = 0; start < rows.length; start += 100) {
    await env.CONTROL_DB.batch(
      rows.slice(start, start + 100).map((row) =>
        env.CONTROL_DB.prepare(
          `INSERT INTO locale_catalog (kind, code, name, payload_json, refreshed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(kind, code) DO UPDATE SET
             name = excluded.name, payload_json = excluded.payload_json,
             refreshed_at = excluded.refreshed_at`,
        ).bind(row.kind, row.code, row.name, JSON.stringify(row.payload), nowIso()),
      ),
    );
  }
  return rows.length;
}

export async function reconcileMetricOutboxes(env: Env): Promise<number> {
  let queued = 0;
  for (let shardId = 0; shardId < SHARD_COUNT; shardId += 1) {
    const pending = await getShard(env, shardId)
      .prepare(
        `SELECT snapshot_id FROM metric_outbox
         WHERE delivered_at IS NULL ORDER BY created_at LIMIT 100`,
      )
      .all<{ snapshot_id: string }>();
    if (!pending.results.length) continue;
    await env.ROLLUP_QUEUE.sendBatch(
      pending.results.map((row) => ({
        body: { snapshotId: row.snapshot_id, shardId } satisfies RollupQueueMessage,
      })),
    );
    queued += pending.results.length;
  }
  return queued;
}

export async function runRetention(env: Env): Promise<void> {
  const now = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.CONTROL_DB.prepare(
      "DELETE FROM auth_tokens WHERE expires_at < ? OR julianday(consumed_at) < julianday('now', '-7 days')",
    ).bind(now),
    env.CONTROL_DB.prepare(
      `DELETE FROM signup_codes
       WHERE expires_at < ?
          OR julianday(consumed_at) < julianday('now', '-7 days')
          OR julianday(revoked_at) < julianday('now', '-7 days')`,
    ).bind(now),
    env.CONTROL_DB.prepare(
      `DELETE FROM workspaces
       WHERE status = 'pending_payment'
         AND julianday(created_at) < julianday('now', '-7 days')`,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE workspaces SET status = 'deleted', updated_at = ?
       WHERE status = 'read_only' AND read_only_until IS NOT NULL AND read_only_until < ?`,
    ).bind(now, now),
    env.CONTROL_DB.prepare(
      "DELETE FROM ingest_events WHERE julianday(received_at) < julianday('now', '-90 days')",
    ),
    env.CONTROL_DB.prepare(
      "DELETE FROM provider_callback_claims WHERE julianday(updated_at) < julianday('now', '-90 days')",
    ),
    env.CONTROL_DB.prepare(
      "DELETE FROM ai_usage_events WHERE julianday(created_at) < julianday('now', '-90 days')",
    ),
    env.CONTROL_DB.prepare(
      "DELETE FROM ai_inference_cache WHERE julianday(last_used_at) < julianday('now', '-90 days')",
    ),
    env.CONTROL_DB.prepare(
      `UPDATE billing_events SET payload_json = '{}'
       WHERE payload_json != '{}'
         AND julianday(received_at) < julianday('now', '-7 days')`,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE exports SET status = 'expired', updated_at = ?
       WHERE expires_at < ? AND status = 'completed'`,
    ).bind(now, now),
  ]);
  for (let shardId = 0; shardId < SHARD_COUNT; shardId += 1) {
    await getShard(env, shardId)
      .prepare(
        "DELETE FROM snapshots WHERE julianday(captured_at) < julianday('now', '-12 months')",
      )
      .run();
  }
  await env.CONTROL_DB.prepare(
    "DELETE FROM snapshot_index WHERE julianday(captured_at) < julianday('now', '-12 months')",
  ).run();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `DELETE FROM project_entities
       WHERE tracked_brand_id IS NULL AND status = 'candidate'
         AND NOT EXISTS (
           SELECT 1 FROM entity_mentions mention
           WHERE mention.entity_id = project_entities.id
             AND mention.extractor_version = (
               SELECT active_entity_extractor_version FROM projects
               WHERE id = project_entities.project_id
             )
         )`,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE project_entities SET
        snapshot_count = (
          SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id
            AND mention.extractor_version = (
              SELECT active_entity_extractor_version FROM projects
              WHERE id = project_entities.project_id
            )
        ),
        prompt_count = (
          SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id
            AND mention.extractor_version = (
              SELECT active_entity_extractor_version FROM projects
              WHERE id = project_entities.project_id
            )
        ),
        competitor_snapshot_count = (
          SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id AND mention.relationship = 'competitor'
            AND mention.extractor_version = (
              SELECT active_entity_extractor_version FROM projects
              WHERE id = project_entities.project_id
            )
        ),
        competitor_prompt_count = (
          SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id AND mention.relationship = 'competitor'
            AND mention.extractor_version = (
              SELECT active_entity_extractor_version FROM projects
              WHERE id = project_entities.project_id
            )
        ),
        updated_at = ?`,
    ).bind(now),
  ]);
  await env.CONTROL_DB.prepare(
    `DELETE FROM crawl_jobs
     WHERE julianday(created_at) < julianday('now', '-12 months')
       AND status IN ('completed', 'failed', 'cancelled')`,
  ).run();
  await env.CONTROL_DB.prepare(
    `DELETE FROM product_enrichment_jobs
     WHERE julianday(created_at) < julianday('now', '-12 months')
       AND status IN ('completed', 'failed', 'cancelled')`,
  ).run();
  const orphanedAdAssets = await env.CONTROL_DB.prepare(
    `SELECT asset.source_url, asset.asset_key
     FROM ad_assets asset
     WHERE NOT EXISTS (
       SELECT 1 FROM analytics_ad_occurrences occurrence
       WHERE occurrence.image_source_url = asset.source_url
          OR occurrence.favicon_source_url = asset.source_url
     )
     LIMIT 1000`,
  ).all<{ source_url: string; asset_key: string }>();
  if (orphanedAdAssets.results.length) {
    await env.EVIDENCE_BUCKET.delete(
      orphanedAdAssets.results.map((asset) => asset.asset_key),
    );
    await env.CONTROL_DB.batch(
      orphanedAdAssets.results.map((asset) =>
        env.CONTROL_DB.prepare("DELETE FROM ad_assets WHERE source_url = ?")
          .bind(asset.source_url),
      ),
    );
  }
}
