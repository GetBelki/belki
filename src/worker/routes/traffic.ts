import { Hono, type Context } from "hono";
import { z } from "zod";
import { TrafficSettingsSchema, TrafficSourceIdSchema, type TrafficTestResult } from "../../shared/traffic";
import type { AppEnv } from "../lib/app";
import { requireRole, assertOperator } from "../lib/auth";
import { randomToken, sha256 } from "../lib/crypto";
import { ApiError } from "../lib/http";
import { body, type SettingsRow } from "../lib/traffic-common";
import { analyticsInstallation } from "../lib/traffic-installation";
async function project(c: Context<AppEnv>): Promise<string> {
  const id = c.req.param("projectId");
  const row = await c.env.CONTROL_DB.prepare(`SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND archived_at IS NULL`)
    .bind(id, c.get("principal").workspaceId).first<{ id: string }>();
  if (!row) throw new ApiError(404, "project_not_found", "Project not found.");
  return row.id;
}
async function settings(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM traffic_settings WHERE project_id = ?").bind(id).first<SettingsRow>();
}
export const trafficRoutes = new Hono<AppEnv>();
trafficRoutes.get("/:projectId/config", async (c) => {
  const row = await settings(c.env.CONTROL_DB, await project(c));
  return c.json({ data: row ? { ...TrafficSettingsSchema.parse(JSON.parse(row.config_json)), enabled: Boolean(row.enabled), key: row.public_key, lastEvent: row.last_event_at, installation: analyticsInstallation(c.env, c.req.url) }
    : { enabled: false, domains: [], customSources: [], aliases: [], goals: [], key: null, lastEvent: null, installation: analyticsInstallation(c.env, c.req.url) } });
});
trafficRoutes.put("/:projectId/config", async (c) => {
  requireRole(c, "editor");
  const id = await project(c);
  const parsed = TrafficSettingsSchema.safeParse(await body(c));
  if (!parsed.success) throw new ApiError(400, "invalid_settings", parsed.error.issues[0]?.message ?? "Invalid settings.");
  const previous = await settings(c.env.CONTROL_DB, id);
  const oldGoals = previous ? TrafficSettingsSchema.parse(JSON.parse(previous.config_json)).goals : [];
  // Changing a goal's matching rule creates a new definition; completed goals remain historical.
  parsed.data.goals = parsed.data.goals.map((goal) => {
    const old = oldGoals.find((g) => g.id === goal.id);
    return old && (old.type !== goal.type || old.value !== goal.value) ? { ...goal, id: crypto.randomUUID() } : goal;
  });
  await c.env.CONTROL_DB.prepare(`INSERT INTO traffic_settings (project_id, public_key, enabled, config_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json`)
    .bind(id, randomToken(), Number(parsed.data.enabled), JSON.stringify(parsed.data)).run();
  const row = (await settings(c.env.CONTROL_DB, id))!;
  return c.json({ data: { ...parsed.data, key: row.public_key, lastEvent: row.last_event_at, installation: analyticsInstallation(c.env, c.req.url) } });
});

trafficRoutes.post("/:projectId/test", async (c) => {
  requireRole(c, "editor");
  const id = await project(c);
  const row = await settings(c.env.CONTROL_DB, id);
  if (!row) throw new ApiError(409, "save_settings", "Save your authorized domains first.");
  const parsed = z.object({ url: z.url().max(2048) }).strict().safeParse(await body(c));
  if (!parsed.success) throw new ApiError(400, "invalid_url", "Enter the URL of an authorized page.");
  const url = new URL(parsed.data.url);
  const config = TrafficSettingsSchema.parse(JSON.parse(row.config_json));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !config.domains.includes(url.hostname)) {
    throw new ApiError(400, "invalid_url", "Use a page on an authorized domain, without credentials.");
  }
  const token = randomToken();
  const expiresAt = Date.now() + 10 * 60_000;
  await c.env.CONTROL_DB.prepare(`INSERT INTO traffic_installation_tests (project_id, token_hash, expires_at, result_json)
    VALUES (?, ?, ?, NULL) ON CONFLICT(project_id) DO UPDATE SET token_hash = excluded.token_hash,
    expires_at = excluded.expires_at, result_json = NULL`).bind(id, await sha256(token), expiresAt).run();
  url.searchParams.set("belki_test", token);
  return c.json({ data: { url: url.href, expiresAt } });
});
trafficRoutes.get("/:projectId/test", async (c) => {
  const id = await project(c);
  const row = await c.env.CONTROL_DB.prepare("SELECT expires_at, result_json FROM traffic_installation_tests WHERE project_id = ? AND expires_at > ?")
    .bind(id, Date.now()).first<{ expires_at: number; result_json: string | null }>();
  return c.json({ data: row ? { expiresAt: row.expires_at, result: row.result_json ? { event: null, goals: [], ...(JSON.parse(row.result_json) as { receivedAt: number; path: string; event?: string; goals?: string[] }) } : null } satisfies TrafficTestResult : null });
});

const ReportQuery = z.object({
  from: z.iso.date(), to: z.iso.date(), source: TrafficSourceIdSchema.optional(),
});
export function trafficRetentionCutoff(now = new Date()): number {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return cutoff.getTime();
}
export async function retainTraffic(db: D1Database) {
  await db.prepare("DELETE FROM traffic_installation_tests WHERE expires_at < ?").bind(Date.now()).run();
  // Cascades remove pages, conversions and receipts. Bound cleanup work per invocation.
  return db.prepare(`DELETE FROM traffic_sessions WHERE rowid IN
    (SELECT rowid FROM traffic_sessions WHERE started_at < ? LIMIT 10000)`)
    .bind(trafficRetentionCutoff()).run();
}
trafficRoutes.get("/:projectId/report", async (c) => {
  const id = await project(c);
  const parsed = ReportQuery.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(400, "invalid_period", "Select valid dates.");
  const from = Date.parse(parsed.data.from), to = Date.parse(parsed.data.to) + 86_400_000;
  if (to <= from || to - from > 367 * 86_400_000) throw new ApiError(400, "invalid_period", "Select up to 12 months.");
  const db = c.env.CONTROL_DB;
  const bindings = [id, Math.max(from, trafficRetentionCutoff()), to, ...(parsed.data.source ? [parsed.data.source] : [])];
  const where = `s.project_id = ? AND s.started_at >= ? AND s.started_at < ?${parsed.data.source ? " AND s.source = ?" : ""}`;
  const base = `WITH selected AS (SELECT s.* FROM traffic_sessions s WHERE ${where}),
    facts AS (SELECT s.*, COALESCE(p.views, 0) AS views, COALESCE(p.visible_ms, 0) AS visible_ms,
      EXISTS(SELECT 1 FROM traffic_conversions c WHERE c.project_id = s.project_id AND c.session_id = s.id) AS converted
      FROM selected s LEFT JOIN (SELECT p.session_id, COUNT(*) AS views, SUM(p.visible_ms) AS visible_ms
        FROM traffic_pages p JOIN selected s ON s.project_id = p.project_id AND s.id = p.session_id GROUP BY p.session_id) p ON p.session_id = s.id)`;
  const breakdown = (column: string) => db.prepare(`${base} SELECT ${column} AS label, COUNT(*) AS sessions, SUM(views) AS views, SUM(converted) AS converted
    FROM facts GROUP BY ${column} ORDER BY sessions DESC LIMIT 100`).bind(...bindings);
  const results = await db.batch([
    db.prepare(`${base} SELECT COUNT(*) AS sessions, COALESCE(SUM(views), 0) AS views,
      COALESCE(SUM(visible_ms), 0) AS visibleMs, COALESCE(SUM(converted), 0) AS converted FROM facts`).bind(...bindings),
    db.prepare(`${base} SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS label, COUNT(*) AS sessions, SUM(views) AS views
      FROM facts GROUP BY label ORDER BY label`).bind(...bindings),
    breakdown("source"), breakdown("hostname || entry_path"), breakdown("country"), breakdown("device"),
    db.prepare(`${base} SELECT s.hostname || p.path AS label, COUNT(DISTINCT s.id) AS sessions, COUNT(*) AS views,
      COUNT(DISTINCT CASE WHEN s.converted THEN s.id END) AS converted FROM facts s JOIN traffic_pages p
      ON p.project_id = s.project_id AND p.session_id = s.id GROUP BY label ORDER BY views DESC LIMIT 100`).bind(...bindings),
    db.prepare(`${base} SELECT c.goal_name AS label, COUNT(*) AS sessions FROM traffic_conversions c
      JOIN selected s ON s.project_id = c.project_id AND s.id = c.session_id GROUP BY c.goal_id, c.goal_name ORDER BY sessions DESC`).bind(...bindings),
  ]);
  return c.json({ data: { summary: results[0]?.results[0], daily: results[1]?.results,
    sources: results[2]?.results, entries: results[3]?.results, countries: results[4]?.results,
    devices: results[5]?.results, pages: results[6]?.results, goals: results[7]?.results } });
});

export const trafficOperatorRoutes = new Hono<AppEnv>();
trafficOperatorRoutes.get("/operator/analytics", async (c) => {
  await assertOperator(c);
  return c.json({ data: analyticsInstallation(c.env, c.req.url) });
});
trafficOperatorRoutes.post("/operator/analytics/check", async (c) => {
  await assertOperator(c);
  const installation = analyticsInstallation(c.env, c.req.url);
  const results = await Promise.all([
    { name: "JavaScript", url: installation.scriptUrl, method: "HEAD" },
    { name: "Event service", url: `${installation.origin}/v1/health`, method: "GET" },
  ].map(async ({ name, url, method }) => {
    try {
      const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(5000) });
      const valid = name === "JavaScript" ? /javascript/.test(response.headers.get("Content-Type") ?? "")
        : (await response.json<{ service?: string }>()).service === "belki-analytics";
      return { name, ok: response.ok && valid };
    } catch { return { name, ok: false }; }
  }));
  return c.json({ data: results });
});
