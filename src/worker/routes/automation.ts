import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  AlertRuleInputSchema,
  ExportInputSchema,
  WebhookDestinationInputSchema,
} from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import { requireRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { hmac } from "../lib/crypto";
import { ApiError, nowIso } from "../lib/http";

const IdParamSchema = z.object({ id: z.string().uuid() });

async function assertProject(
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL")
    .bind(projectId, workspaceId)
    .first();
  if (!row) throw new ApiError(404, "project_not_found", "Project not found.");
}

function assertSafeWebhookUrl(raw: string): void {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./u.test(host) ||
    /^10\./u.test(host) ||
    /^192\.168\./u.test(host) ||
    /^169\.254\./u.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host);
  if (blocked) throw new ApiError(422, "unsafe_webhook_url", "Private webhook targets are not allowed.");
}

export const automationRoutes = new Hono<AppEnv>();

automationRoutes.get("/alerts", async (c) => {
  const principal = c.get("principal");
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT a.*, p.name AS project_name, q.query_text
     FROM alerts a
     JOIN projects p ON p.id = a.project_id
     LEFT JOIN tracked_queries q ON q.id = a.tracked_query_id
     WHERE p.workspace_id = ?
     ORDER BY a.created_at DESC LIMIT 200`,
  )
    .bind(principal.workspaceId)
    .all();
  return c.json({ data: rows.results });
});

automationRoutes.patch(
  "/alerts/:id/read",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const result = await c.env.CONTROL_DB.prepare(
      `UPDATE alerts SET is_read = 1
       WHERE id = ? AND project_id IN (
         SELECT id FROM projects WHERE workspace_id = ?
       )`,
    )
      .bind(id, principal.workspaceId)
      .run();
    if (result.meta.changes === 0) throw new ApiError(404, "alert_not_found", "Alert not found.");
    return c.json({ data: { id, isRead: true } });
  },
);

automationRoutes.get(
  "/projects/:id/alert-rules",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    await assertProject(c.env.CONTROL_DB, principal.workspaceId, id);
    const rows = await c.env.CONTROL_DB.prepare(
      "SELECT * FROM alert_rules WHERE project_id = ? ORDER BY created_at DESC",
    )
      .bind(id)
      .all();
    return c.json({ data: rows.results });
  },
);

automationRoutes.post(
  "/projects/:id/alert-rules",
  zValidator("param", IdParamSchema),
  zValidator("json", AlertRuleInputSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id: projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    await assertProject(c.env.CONTROL_DB, principal.workspaceId, projectId);
    const id = crypto.randomUUID();
    const now = nowIso();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO alert_rules (
        id, project_id, name, event_type, threshold, tracked_brand_id,
        is_enabled, channels_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(
        id,
        projectId,
        input.name,
        input.eventType,
        input.threshold ?? null,
        input.trackedBrandId ?? null,
        JSON.stringify(input.channels),
        now,
        now,
      )
      .run();
    return c.json({ data: { id } }, 201);
  },
);

automationRoutes.get("/webhook-destinations", async (c) => {
  const principal = requireRole(c, "admin");
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT id, name, url, is_enabled, created_at, updated_at
     FROM webhook_destinations WHERE workspace_id = ? ORDER BY name`,
  )
    .bind(principal.workspaceId)
    .all();
  return c.json({ data: rows.results });
});

automationRoutes.post(
  "/webhook-destinations",
  zValidator("json", WebhookDestinationInputSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const input = c.req.valid("json");
    assertSafeWebhookUrl(input.url);
    const id = crypto.randomUUID();
    const now = nowIso();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO webhook_destinations (
        id, workspace_id, name, url, is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(id, principal.workspaceId, input.name, input.url, now, now)
      .run();
    const signingSecret = await hmac(id, c.env.APP_CRYPTO_KEY);
    return c.json({ data: { id, signingSecret } }, 201);
  },
);

automationRoutes.get("/exports", async (c) => {
  const principal = c.get("principal");
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT id, project_id, format, status, row_count, error_message,
      expires_at, created_at, updated_at
     FROM exports WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(principal.workspaceId)
    .all();
  return c.json({ data: rows.results });
});

automationRoutes.post(
  "/exports",
  zValidator("json", ExportInputSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const input = c.req.valid("json");
    if (input.projectId) {
      await assertProject(c.env.CONTROL_DB, principal.workspaceId, input.projectId);
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO exports (
        id, workspace_id, requested_by_user_id, project_id, format,
        status, filters_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
      .bind(
        id,
        principal.workspaceId,
        principal.userId,
        input.projectId ?? null,
        input.format,
        JSON.stringify({ dateFrom: input.dateFrom, dateTo: input.dateTo }),
        now,
        now,
      )
      .run();
    await c.env.EXPORT_QUEUE.send({ exportId: id });
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "export.requested",
      resourceType: "export",
      resourceId: id,
    });
    return c.json({ data: { id, status: "queued" } }, 202);
  },
);

automationRoutes.get(
  "/exports/:id/download",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const row = await c.env.CONTROL_DB.prepare(
      `SELECT r2_key, format, expires_at FROM exports
       WHERE id = ? AND workspace_id = ? AND status = 'completed'`,
    )
      .bind(id, principal.workspaceId)
      .first<{ r2_key: string; format: string; expires_at: string }>();
    if (!row || Date.parse(row.expires_at) < Date.now()) {
      throw new ApiError(404, "export_not_found", "Export is unavailable or expired.");
    }
    const object = await c.env.EVIDENCE_BUCKET.get(row.r2_key);
    if (!object) throw new ApiError(404, "export_not_found", "Export file not found.");
    return new Response(object.body, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="ai-tracker-${id}.${row.format}.gz"`,
        "cache-control": "private, no-store",
      },
    });
  },
);

automationRoutes.get("/settings/locales", async (c) => {
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT kind, code, name, payload_json, refreshed_at
     FROM locale_catalog ORDER BY kind, name`,
  ).all();
  return c.json({ data: rows.results });
});

automationRoutes.get("/settings/health", async (c) => {
  const principal = requireRole(c, "admin");
  const [workspace, jobs, shards, dlq] = await Promise.all([
    c.env.CONTROL_DB.prepare(
      `SELECT id, name, public_base_url, monthly_run_cap, timezone
       FROM workspaces WHERE id = ?`,
    )
      .bind(principal.workspaceId)
      .first(),
    c.env.CONTROL_DB.prepare(
      `SELECT status, COUNT(*) AS count FROM crawl_jobs
       WHERE workspace_id = ?
         AND julianday(created_at) >= julianday('now', '-24 hours')
       GROUP BY status`,
    )
      .bind(principal.workspaceId)
      .all(),
    c.env.CONTROL_DB.prepare(
      "SELECT * FROM shard_registry ORDER BY shard_id",
    ).all(),
    c.env.CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count FROM ingest_events
       WHERE status = 'failed'
         AND julianday(received_at) >= julianday('now', '-24 hours')`,
    ).first(),
  ]);
  return c.json({
    data: {
      workspace,
      jobs: jobs.results,
      shards: shards.results,
      failedIngestEvents: dlq,
    },
  });
});
