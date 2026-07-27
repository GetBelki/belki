import { Hono } from "hono";
import type {
  ExportQueueMessage,
  JobQueueMessage,
  NormalizeQueueMessage,
  NotificationQueueMessage,
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

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("requestId", c.req.header("cf-ray") ?? requestId());
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "strict-origin-when-cross-origin");
  c.header("x-frame-options", "DENY");
  c.header(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'",
  );
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
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
    "SELECT id FROM crawl_jobs WHERE id = ? AND provider_tag = ?",
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
  await c.env.CONTROL_DB.batch([
    c.env.CONTROL_DB.prepare(
      `UPDATE crawl_jobs SET
        status = 'normalizing', dataforseo_task_id = COALESCE(dataforseo_task_id, ?),
        updated_at = ?
       WHERE id = ?`,
    ).bind(taskId, nowIso(), jobId),
    c.env.CONTROL_DB.prepare(
      `INSERT INTO ingest_events (
        id, crawl_job_id, dataforseo_task_id, event_type, status, r2_key, received_at
      ) VALUES (?, ?, ?, 'postback', 'accepted', ?, ?)`,
    ).bind(crypto.randomUUID(), jobId, taskId, rawKey, nowIso()),
  ]);
  await c.env.NORMALIZE_QUEUE.send({
    jobId,
    taskId,
    rawR2Key: rawKey,
    contentEncoding,
  } satisfies NormalizeQueueMessage);
  return c.text("accepted", 202);
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
  } else if (event.cron === "*/15 * * * *") {
    metrics.recoveredPostbacks = await collectReadyTasks(env);
  } else if (event.cron === "0 3 * * *") {
    await runRetention(env);
    metrics.retention = 1;
  } else if (event.cron === "0 4 * * 0") {
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
