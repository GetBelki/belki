import { Hono } from "hono";
import type {
  ExportQueueMessage,
  JobQueueMessage,
  NormalizeQueueMessage,
  NotificationQueueMessage,
  PromptPurgeQueueMessage,
  ProductEnrichmentQueueMessage,
  RollupQueueMessage,
} from "../shared/contracts";
import { automationRoutes } from "./routes/automation";
import { analyticsRoutes } from "./routes/analytics";
import { authRoutes } from "./routes/auth";
import { coreRoutes } from "./routes/core";
import type { AppEnv } from "./lib/app";
import { authMiddleware } from "./lib/auth";
import { errorResponse, nowIso, requestId } from "./lib/http";
import { timingSafeTextEqual, verifySignedJobTag } from "./lib/crypto";
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
import { backfillAnalyticsReadModel } from "./ingestion/analytics-backfill";
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

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("requestId", c.req.header("cf-ray") ?? requestId());
  const timing = new RequestTiming();
  c.set("timing", timing);
  await next();
  for (const [name, value] of missingDefaultSecurityHeaders(c.res.headers)) {
    c.header(name, value);
  }
  c.header("Server-Timing", timing.toServerTiming(), { append: true });
  if (c.req.path.startsWith("/api/v1/analytics/")) {
    console.log(
      JSON.stringify({
        level: "info",
        message: "analytics_request_timing",
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        timingMs: timing.toLogRecord(),
      }),
    );
  }
});

app.onError((error, c) => errorResponse(c, error));

app.post("/api/webhooks/dataforseo/chatgpt", async (c) => {
  const token = c.req.query("token");
  const taskId = c.req.query("id");
  const tag = c.req.query("tag");
  if (
    !token ||
    !taskId ||
    !tag ||
    !(await timingSafeTextEqual(token, c.env.DATAFORSEO_WEBHOOK_TOKEN))
  ) {
    return c.text("unauthorized", 401);
  }
  const jobId = await verifySignedJobTag(tag, c.env.APP_CRYPTO_KEY);
  if (!jobId) return c.text("unauthorized", 401);
  const job = await c.env.CONTROL_DB.prepare(
    `SELECT job.id
     FROM crawl_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     WHERE job.id = ? AND job.provider_tag = ?
       AND query.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM prompt_purge_jobs purge
         WHERE purge.tracked_query_id = query.id
       )`,
  )
    .bind(jobId, tag)
    .first<{ id: string }>();
  if (!job) return c.text("not found", 404);
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > 20 * 1024 * 1024) return c.text("payload too large", 413);
  if (!c.req.raw.body) return c.text("body required", 400);

  const contentEncoding = c.req.header("content-encoding")?.toLowerCase().includes("gzip")
    ? "gzip"
    : "identity";
  const rawKey = `raw/${new Date().toISOString().slice(0, 7)}/${taskId}.json${
    contentEncoding === "gzip" ? ".gz" : ""
  }`;
  await c.env.EVIDENCE_BUCKET.put(rawKey, c.req.raw.body, {
    httpMetadata: {
      contentType: "application/json",
      ...(contentEncoding === "gzip" ? { contentEncoding: "gzip" } : {}),
    },
    customMetadata: { jobId, taskId, source: "postback" },
  });
  try {
    await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET
          status = 'normalizing', dataforseo_task_id = COALESCE(dataforseo_task_id, ?),
          raw_r2_key = ?, updated_at = ?
         WHERE id = ? AND status != 'cancelled'
           AND NOT EXISTS (
             SELECT 1 FROM prompt_purge_jobs purge
             WHERE purge.tracked_query_id = crawl_jobs.tracked_query_id
           )`,
      ).bind(taskId, rawKey, nowIso(), jobId),
      c.env.CONTROL_DB.prepare(
        `INSERT INTO ingest_events (
          id, crawl_job_id, dataforseo_task_id, event_type, status, r2_key, received_at
        ) VALUES (?, ?, ?, 'postback', 'accepted', ?, ?)`,
      ).bind(crypto.randomUUID(), jobId, taskId, rawKey, nowIso()),
    ]);
  } catch (error) {
    await c.env.EVIDENCE_BUCKET.delete(rawKey);
    throw error;
  }
  await c.env.NORMALIZE_QUEUE.send({
    jobId,
    taskId,
    rawR2Key: rawKey,
    contentEncoding,
  } satisfies NormalizeQueueMessage);
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
    !(await timingSafeTextEqual(token, c.env.DATAFORSEO_WEBHOOK_TOKEN))
  ) {
    return c.text("unauthorized", 401);
  }
  const jobId = await verifyProductEnrichmentTag(tag, c.env);
  if (!jobId) return c.text("unauthorized", 401);
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > 20 * 1024 * 1024) return c.text("payload too large", 413);
  if (!c.req.raw.body) return c.text("body required", 400);
  const contentEncoding = c.req.header("content-encoding")?.toLowerCase().includes("gzip")
    ? "gzip"
    : "identity";
  const accepted = await acceptProductInfoPayload(c.env, {
    jobId,
    taskId,
    body: c.req.raw.body,
    contentEncoding,
  });
  return accepted ? c.text("accepted", 202) : c.text("not found", 404);
});

app.use("/api/v1/*", authMiddleware);
app.route("/api/v1", authRoutes);
app.route("/api/v1", coreRoutes);
app.route("/api/v1", analyticsRoutes);
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
    metrics.recoveredPostbacks = await collectReadyTasks(env);
    metrics.recoveredProductInfoPostbacks = await collectReadyProductInfoTasks(env);
    metrics.reconciledPromptPurges = await reconcilePromptPurges(env);
    const backfill = await backfillAnalyticsReadModel(env);
    metrics.analyticsBackfillProjects = backfill.projects;
    metrics.analyticsBackfillSnapshots = backfill.snapshots;
    metrics.analyticsBackfillReady = backfill.ready;
    metrics.analyticsBackfillFailed = backfill.failed;
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
