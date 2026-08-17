import type { JobQueueMessage, NormalizeQueueMessage, TrackingSource } from "../../shared/contracts";
import { TRACKING_SOURCES } from "../../shared/tracking-sources";
import { verifySignedJobTag } from "../lib/crypto";
import {
  getTaskResult,
  getTasksReady,
  dataForSeoTask,
  postLiveAdvanced,
  postStandardTasks,
  type StandardTaskInput,
} from "../lib/dataforseo";
import { nowIso } from "../lib/http";
import { emitRunFailureAlerts } from "../automation/alerts";
import { platformDataForSeoCredentials } from "../lib/provider-credentials";
import { commitUsage, releaseUsage } from "../lib/usage";
import type { UsageSku } from "../../shared/contracts";
import { sourceAvailable } from "../lib/tracking-sources";

interface DispatchJobRow {
  id: string;
  query_text: string;
  location_code: number;
  language_code: string;
  force_web_search: number;
  provider_tag: string;
  capture_html: number;
  delivery_method: "standard" | "standard_priority" | "live";
  public_base_url: string;
  workspace_id: string;
  project_id: string;
  usage_reservation_id: string | null;
  usage_units: number;
  tracking_source: TrackingSource;
}

function usageInput(job: DispatchJobRow): {
  reservationId: string;
  sku: UsageSku;
  units: number;
  resourceType: string;
  resourceId: string;
} | null {
  if (!job.usage_reservation_id || job.usage_units <= 0) return null;
  const sku: UsageSku = job.delivery_method === "live"
    ? "llm_live"
    : job.delivery_method === "standard_priority"
      ? "llm_priority_html"
      : "llm_standard";
  return {
    reservationId: job.usage_reservation_id,
    sku,
    units: job.usage_units,
    resourceType: "crawl_job",
    resourceId: job.id,
  };
}

async function loadJobs(env: Env, ids: string[]): Promise<DispatchJobRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await env.CONTROL_DB.prepare(
    `SELECT
      j.id, q.query_text, q.location_code, q.language_code, q.force_web_search,
      j.provider_tag, j.capture_html, j.delivery_method, w.public_base_url,
      j.workspace_id, j.project_id, j.usage_reservation_id, j.usage_units,
      j.tracking_source
    FROM crawl_jobs j
    JOIN tracked_queries q ON q.id = j.tracked_query_id
    JOIN workspaces w ON w.id = j.workspace_id
    WHERE j.id IN (${placeholders})
      AND j.status IN ('queued', 'submission_unknown')
      AND q.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM prompt_purge_jobs purge
        WHERE purge.tracked_query_id = q.id
      )`,
  )
    .bind(...ids)
    .all<DispatchJobRow>();
  return result.results;
}

async function cancelUnavailableSourceJob(env: Env, job: DispatchJobRow): Promise<void> {
  const cancelled = await env.CONTROL_DB.prepare(
    `UPDATE crawl_jobs SET status = 'cancelled', error_code = 'source_disabled',
      error_message = 'This tracking source is disabled for the deployment.', updated_at = ?
     WHERE id = ? AND status IN ('queued', 'submission_unknown')`,
  ).bind(nowIso(), job.id).run();
  if (cancelled.meta.changes === 0) return;
  const reservation = usageInput(job);
  if (reservation) await releaseUsage(env, job.workspace_id, reservation);
}

async function dispatchableJobs(env: Env, jobs: DispatchJobRow[]): Promise<DispatchJobRow[]> {
  const available: DispatchJobRow[] = [];
  for (const job of jobs) {
    if (sourceAvailable(env, job.tracking_source)) available.push(job);
    else await cancelUnavailableSourceJob(env, job);
  }
  return available;
}

export async function dispatchStandardBatch(
  env: Env,
  batch: MessageBatch<JobQueueMessage>,
): Promise<void> {
  const jobs = await dispatchableJobs(
    env,
    await loadJobs(env, batch.messages.map((message) => message.body.jobId)),
  );
  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const message of batch.messages) {
    if (!byId.has(message.body.jobId)) message.ack();
  }
  if (jobs.length === 0) return;

  const now = nowIso();
  await env.CONTROL_DB.batch(
    jobs.map((job) =>
      env.CONTROL_DB.prepare(
         `UPDATE crawl_jobs
         SET status = 'submitting', submit_attempts = submit_attempts + 1, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'submission_unknown')`,
      ).bind(now, job.id),
    ),
  );

  const grouped = new Map<TrackingSource, DispatchJobRow[]>();
  for (const job of jobs) {
    const sourceJobs = grouped.get(job.tracking_source) ?? [];
    sourceJobs.push(job);
    grouped.set(job.tracking_source, sourceJobs);
  }
  for (const [source, sourceJobs] of grouped) {
    const tasks: StandardTaskInput[] = sourceJobs.map((job) => dataForSeoTask(source, {
      keyword: job.query_text,
      location_code: job.location_code,
      language_code: job.language_code,
      force_web_search: job.force_web_search === 1,
      priority: job.delivery_method === "standard_priority" ? 2 : 1,
      expand_citations: job.capture_html === 1,
      tag: job.provider_tag,
      postback_url: `${job.public_base_url}/api/webhooks/dataforseo/${source}?token=${encodeURIComponent(env.DATAFORSEO_WEBHOOK_TOKEN)}&id=$id&tag=$tag`,
      postback_data: "advanced",
    }));
    try {
      const response = await postStandardTasks(platformDataForSeoCredentials(env), source, tasks);
    const updates: D1PreparedStatement[] = [];
    const failures: Array<{ jobId: string; message: string }> = [];
    const completedJobIds = new Set<string>();
    for (const task of response.tasks) {
      const tag = typeof task.data?.tag === "string" ? task.data.tag : null;
      if (!tag) continue;
      const job = sourceJobs.find((candidate) => candidate.provider_tag === tag);
      if (!job) continue;
      completedJobIds.add(job.id);
      const accepted = task.status_code === 20100 || task.status_code === 20000;
      if (!accepted) {
        failures.push({
          jobId: job.id,
          message: task.status_message ?? "DataForSEO rejected the task.",
        });
      }
      const reservation = usageInput(job);
      if (reservation) {
        if (accepted) await commitUsage(env, job.workspace_id, reservation);
        else await releaseUsage(env, job.workspace_id, reservation);
      }
      updates.push(
        env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET
            status = ?, dataforseo_task_id = COALESCE(?, dataforseo_task_id),
            request_cost_usd = ?, task_status_code = ?, task_status_message = ?,
            submitted_at = CASE WHEN ? THEN ? ELSE submitted_at END,
            error_code = CASE WHEN ? THEN NULL ELSE 'provider_rejected' END,
            error_message = CASE WHEN ? THEN NULL ELSE ? END,
            updated_at = ?
          WHERE id = ? AND status != 'cancelled'`,
        ).bind(
          accepted ? "awaiting_result" : "failed",
          task.id ?? null,
          task.cost ?? null,
          task.status_code ?? null,
          task.status_message ?? null,
          accepted ? 1 : 0,
          nowIso(),
          accepted ? 1 : 0,
          accepted ? 1 : 0,
          task.status_message ?? "DataForSEO rejected the task.",
          nowIso(),
          job.id,
        ),
      );
    }
    for (const job of sourceJobs) {
      if (completedJobIds.has(job.id)) continue;
      updates.push(
        env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET
            status = 'submission_unknown', error_code = 'missing_provider_task',
            error_message = 'Provider response did not include this task.', updated_at = ?
           WHERE id = ? AND status != 'cancelled'`,
        ).bind(nowIso(), job.id),
      );
    }
    if (updates.length) await env.CONTROL_DB.batch(updates);
    await Promise.all(
      failures.map((failure) =>
        emitRunFailureAlerts(env, failure.jobId, failure.message),
      ),
    );
    } catch (error) {
      await env.CONTROL_DB.batch(
      sourceJobs.map((job) =>
        env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET
            status = 'submission_unknown', error_code = 'submission_ambiguous',
            error_message = ?, updated_at = ?
           WHERE id = ? AND status != 'cancelled'`,
        ).bind(String(error).slice(0, 1000), nowIso(), job.id),
      ),
      );
    }
  }

  for (const message of batch.messages) {
    if (byId.has(message.body.jobId)) message.ack();
  }
}

export async function dispatchLiveBatch(
  env: Env,
  batch: MessageBatch<JobQueueMessage>,
): Promise<void> {
  const jobs = await dispatchableJobs(
    env,
    await loadJobs(env, batch.messages.map((message) => message.body.jobId)),
  );
  const byId = new Map(jobs.map((job) => [job.id, job]));
  await Promise.all(
    batch.messages.map(async (message) => {
      const job = byId.get(message.body.jobId);
      if (!job) {
        message.ack();
        return;
      }
      let providerAccepted = false;
      try {
        await env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs
           SET status = 'submitting', submit_attempts = submit_attempts + 1, updated_at = ?
           WHERE id = ? AND status IN ('queued', 'submission_unknown')`,
        )
          .bind(nowIso(), job.id)
          .run();
        const response = await postLiveAdvanced(platformDataForSeoCredentials(env), job.tracking_source, {
          keyword: job.query_text,
          location_code: job.location_code,
          language_code: job.language_code,
          force_web_search: job.force_web_search === 1,
          tag: job.provider_tag,
        });
        const providerTask = response.payload.tasks[0];
        if (!providerTask?.id || (providerTask.status_code ?? 0) >= 40000) {
          throw new Error(providerTask?.status_message ?? "DataForSEO Live returned no task.");
        }
        providerAccepted = true;
        const reservation = usageInput(job);
        if (reservation) await commitUsage(env, job.workspace_id, reservation);
        const rawKey = `raw/${job.workspace_id}/${job.project_id}/${job.tracking_source}/${new Date().toISOString().slice(0, 7)}/${providerTask.id}.json`;
        await env.EVIDENCE_BUCKET.put(rawKey, response.bytes, {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { jobId: job.id, taskId: providerTask.id, trackingSource: job.tracking_source },
        });
        const update = await env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET
            status = 'normalizing', dataforseo_task_id = ?, request_cost_usd = ?,
            task_status_code = ?, task_status_message = ?, submitted_at = ?,
            raw_r2_key = ?, updated_at = ?
           WHERE id = ? AND status != 'cancelled'`,
        )
          .bind(
            providerTask.id,
            providerTask.cost ?? null,
            providerTask.status_code ?? null,
            providerTask.status_message ?? null,
            nowIso(),
            rawKey,
            nowIso(),
            job.id,
          )
          .run();
        if (update.meta.changes === 0) {
          await env.EVIDENCE_BUCKET.delete(rawKey);
          message.ack();
          return;
        }
        const normalizeMessage: NormalizeQueueMessage = {
          jobId: job.id,
          taskId: providerTask.id,
          rawR2Key: rawKey,
          contentEncoding: "identity",
        };
        await env.NORMALIZE_QUEUE.send(normalizeMessage);
        message.ack();
      } catch (error) {
        const messageText = String(error).slice(0, 1000);
        await env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET
            status = 'failed', error_code = 'live_failed', error_message = ?, updated_at = ?
           WHERE id = ? AND status != 'cancelled'`,
        )
          .bind(messageText, nowIso(), job.id)
          .run();
        await emitRunFailureAlerts(env, job.id, messageText);
        const reservation = usageInput(job);
        if (reservation && !providerAccepted) {
          try {
            await releaseUsage(env, job.workspace_id, reservation);
          } catch (releaseError) {
            if (!String(releaseError).includes("reservation_already_finalized")) {
              console.error(JSON.stringify({
                level: "error",
                message: "usage_release_failed",
                jobId: job.id,
                error: String(releaseError),
              }));
            }
          }
        }
        message.ack();
      }
    }),
  );
}

export async function collectReadyTasks(env: Env): Promise<number> {
  const credentials = platformDataForSeoCredentials(env);
  let recovered = 0;
  for (const source of TRACKING_SOURCES) {
    if (!sourceAvailable(env, source)) {
      const inFlight = await env.CONTROL_DB.prepare(
        `SELECT 1 FROM crawl_jobs
         WHERE tracking_source = ? AND status IN ('submitted', 'awaiting_result', 'submission_unknown')
         LIMIT 1`,
      ).bind(source).first();
      if (!inFlight) continue;
    }
    const ready = await getTasksReady(credentials, source);
    for (const task of ready) {
    if (!task.tag || !task.endpointAdvanced) continue;
    const jobId = await verifySignedJobTag(task.tag, env.APP_CRYPTO_KEY);
    if (!jobId) continue;
    const job = await env.CONTROL_DB.prepare(
      `SELECT job.id, job.workspace_id, job.project_id
       FROM crawl_jobs job
       JOIN tracked_queries query ON query.id = job.tracked_query_id
       WHERE job.id = ? AND job.provider_tag = ? AND job.tracking_source = ?
         AND job.status != 'cancelled' AND query.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM prompt_purge_jobs purge
           WHERE purge.tracked_query_id = query.id
         )`,
    )
      .bind(jobId, task.tag, source)
      .first<{ id: string; workspace_id: string; project_id: string }>();
    if (!job) continue;
    const bytes = await getTaskResult(credentials, source, task.endpointAdvanced);
    const rawKey = `raw/${job.workspace_id}/${job.project_id}/${source}/${new Date().toISOString().slice(0, 7)}/${task.id}.json`;
    await env.EVIDENCE_BUCKET.put(rawKey, bytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { jobId, taskId: task.id, recovery: "tasks_ready", trackingSource: source },
    });
    const update = await env.CONTROL_DB.prepare(
      `UPDATE crawl_jobs SET
        status = 'normalizing', dataforseo_task_id = ?, raw_r2_key = ?, updated_at = ?
       WHERE id = ? AND status != 'cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM prompt_purge_jobs purge
           WHERE purge.tracked_query_id = crawl_jobs.tracked_query_id
         )`,
    )
      .bind(task.id, rawKey, nowIso(), jobId)
      .run();
    if (update.meta.changes === 0) {
      await env.EVIDENCE_BUCKET.delete(rawKey);
      continue;
    }
    await env.NORMALIZE_QUEUE.send({
      jobId,
      taskId: task.id,
      rawR2Key: rawKey,
      contentEncoding: "identity",
    } satisfies NormalizeQueueMessage);
    recovered += 1;
    }
  }
  return recovered;
}
