import type {
  CaptureProvider,
  CaptureProviderCredentialInput,
  JobQueueMessage,
  NormalizeQueueMessage,
  TrackingSource,
} from "../../shared/contracts";
import { verifySignedJobTag } from "../lib/crypto";
import {
  getTaskResult,
  getTasksReady,
  dataForSeoTask,
  postLiveAdvanced,
  postStandardTasks,
  dataForSeoWebhookToken,
  type StandardTaskInput,
} from "../providers/dataforseo";
import { nowIso } from "../lib/http";
import { workspacePublicAppOrigin } from "../lib/public-origin";
import { emitRunFailureAlerts } from "../automation/alerts";
import type { DataForSeoCredentials } from "../lib/provider-credentials";
import { commitUsage, releaseUsage } from "../lib/usage";
import type { UsageSku } from "../../shared/contracts";
import { availableSources } from "../lib/tracking-sources";
import {
  loadCaptureProviderCredential,
  resolveCaptureProviderAccount,
} from "../providers/accounts";
import { CAPTURE_PROVIDER_ADAPTERS } from "../providers/registry";
import {
  downloadBrightDataSnapshot,
  getBrightDataSnapshotProgress,
} from "../providers/brightdata";
import { CaptureProviderExecutionError } from "../providers/types";

const OXYLABS_AUTOMATIC_RETRIES = 1;

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
  provider_account_id: string | null;
  capture_provider: CaptureProvider;
  capture_provider_attempt_id: string | null;
  capture_adapter_version: string | null;
  submit_attempts: number;
  credential_version: number | null;
  status: string;
  dataforseo_task_id: string | null;
  submitted_at: string | null;
  location_name: string;
  location_payload_json: string | null;
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
      j.tracking_source, j.provider_account_id, j.capture_provider,
      j.capture_provider_attempt_id, j.capture_adapter_version, j.submit_attempts, j.status,
      j.dataforseo_task_id, j.submitted_at,
      attempt.credential_version,
      COALESCE(locale.name, CAST(q.location_code AS TEXT)) AS location_name,
      locale.payload_json AS location_payload_json
    FROM crawl_jobs j
    JOIN tracked_queries q ON q.id = j.tracked_query_id
    JOIN workspaces w ON w.id = j.workspace_id
    LEFT JOIN locale_catalog locale
      ON locale.kind = 'location' AND locale.code = CAST(q.location_code AS TEXT)
    LEFT JOIN capture_provider_attempts attempt
      ON attempt.id = j.capture_provider_attempt_id
    WHERE j.id IN (${placeholders})
      AND (
        j.status IN ('queued', 'submission_unknown')
        OR (j.status = 'awaiting_result' AND j.capture_provider = 'brightdata')
      )
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
  const enabledSources = new Set(await availableSources(env));
  const available: DispatchJobRow[] = [];
  for (const job of jobs) {
    if (enabledSources.has(job.tracking_source)) available.push(job);
    else await cancelUnavailableSourceJob(env, job);
  }
  return available;
}

function dataForSeoCredentials(
  accountId: string,
  credentials: CaptureProviderCredentialInput,
): DataForSeoCredentials {
  if (credentials.provider !== "dataforseo") {
    throw new Error("DataForSEO credentials are required");
  }
  return {
    accountId,
    login: credentials.credentials.login,
    password: credentials.credentials.password,
  };
}

async function jobCredentials(
  env: Env,
  job: DispatchJobRow,
): Promise<{ accountId: string; credentials: CaptureProviderCredentialInput }> {
  if (job.provider_account_id) {
    const credentials = await loadCaptureProviderCredential(
      env,
      job.provider_account_id,
      job.credential_version,
    );
    if (credentials.provider !== job.capture_provider) {
      throw new Error("Stored job provider does not match its provider account");
    }
    return { accountId: job.provider_account_id, credentials };
  }
  const resolved = await resolveCaptureProviderAccount(env, job.tracking_source);
  if (resolved.provider !== job.capture_provider) {
    throw new Error("Legacy job provider is no longer available");
  }
  return { accountId: resolved.accountId, credentials: resolved.credentials };
}

function countryCode(job: DispatchJobRow): string | null {
  if (!job.location_payload_json) return job.location_code === 2840 ? "US" : null;
  try {
    const payload = JSON.parse(job.location_payload_json) as Record<string, unknown>;
    const value = payload.country_iso_code ?? payload.country_code;
    return typeof value === "string" && value.length === 2 ? value.toUpperCase() : null;
  } catch {
    return null;
  }
}

function jobQueue(env: Env, job: DispatchJobRow): Queue {
  return job.delivery_method === "live" ? env.LIVE_QUEUE : env.STANDARD_QUEUE;
}

async function requeueBrightDataPoll(env: Env, job: DispatchJobRow): Promise<void> {
  await jobQueue(env, job).send(
    { jobId: job.id } satisfies JobQueueMessage,
    { delaySeconds: 30 },
  );
}

async function pollBrightDataJob(env: Env, job: DispatchJobRow): Promise<void> {
  const snapshotId = job.dataforseo_task_id;
  if (!snapshotId) throw new Error("Bright Data job is missing its snapshot ID");
  const { credentials } = await jobCredentials(env, job);
  if (credentials.provider !== "brightdata") {
    throw new Error("Bright Data credentials are required");
  }
  try {
    const progress = await getBrightDataSnapshotProgress(
      credentials.credentials.apiToken,
      snapshotId,
    );
    if (progress === "starting" || progress === "running") {
      const submittedAt = Date.parse(job.submitted_at ?? "");
      if (!Number.isNaN(submittedAt) && Date.now() - submittedAt > 30 * 60_000) {
        throw new Error("Bright Data snapshot did not become ready within 30 minutes");
      }
      await env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET task_status_message = ?, updated_at = ?
         WHERE id = ? AND status = 'awaiting_result'`,
      ).bind(progress, nowIso(), job.id).run();
      await requeueBrightDataPoll(env, job);
      return;
    }
    if (progress === "failed") throw new Error("Bright Data snapshot failed");

    const bytes = await downloadBrightDataSnapshot(
      credentials.credentials.apiToken,
      snapshotId,
    );
    const rawKey = `raw/${job.workspace_id}/${job.project_id}/${job.tracking_source}/${new Date().toISOString().slice(0, 7)}/${encodeURIComponent(snapshotId)}.json`;
    await env.EVIDENCE_BUCKET.put(rawKey, bytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        jobId: job.id,
        taskId: snapshotId,
        provider: "brightdata",
        trackingSource: job.tracking_source,
      },
    });
    const updatedAt = nowIso();
    const update = await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'normalizing', task_status_code = 200,
          task_status_message = 'Ready', raw_r2_key = ?, error_code = NULL,
          error_message = NULL, updated_at = ?
         WHERE id = ? AND status = 'awaiting_result'`,
      ).bind(rawKey, updatedAt, job.id),
      env.CONTROL_DB.prepare(
        `UPDATE capture_provider_attempts SET status = 'normalizing', raw_r2_key = ?,
          error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`,
      ).bind(rawKey, updatedAt, job.capture_provider_attempt_id),
    ]);
    if ((update[0]?.meta.changes ?? 0) === 0) {
      return;
    }
    try {
      await env.NORMALIZE_QUEUE.send({
        jobId: job.id,
        taskId: snapshotId,
        rawR2Key: rawKey,
        contentEncoding: "identity",
      } satisfies NormalizeQueueMessage);
    } catch (queueError) {
      const failedAt = nowIso();
      const message = String(queueError).slice(0, 1000);
      await env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'failed', error_code = 'normalization_failed',
          error_message = ?, updated_at = ? WHERE id = ? AND status = 'normalizing'`,
      ).bind(message, failedAt, job.id).run();
      console.error(JSON.stringify({
        level: "error",
        event: "brightdata.normalization_enqueue_failed",
        jobId: job.id,
        snapshotId,
        error: message,
      }));
    }
  } catch (error) {
    const submittedAt = Date.parse(job.submitted_at ?? "");
    const timedOut = !Number.isNaN(submittedAt) && Date.now() - submittedAt > 30 * 60_000;
    if (!timedOut && !String(error).includes("snapshot failed")) {
      await env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET task_status_message = 'Poll retry', updated_at = ?
         WHERE id = ? AND status = 'awaiting_result'`,
      ).bind(nowIso(), job.id).run();
      console.warn(JSON.stringify({
        level: "warn",
        event: "brightdata.snapshot_poll_retry",
        jobId: job.id,
        snapshotId,
        error: String(error),
      }));
      await requeueBrightDataPoll(env, job);
      return;
    }
    const message = String(error).slice(0, 1000);
    const failedAt = nowIso();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'failed', error_code = 'provider_result_failed',
          error_message = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_result'`,
      ).bind(message, failedAt, job.id),
      env.CONTROL_DB.prepare(
        `UPDATE capture_provider_attempts SET status = 'failed',
          error_code = 'provider_result_failed', error_message = ?, completed_at = ?,
          updated_at = ? WHERE id = ? AND status = 'awaiting_result'`,
      ).bind(message, failedAt, failedAt, job.capture_provider_attempt_id),
    ]);
    await emitRunFailureAlerts(env, job.id, message);
  }
}

async function executeSynchronousProviderJob(
  env: Env,
  job: DispatchJobRow,
): Promise<void> {
  let providerAccepted = false;
  try {
    const definition = CAPTURE_PROVIDER_ADAPTERS[job.capture_provider];
    if (!definition.execution) {
      throw new Error(`${definition.label} requires the DataForSEO batch path`);
    }
    const { credentials } = await jobCredentials(env, job);
    const now = nowIso();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'submitting', submit_attempts = submit_attempts + 1,
          error_code = NULL, error_message = NULL, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'submission_unknown', 'submitting')`,
      ).bind(now, job.id),
      env.CONTROL_DB.prepare(
        `UPDATE capture_provider_attempts SET status = 'submitting', submitted_at = COALESCE(submitted_at, ?),
          error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`,
      ).bind(now, now, job.capture_provider_attempt_id),
    ]);
    const result = await definition.execution.execute(credentials, {
      jobId: job.id,
      query: job.query_text,
      source: job.tracking_source,
      locationCode: job.location_code,
      locationName: job.location_name,
      countryCode: countryCode(job),
      languageCode: job.language_code,
      forceWebSearch: job.force_web_search === 1,
    });
    providerAccepted = true;
    const reservation = usageInput(job);
    if (reservation) await commitUsage(env, job.workspace_id, reservation);
    const rawKey = `raw/${job.workspace_id}/${job.project_id}/${job.tracking_source}/${new Date().toISOString().slice(0, 7)}/${encodeURIComponent(result.externalTaskId)}.json`;
    await env.EVIDENCE_BUCKET.put(rawKey, result.bytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        jobId: job.id,
        taskId: result.externalTaskId,
        provider: job.capture_provider,
        trackingSource: job.tracking_source,
      },
    });
    const updatedAt = nowIso();
    if (result.pending) {
      const pendingUpdate = await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET status = 'awaiting_result', dataforseo_task_id = ?,
            request_cost_usd = ?, task_status_code = ?, task_status_message = ?,
            submitted_at = COALESCE(submitted_at, ?), raw_r2_key = ?,
            error_code = NULL, error_message = NULL, updated_at = ?
           WHERE id = ? AND status != 'cancelled'`,
        ).bind(
          result.externalTaskId,
          result.requestCostUsd,
          result.providerStatusCode,
          result.providerStatusMessage,
          updatedAt,
          rawKey,
          updatedAt,
          job.id,
        ),
        env.CONTROL_DB.prepare(
          `UPDATE capture_provider_attempts SET status = 'awaiting_result',
            external_task_id = ?, request_cost_usd = ?, raw_r2_key = ?,
            error_code = NULL, error_message = NULL, updated_at = ?
           WHERE id = ?`,
        ).bind(
          result.externalTaskId,
          result.requestCostUsd,
          rawKey,
          updatedAt,
          job.capture_provider_attempt_id,
        ),
      ]);
      if ((pendingUpdate[0]?.meta.changes ?? 0) === 0) {
        await env.EVIDENCE_BUCKET.delete(rawKey);
        return;
      }
      try {
        await requeueBrightDataPoll(env, {
          ...job,
          dataforseo_task_id: result.externalTaskId,
        });
      } catch (queueError) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "brightdata.initial_poll_enqueue_failed",
          jobId: job.id,
          snapshotId: result.externalTaskId,
          error: String(queueError),
        }));
      }
      return;
    }
    const update = await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'normalizing', dataforseo_task_id = ?,
          request_cost_usd = ?, task_status_code = ?, task_status_message = ?,
          submitted_at = COALESCE(submitted_at, ?), raw_r2_key = ?,
          error_code = NULL, error_message = NULL, updated_at = ?
         WHERE id = ? AND status != 'cancelled'`,
      ).bind(
        result.externalTaskId,
        result.requestCostUsd,
        result.providerStatusCode,
        result.providerStatusMessage,
        updatedAt,
        rawKey,
        updatedAt,
        job.id,
      ),
      env.CONTROL_DB.prepare(
        `UPDATE capture_provider_attempts SET status = 'normalizing', external_task_id = ?,
          request_cost_usd = ?, raw_r2_key = ?, error_code = NULL,
          error_message = NULL, updated_at = ? WHERE id = ?`,
      ).bind(
        result.externalTaskId,
        result.requestCostUsd,
        rawKey,
        updatedAt,
        job.capture_provider_attempt_id,
      ),
    ]);
    if ((update[0]?.meta.changes ?? 0) === 0) {
      await env.EVIDENCE_BUCKET.delete(rawKey);
      return;
    }
    await env.NORMALIZE_QUEUE.send({
      jobId: job.id,
      taskId: result.externalTaskId,
      rawR2Key: rawKey,
      contentEncoding: "identity",
    } satisfies NormalizeQueueMessage);
  } catch (error) {
    const providerError = error instanceof CaptureProviderExecutionError ? error : null;
    const message = String(error).slice(0, 1000);
    const failedAt = nowIso();
    if (
      job.capture_provider === "oxylabs" &&
      providerError?.retryable &&
      job.submit_attempts < OXYLABS_AUTOMATIC_RETRIES
    ) {
      await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET status = 'queued', dataforseo_task_id = COALESCE(?, dataforseo_task_id),
            task_status_code = ?, task_status_message = ?, error_code = 'provider_retry',
            error_message = ?, updated_at = ? WHERE id = ? AND status != 'cancelled'`,
        ).bind(
          providerError.externalTaskId,
          providerError.statusCode,
          `${providerError.statusMessage ?? "Oxylabs faulted"}; automatic retry scheduled`,
          message,
          failedAt,
          job.id,
        ),
        env.CONTROL_DB.prepare(
          `UPDATE capture_provider_attempts SET status = 'queued', external_task_id = COALESCE(?, external_task_id),
            error_code = 'provider_retry', error_message = ?, updated_at = ? WHERE id = ?`,
        ).bind(
          providerError.externalTaskId,
          message,
          failedAt,
          job.capture_provider_attempt_id,
        ),
      ]);
      try {
        await jobQueue(env, job).send(
          { jobId: job.id } satisfies JobQueueMessage,
          { delaySeconds: 30 },
        );
      } catch (queueError) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "oxylabs.automatic_retry_enqueue_failed",
          jobId: job.id,
          error: String(queueError),
        }));
      }
      return;
    }
    const errorCode = providerError ? "provider_faulted" : "provider_execution_failed";
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'failed', dataforseo_task_id = COALESCE(?, dataforseo_task_id),
          task_status_code = ?, task_status_message = ?, error_code = ?,
          error_message = ?, updated_at = ? WHERE id = ? AND status != 'cancelled'`,
      ).bind(
        providerError?.externalTaskId ?? null,
        providerError?.statusCode ?? null,
        providerError?.statusMessage ?? null,
        errorCode,
        message,
        failedAt,
        job.id,
      ),
      env.CONTROL_DB.prepare(
        `UPDATE capture_provider_attempts SET status = 'failed',
          external_task_id = COALESCE(?, external_task_id), error_code = ?,
          error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        providerError?.externalTaskId ?? null,
        errorCode,
        message,
        failedAt,
        failedAt,
        job.capture_provider_attempt_id,
      ),
    ]);
    await emitRunFailureAlerts(env, job.id, message);
    const reservation = usageInput(job);
    if (reservation && !providerAccepted) {
      try {
        await releaseUsage(env, job.workspace_id, reservation);
      } catch (releaseError) {
        if (!String(releaseError).includes("reservation_already_finalized")) throw releaseError;
      }
    }
  }
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

  const grouped = new Map<string, DispatchJobRow[]>();
  for (const job of jobs) {
    const key = `${job.capture_provider}|${job.provider_account_id ?? "legacy"}|${job.tracking_source}`;
    const sourceJobs = grouped.get(key) ?? [];
    sourceJobs.push(job);
    grouped.set(key, sourceJobs);
  }
  for (const sourceJobs of grouped.values()) {
    const firstJob = sourceJobs[0];
    if (!firstJob) continue;
    if (firstJob.capture_provider !== "dataforseo") {
      for (const job of sourceJobs) {
        if (job.capture_provider === "brightdata" && job.status === "awaiting_result") {
          await pollBrightDataJob(env, job);
        } else {
          await executeSynchronousProviderJob(env, job);
        }
      }
      continue;
    }
    const source = firstJob.tracking_source;
    const webhookToken = await dataForSeoWebhookToken(env);
    const submittingAt = nowIso();
    await env.CONTROL_DB.batch(sourceJobs.flatMap((job) => [
      env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'submitting', submit_attempts = submit_attempts + 1,
          updated_at = ? WHERE id = ? AND status IN ('queued', 'submission_unknown')`,
      ).bind(submittingAt, job.id),
      env.CONTROL_DB.prepare(
        `UPDATE capture_provider_attempts SET status = 'submitting',
          submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ?`,
      ).bind(submittingAt, submittingAt, job.capture_provider_attempt_id),
    ]));
    const tasks: StandardTaskInput[] = sourceJobs.map((job) => dataForSeoTask(source, {
      keyword: job.query_text,
      location_code: job.location_code,
      language_code: job.language_code,
      force_web_search: job.force_web_search === 1,
      priority: job.delivery_method === "standard_priority" ? 2 : 1,
      expand_citations: job.capture_html === 1,
      tag: job.provider_tag,
      postback_url: `${workspacePublicAppOrigin(env, job.public_base_url)}/api/webhooks/dataforseo/${source}?token=${encodeURIComponent(webhookToken)}&id=$id&tag=$tag`,
      postback_data: "advanced",
    }));
    try {
      const resolved = await jobCredentials(env, firstJob);
      const response = await postStandardTasks(
        dataForSeoCredentials(resolved.accountId, resolved.credentials),
        source,
        tasks,
      );
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
        const taskMessage = task.status_message ?? "DataForSEO rejected the task.";
        if (!accepted) failures.push({ jobId: job.id, message: taskMessage });
        const reservation = usageInput(job);
        if (reservation) {
          if (accepted) await commitUsage(env, job.workspace_id, reservation);
          else await releaseUsage(env, job.workspace_id, reservation);
        }
        const updatedAt = nowIso();
        updates.push(
          env.CONTROL_DB.prepare(
            `UPDATE crawl_jobs SET status = ?,
              dataforseo_task_id = COALESCE(?, dataforseo_task_id), request_cost_usd = ?,
              task_status_code = ?, task_status_message = ?,
              submitted_at = CASE WHEN ? THEN ? ELSE submitted_at END,
              error_code = CASE WHEN ? THEN NULL ELSE 'provider_rejected' END,
              error_message = CASE WHEN ? THEN NULL ELSE ? END, updated_at = ?
             WHERE id = ? AND status != 'cancelled'`,
          ).bind(
            accepted ? "awaiting_result" : "failed",
            task.id ?? null,
            task.cost ?? null,
            task.status_code ?? null,
            task.status_message ?? null,
            accepted ? 1 : 0,
            updatedAt,
            accepted ? 1 : 0,
            accepted ? 1 : 0,
            taskMessage,
            updatedAt,
            job.id,
          ),
          env.CONTROL_DB.prepare(
            `UPDATE capture_provider_attempts SET status = ?, external_task_id = ?,
              request_cost_usd = ?, error_code = ?, error_message = ?,
              completed_at = CASE WHEN ? THEN NULL ELSE ? END, updated_at = ? WHERE id = ?`,
          ).bind(
            accepted ? "awaiting_result" : "failed",
            task.id ?? null,
            task.cost ?? null,
            accepted ? null : "provider_rejected",
            accepted ? null : taskMessage,
            accepted ? 1 : 0,
            updatedAt,
            updatedAt,
            job.capture_provider_attempt_id,
          ),
        );
      }
      for (const job of sourceJobs) {
        if (completedJobIds.has(job.id)) continue;
        const updatedAt = nowIso();
        updates.push(
          env.CONTROL_DB.prepare(
            `UPDATE crawl_jobs SET status = 'submission_unknown',
              error_code = 'missing_provider_task',
              error_message = 'Provider response did not include this task.', updated_at = ?
             WHERE id = ? AND status != 'cancelled'`,
          ).bind(updatedAt, job.id),
          env.CONTROL_DB.prepare(
            `UPDATE capture_provider_attempts SET status = 'ambiguous',
              error_code = 'missing_provider_task',
              error_message = 'Provider response did not include this task.', updated_at = ?
             WHERE id = ?`,
          ).bind(updatedAt, job.capture_provider_attempt_id),
        );
      }
      if (updates.length) await env.CONTROL_DB.batch(updates);
      await Promise.all(failures.map((failure) =>
        emitRunFailureAlerts(env, failure.jobId, failure.message)
      ));
    } catch (error) {
      const errorMessage = String(error).slice(0, 1000);
      const updatedAt = nowIso();
      await env.CONTROL_DB.batch(sourceJobs.flatMap((job) => [
        env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET status = 'submission_unknown',
            error_code = 'submission_ambiguous', error_message = ?, updated_at = ?
           WHERE id = ? AND status != 'cancelled'`,
        ).bind(errorMessage, updatedAt, job.id),
        env.CONTROL_DB.prepare(
          `UPDATE capture_provider_attempts SET status = 'ambiguous',
            error_code = 'submission_ambiguous', error_message = ?, updated_at = ? WHERE id = ?`,
        ).bind(errorMessage, updatedAt, job.capture_provider_attempt_id),
      ]));
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
      if (job.capture_provider !== "dataforseo") {
        if (job.capture_provider === "brightdata" && job.status === "awaiting_result") {
          await pollBrightDataJob(env, job);
        } else {
          await executeSynchronousProviderJob(env, job);
        }
        message.ack();
        return;
      }
      let providerAccepted = false;
      try {
        const submittedAt = nowIso();
        await env.CONTROL_DB.batch([
          env.CONTROL_DB.prepare(
            `UPDATE crawl_jobs SET status = 'submitting',
              submit_attempts = submit_attempts + 1, updated_at = ?
             WHERE id = ? AND status IN ('queued', 'submission_unknown')`,
          ).bind(submittedAt, job.id),
          env.CONTROL_DB.prepare(
            `UPDATE capture_provider_attempts SET status = 'submitting',
              submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ?`,
          ).bind(submittedAt, submittedAt, job.capture_provider_attempt_id),
        ]);
        const resolved = await jobCredentials(env, job);
        const response = await postLiveAdvanced(dataForSeoCredentials(
          resolved.accountId,
          resolved.credentials,
        ), job.tracking_source, {
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
        const updatedAt = nowIso();
        const update = await env.CONTROL_DB.batch([
          env.CONTROL_DB.prepare(
            `UPDATE crawl_jobs SET status = 'normalizing', dataforseo_task_id = ?,
              request_cost_usd = ?, task_status_code = ?, task_status_message = ?,
              submitted_at = ?, raw_r2_key = ?, updated_at = ?
             WHERE id = ? AND status != 'cancelled'`,
          ).bind(
            providerTask.id,
            providerTask.cost ?? null,
            providerTask.status_code ?? null,
            providerTask.status_message ?? null,
            updatedAt,
            rawKey,
            updatedAt,
            job.id,
          ),
          env.CONTROL_DB.prepare(
            `UPDATE capture_provider_attempts SET status = 'normalizing',
              external_task_id = ?, request_cost_usd = ?, raw_r2_key = ?, updated_at = ?
             WHERE id = ?`,
          ).bind(
            providerTask.id,
            providerTask.cost ?? null,
            rawKey,
            updatedAt,
            job.capture_provider_attempt_id,
          ),
        ]);
        if ((update[0]?.meta.changes ?? 0) === 0) {
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
        const failedAt = nowIso();
        await env.CONTROL_DB.batch([
          env.CONTROL_DB.prepare(
            `UPDATE crawl_jobs SET status = 'failed', error_code = 'live_failed',
              error_message = ?, updated_at = ? WHERE id = ? AND status != 'cancelled'`,
          ).bind(messageText, failedAt, job.id),
          env.CONTROL_DB.prepare(
            `UPDATE capture_provider_attempts SET status = 'failed',
              error_code = 'live_failed', error_message = ?, completed_at = ?, updated_at = ?
             WHERE id = ?`,
          ).bind(messageText, failedAt, failedAt, job.capture_provider_attempt_id),
        ]);
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
  let recovered = 0;
  const inFlight = await env.CONTROL_DB.prepare(
    `SELECT DISTINCT job.provider_account_id, job.tracking_source, attempt.credential_version
     FROM crawl_jobs job
     LEFT JOIN capture_provider_attempts attempt
       ON attempt.id = job.capture_provider_attempt_id
     WHERE job.capture_provider = 'dataforseo'
       AND job.provider_account_id IS NOT NULL
       AND job.status IN ('submitted', 'awaiting_result', 'submission_unknown')`,
  ).all<{
    provider_account_id: string;
    tracking_source: TrackingSource;
    credential_version: number | null;
  }>();
  for (const route of inFlight.results) {
    const source = route.tracking_source;
    const credentialInput = await loadCaptureProviderCredential(
      env,
      route.provider_account_id,
      route.credential_version,
    );
    const credentials = dataForSeoCredentials(route.provider_account_id, credentialInput);
    const ready = await getTasksReady(credentials, source);
    for (const task of ready) {
    if (!task.tag || !task.endpointAdvanced) continue;
    const jobId = await verifySignedJobTag(task.tag, env.APP_CRYPTO_KEY);
    if (!jobId) continue;
    const job = await env.CONTROL_DB.prepare(
      `SELECT job.id, job.workspace_id, job.project_id, job.capture_provider_attempt_id
       FROM crawl_jobs job
       JOIN tracked_queries query ON query.id = job.tracked_query_id
       LEFT JOIN capture_provider_attempts attempt
         ON attempt.id = job.capture_provider_attempt_id
       WHERE job.id = ? AND job.provider_tag = ? AND job.tracking_source = ?
         AND job.provider_account_id = ? AND job.capture_provider = 'dataforseo'
         AND attempt.credential_version IS ?
         AND job.status != 'cancelled' AND query.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM prompt_purge_jobs purge
           WHERE purge.tracked_query_id = query.id
         )`,
    )
      .bind(jobId, task.tag, source, route.provider_account_id, route.credential_version)
      .first<{
        id: string;
        workspace_id: string;
        project_id: string;
        capture_provider_attempt_id: string | null;
      }>();
    if (!job) continue;
    const bytes = await getTaskResult(credentials, source, task.endpointAdvanced);
    const rawKey = `raw/${job.workspace_id}/${job.project_id}/${source}/${new Date().toISOString().slice(0, 7)}/${task.id}.json`;
    await env.EVIDENCE_BUCKET.put(rawKey, bytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { jobId, taskId: task.id, recovery: "tasks_ready", trackingSource: source },
    });
    const updatedAt = nowIso();
    const update = await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'normalizing', dataforseo_task_id = ?,
          raw_r2_key = ?, updated_at = ?
         WHERE id = ? AND status != 'cancelled'
           AND NOT EXISTS (
             SELECT 1 FROM prompt_purge_jobs purge
             WHERE purge.tracked_query_id = crawl_jobs.tracked_query_id
           )`,
      ).bind(task.id, rawKey, updatedAt, jobId),
      env.CONTROL_DB.prepare(
        `UPDATE capture_provider_attempts SET status = 'normalizing',
          external_task_id = ?, raw_r2_key = ?, updated_at = ? WHERE id = ?`,
      ).bind(task.id, rawKey, updatedAt, job.capture_provider_attempt_id),
    ]);
    if ((update[0]?.meta.changes ?? 0) === 0) {
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
