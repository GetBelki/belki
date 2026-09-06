import { Hono } from "hono";
import type {
  AdAssetQueueMessage,
  ExportQueueMessage,
  EntityExtractionQueueMessage,
  JobQueueMessage,
  NormalizeQueueMessage,
  NotificationQueueMessage,
  PromptPurgeQueueMessage,
  ProductEnrichmentQueueMessage,
  RollupQueueMessage,
} from "../shared/contracts";
import { automationRoutes } from "./routes/automation";
import { analyticsRoutes } from "./routes/analytics";
import { trafficRoutes, trafficPublicRoutes, retainTraffic } from "./routes/traffic";
import { adsRoutes } from "./routes/ads";
import { authRoutes } from "./routes/auth";
import { coreRoutes } from "./routes/core";
import { onboardingRoutes } from "./routes/onboarding";
import { operatorInsightRoutes } from "./routes/operator-insights";
import { providerRoutes } from "./routes/providers";
import { paymentProviderRoutes } from "./routes/payment-providers";
import {
  billingRoutes,
  handlePaymentWebhook,
  handleStripeWebhook,
  reconcileBillingPlanChanges,
} from "./routes/billing";
import type { AppEnv } from "./lib/app";
import { authMiddleware } from "./lib/auth";
import {
  errorResponse,
  InvalidContentLengthError,
  nowIso,
  readBoundedBody,
  requestId,
  RequestBodyTooLargeError,
} from "./lib/http";
import { verifySignedJobTag } from "./lib/crypto";
import { verifyDataForSeoWebhookToken } from "./providers/dataforseo";
import { missingDefaultSecurityHeaders } from "./lib/security-headers";
import { RequestTiming } from "./lib/timing";
import { dispatchLiveBatch, dispatchStandardBatch, collectReadyTasks } from "./ingestion/dispatch";
import { normalizeBatch } from "./ingestion/normalize";
import { rollupBatch } from "./ingestion/rollup";
import {
  enqueueDueQueries,
  reconcileJobs,
  reconcileMetricOutboxes,
  refreshLocaleCatalog,
  runRetention,
} from "./ingestion/scheduler";
import { exportBatch } from "./automation/exports";
import { notificationBatch } from "./automation/notifications";
import {
  backfillAnalyticsReadModel,
  backfillFanOutSignalCounts,
  backfillFanOutTelemetryReadModel,
} from "./ingestion/analytics-backfill";
import { backfillProjectEvents } from "./ingestion/project-event-backfill";
import { backfillSourceDiscoveryFirstSeen } from "./ingestion/source-discovery";
import {
  promptPurgeBatch,
  reconcilePromptPurges,
} from "./automation/prompt-purges";
import {
  acceptProductInfoPayload,
  collectReadyProductInfoTasks,
  enqueueDueProductEnrichments,
  productEnrichmentBatch,
  reconcileProductEnrichmentJobs,
  verifyProductEnrichmentTag,
} from "./automation/product-enrichment";
import {
  entityExtractionBatch,
  reconcileEntityExtractionJobs,
} from "./automation/entity-extraction";
import { adAssetBatch, reconcileAdAssets } from "./automation/ad-assets";
import { TrackingSourceSchema } from "../shared/contracts";
import {
  acceptProviderCallbackClaim,
  claimProviderCallback,
  releaseProviderCallbackClaim,
} from "./lib/provider-callbacks";

export { WorkspaceUsageGate } from "./durable-objects/workspace-usage-gate";

const app = new Hono<AppEnv>();
const MAX_PROVIDER_WEBHOOK_BYTES = 20 * 1024 * 1024;
const CALLBACK_JOB_STATES = new Set(["submitting", "submission_unknown", "awaiting_result"]);

function webhookContentEncoding(request: Request): "gzip" | "identity" | null {
  const value = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (!value || value === "identity") return "identity";
  return value === "gzip" ? "gzip" : null;
}

async function boundedWebhookBody(request: Request): Promise<Uint8Array | Response> {
  if (!request.body) return new Response("body required", { status: 400 });
  try {
    return await readBoundedBody(request, MAX_PROVIDER_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response("payload too large", { status: 413 });
    }
    if (error instanceof InvalidContentLengthError) {
      return new Response("invalid content-length", { status: 400 });
    }
    throw error;
  }
}

app.use("*", async (c, next) => {
  c.set("requestId", c.req.header("cf-ray") ?? requestId());
  const timing = new RequestTiming();
  c.set("timing", timing);
  await next();
  for (const [name, value] of missingDefaultSecurityHeaders(c.res.headers)) {
    c.header(name, value);
  }
  c.header("Server-Timing", timing.toServerTiming(), { append: true });
  if (c.req.method === "GET" && c.req.path.startsWith("/api/v1/")) {
    const requestCf = c.req.raw.cf as IncomingRequestCfProperties | undefined;
    console.log(
      JSON.stringify({
        level: "info",
        message: "api_request_timing",
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        route: c.req.routePath,
        status: c.res.status,
        workerColo: requestCf?.colo ?? null,
        placement: c.res.headers.get("cf-placement"),
        timingMs: timing.toLogRecord(),
        d1: timing.toD1LogRecord(),
      }),
    );
  }
});

app.onError((error, c) => errorResponse(c, error));

app.post("/api/webhooks/dataforseo/:source", async (c) => {
  const parsedSource = TrackingSourceSchema.safeParse(c.req.param("source"));
  if (!parsedSource.success) return c.text("not found", 404);
  const trackingSource = parsedSource.data;
  const token = c.req.query("token");
  const taskId = c.req.query("id");
  const tag = c.req.query("tag");
  if (
    !token ||
    !taskId ||
    !tag ||
    !(await verifyDataForSeoWebhookToken(c.env, token))
  ) {
    return c.text("unauthorized", 401);
  }
  const jobId = await verifySignedJobTag(tag, c.env.APP_CRYPTO_KEY);
  if (!jobId) return c.text("unauthorized", 401);
  const job = await c.env.CONTROL_DB.prepare(
    `SELECT job.id, job.workspace_id, job.project_id, job.tracking_source,
      job.capture_provider_attempt_id, job.status, job.dataforseo_task_id,
      attempt.external_task_id
     FROM crawl_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     LEFT JOIN capture_provider_attempts attempt ON attempt.id = job.capture_provider_attempt_id
     WHERE job.id = ? AND job.provider_tag = ? AND job.tracking_source = ?
       AND job.capture_provider = 'dataforseo'
       AND query.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM prompt_purge_jobs purge
         WHERE purge.tracked_query_id = query.id
       )`,
  )
    .bind(jobId, tag, trackingSource)
    .first<{
      id: string;
      workspace_id: string;
      project_id: string;
      tracking_source: string;
      capture_provider_attempt_id: string | null;
      status: string;
      dataforseo_task_id: string | null;
      external_task_id: string | null;
    }>();
  if (!job) return c.text("not found", 404);
  if (
    (job.dataforseo_task_id && job.dataforseo_task_id !== taskId) ||
    (job.external_task_id && job.external_task_id !== taskId)
  ) {
    return c.text("not found", 404);
  }
  if (!CALLBACK_JOB_STATES.has(job.status)) {
    return job.dataforseo_task_id === taskId || job.external_task_id === taskId
      ? c.text("duplicate", 200)
      : c.text("not found", 404);
  }

  const callbackClaim = await claimProviderCallback(c.env.CONTROL_DB, "crawl", jobId, taskId);
  if (callbackClaim === "duplicate") return c.text("duplicate", 200);
  if (callbackClaim === "conflict") return c.text("not found", 404);

  const contentEncoding = webhookContentEncoding(c.req.raw);
  if (!contentEncoding) {
    await releaseProviderCallbackClaim(c.env.CONTROL_DB, "crawl", jobId, taskId);
    return c.text("unsupported content-encoding", 415);
  }
  const body = await boundedWebhookBody(c.req.raw);
  if (body instanceof Response) {
    await releaseProviderCallbackClaim(c.env.CONTROL_DB, "crawl", jobId, taskId);
    return body;
  }
  const rawKey = `raw/${job.workspace_id}/${job.project_id}/${trackingSource}/${new Date().toISOString().slice(0, 7)}/${encodeURIComponent(taskId)}.json${
    contentEncoding === "gzip" ? ".gz" : ""
  }`;
  try {
    await c.env.EVIDENCE_BUCKET.put(rawKey, body, {
      httpMetadata: {
        contentType: "application/json",
        ...(contentEncoding === "gzip" ? { contentEncoding: "gzip" } : {}),
      },
      customMetadata: { jobId, taskId, source: "postback", trackingSource },
    });
    const updatedAt = nowIso();
    const results = await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET
          status = 'normalizing', dataforseo_task_id = COALESCE(dataforseo_task_id, ?),
          raw_r2_key = ?, updated_at = ?
         WHERE id = ? AND status IN ('submitting', 'submission_unknown', 'awaiting_result')
           AND (dataforseo_task_id IS NULL OR dataforseo_task_id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM prompt_purge_jobs purge
             WHERE purge.tracked_query_id = crawl_jobs.tracked_query_id
           )`,
      ).bind(taskId, rawKey, updatedAt, jobId, taskId),
      c.env.CONTROL_DB.prepare(
        `UPDATE capture_provider_attempts SET status = 'normalizing',
          external_task_id = COALESCE(external_task_id, ?), raw_r2_key = ?, updated_at = ?
         WHERE id = ? AND status IN ('submitting', 'accepted', 'awaiting_result', 'ambiguous')
           AND (external_task_id IS NULL OR external_task_id = ?)
           AND EXISTS (
             SELECT 1 FROM crawl_jobs
             WHERE id = ? AND status = 'normalizing' AND raw_r2_key = ?
           )`,
      ).bind(taskId, rawKey, updatedAt, job.capture_provider_attempt_id, taskId, jobId, rawKey),
      c.env.CONTROL_DB.prepare(
        `INSERT INTO ingest_events (
          id, crawl_job_id, dataforseo_task_id, event_type, status, r2_key, received_at
        ) SELECT ?, ?, ?, 'postback', 'accepted', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM crawl_jobs
            WHERE id = ? AND status = 'normalizing' AND raw_r2_key = ?
          )`,
      ).bind(crypto.randomUUID(), jobId, taskId, rawKey, updatedAt, jobId, rawKey),
      acceptProviderCallbackClaim(c.env.CONTROL_DB, "crawl", jobId, taskId, rawKey),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) {
      await Promise.all([
        c.env.EVIDENCE_BUCKET.delete(rawKey),
        releaseProviderCallbackClaim(c.env.CONTROL_DB, "crawl", jobId, taskId),
      ]);
      return c.text("not found", 404);
    }
  } catch (error) {
    await Promise.all([
      c.env.EVIDENCE_BUCKET.delete(rawKey),
      releaseProviderCallbackClaim(c.env.CONTROL_DB, "crawl", jobId, taskId),
    ]);
    throw error;
  }
  try {
    await c.env.NORMALIZE_QUEUE.send({
      jobId,
      taskId,
      rawR2Key: rawKey,
      contentEncoding,
    } satisfies NormalizeQueueMessage);
  } catch (error) {
    const updatedAt = nowIso();
    await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'awaiting_result', raw_r2_key = NULL, updated_at = ?
         WHERE id = ? AND status = 'normalizing' AND raw_r2_key = ?`,
      ).bind(updatedAt, jobId, rawKey),
      c.env.CONTROL_DB.prepare(
        `UPDATE capture_provider_attempts SET status = 'awaiting_result', raw_r2_key = NULL,
          updated_at = ? WHERE id = ? AND status = 'normalizing' AND raw_r2_key = ?`,
      ).bind(updatedAt, job.capture_provider_attempt_id, rawKey),
      c.env.CONTROL_DB.prepare(
        `DELETE FROM ingest_events
         WHERE crawl_job_id = ? AND event_type = 'postback' AND r2_key = ?`,
      ).bind(jobId, rawKey),
    ]);
    await Promise.all([
      c.env.EVIDENCE_BUCKET.delete(rawKey),
      releaseProviderCallbackClaim(c.env.CONTROL_DB, "crawl", jobId, taskId),
    ]);
    throw error;
  }
  return c.text("accepted", 202);
});

app.post("/api/webhooks/dataforseo/product-info", async (c) => {
  const token = c.req.query("token");
  const taskId = c.req.query("id");
  const tag = c.req.query("tag");
  if (
    !token ||
    !taskId ||
    !tag ||
    !(await verifyDataForSeoWebhookToken(c.env, token))
  ) {
    return c.text("unauthorized", 401);
  }
  const jobId = await verifyProductEnrichmentTag(tag, c.env);
  if (!jobId) return c.text("unauthorized", 401);
  const contentEncoding = webhookContentEncoding(c.req.raw);
  if (!contentEncoding) return c.text("unsupported content-encoding", 415);
  const body = await boundedWebhookBody(c.req.raw);
  if (body instanceof Response) return body;
  const accepted = await acceptProductInfoPayload(c.env, {
    jobId,
    taskId,
    body,
    contentEncoding,
  });
  if (accepted === "accepted") return c.text("accepted", 202);
  if (accepted === "duplicate") return c.text("duplicate", 200);
  return c.text("not found", 404);
});

app.post("/api/webhooks/stripe", handleStripeWebhook);
app.post("/api/webhooks/payments/:endpointKey", handlePaymentWebhook);

app.route("/api/traffic", trafficPublicRoutes);
app.use("/api/v1/*", authMiddleware);
app.route("/api/v1/traffic", trafficRoutes);
app.route("/api/v1", authRoutes);
app.route("/api/v1", onboardingRoutes);
app.route("/api/v1", operatorInsightRoutes);
app.route("/api/v1", providerRoutes);
app.route("/api/v1", paymentProviderRoutes);
app.route("/api/v1", billingRoutes);
app.route("/api/v1", coreRoutes);
app.route("/api/v1", analyticsRoutes);
app.route("/api/v1", adsRoutes);
app.route("/api/v1", automationRoutes);

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json(
      {
        error: {
          code: "not_found",
          message: "API route not found.",
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

async function queue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  switch (batch.queue) {
    case "ai-tracker-standard":
      await dispatchStandardBatch(env, batch as MessageBatch<JobQueueMessage>);
      return;
    case "ai-tracker-live":
      await dispatchLiveBatch(env, batch as MessageBatch<JobQueueMessage>);
      return;
    case "ai-tracker-normalize":
      await normalizeBatch(env, batch as MessageBatch<NormalizeQueueMessage>);
      return;
    case "ai-tracker-rollup":
      await rollupBatch(env, batch as MessageBatch<RollupQueueMessage>);
      return;
    case "ai-tracker-export":
      await exportBatch(env, batch as MessageBatch<ExportQueueMessage>);
      return;
    case "ai-tracker-notification":
      await notificationBatch(env, batch as MessageBatch<NotificationQueueMessage>);
      return;
    case "ai-tracker-prompt-purge":
      await promptPurgeBatch(env, batch as MessageBatch<PromptPurgeQueueMessage>);
      return;
    case "ai-tracker-product-enrichment":
      await productEnrichmentBatch(
        env,
        batch as MessageBatch<ProductEnrichmentQueueMessage>,
      );
      return;
    case "ai-tracker-entity-extraction":
      await entityExtractionBatch(
        env,
        batch as MessageBatch<EntityExtractionQueueMessage>,
      );
      return;
    case "ai-tracker-ad-assets":
      await adAssetBatch(env, batch as MessageBatch<AdAssetQueueMessage>);
      return;
    default:
      batch.ackAll();
  }
}

async function scheduled(
  event: ScheduledController,
  env: Env,
): Promise<void> {
  const metrics: Record<string, number> = {};
  if (event.cron === "*/5 * * * *") {
    metrics.enqueued = await enqueueDueQueries(env);
    metrics.reconciledJobs = await reconcileJobs(env);
    metrics.enqueuedProductEnrichments = await enqueueDueProductEnrichments(env);
    metrics.reconciledProductEnrichmentJobs = await reconcileProductEnrichmentJobs(env);
  } else if (event.cron === "* * * * *") {
    metrics.expiredTrafficSessions = (await retainTraffic(env.CONTROL_DB)).meta.changes;
    metrics.reconciledBillingPlanChanges = await reconcileBillingPlanChanges(env);
    metrics.recoveredPostbacks = await collectReadyTasks(env);
    metrics.recoveredProductInfoPostbacks = await collectReadyProductInfoTasks(env);
    metrics.reconciledPromptPurges = await reconcilePromptPurges(env);
    metrics.reconciledEntityExtractions = await reconcileEntityExtractionJobs(env);
    metrics.reconciledAdAssets = await reconcileAdAssets(env);
    const signalBackfill = await backfillFanOutSignalCounts(env);
    metrics.fanOutSignalBackfillSnapshots = signalBackfill.snapshots;
    const telemetryBackfill = await backfillFanOutTelemetryReadModel(env);
    metrics.fanOutTelemetryBackfillSnapshots = telemetryBackfill.snapshots;
    metrics.fanOutTelemetryBackfillShards = telemetryBackfill.shards;
    const sourceDiscovery = await backfillSourceDiscoveryFirstSeen(env);
    metrics.sourceDiscoveryBackfillDays = sourceDiscovery.days;
    metrics.sourceDiscoveryBackfillReady = sourceDiscovery.ready;
    metrics.sourceDiscoveryBackfillFailed = sourceDiscovery.failed;
    const backfill = await backfillAnalyticsReadModel(env);
    metrics.analyticsBackfillProjects = backfill.projects;
    metrics.analyticsBackfillSnapshots = backfill.snapshots;
    metrics.analyticsBackfillReady = backfill.ready;
    metrics.analyticsBackfillFailed = backfill.failed;
    const projectEvents = await backfillProjectEvents(env);
    metrics.projectEventAuditRows = projectEvents.auditRows;
    metrics.projectEventModelProjects = projectEvents.modelProjects;
    metrics.projectEventModelSnapshots = projectEvents.modelSnapshots;
    metrics.projectEventBackfillFailed = projectEvents.failed;
  } else if (event.cron === "0 3 * * *") {
    await runRetention(env);
    metrics.retention = 1;
  } else if (event.cron === "0 4 * * SUN") {
    metrics.locales = await refreshLocaleCatalog(env);
    metrics.outboxes = await reconcileMetricOutboxes(env);
  }
  console.log(
    JSON.stringify({
      level: "info",
      event: "scheduled.complete",
      cron: event.cron,
      metrics,
    }),
  );
}

export default {
  fetch: app.fetch,
  queue,
  scheduled,
} satisfies ExportedHandler<Env>;
