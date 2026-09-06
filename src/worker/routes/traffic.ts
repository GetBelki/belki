import { Hono, type Context } from "hono";
import { z } from "zod";
import { TrafficSettingsSchema, trafficAliases, trafficDevice, trafficPath, TRAFFIC_SOURCES, type TrafficSettings } from "../../shared/traffic";
import type { AppEnv } from "../lib/app";
import { checkLoginRateLimit, requireRole } from "../lib/auth";
import { randomToken } from "../lib/crypto";
import { ApiError, readBoundedText, RequestBodyTooLargeError, InvalidContentLengthError } from "../lib/http";
import { TRAFFIC_TAG } from "../lib/traffic-tag";

type SettingsRow = { project_id: string; public_key: string; enabled: number; config_json: string; last_event_at: number | null };
const SESSION_TIMEOUT = 30 * 60_000;
const EventSchema = z.object({
  key: z.string().min(20).max(100), id: z.string().uuid(), sessionId: z.string().uuid(), pageId: z.string().uuid(),
  utm: z.string().trim().toLowerCase().min(1).max(100), startedAt: z.number().int().nonnegative(),
  activityAt: z.number().int().nonnegative(), entryPath: trafficPath, path: trafficPath,
  visibleMs: z.number().int().min(0).max(86_400_000), type: z.enum(["page", "event"]),
  event: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).optional(),
}).strict().refine((v) => v.type !== "event" || Boolean(v.event));

async function body(c: Context<AppEnv>, maximum = 16384): Promise<unknown> {
  try { return JSON.parse(await readBoundedText(c.req.raw, maximum)); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw new ApiError(413, "payload_too_large", "Payload too large.");
    if (error instanceof InvalidContentLengthError || error instanceof SyntaxError) throw new ApiError(400, "invalid_body", "Invalid request body.");
    throw error;
  }
}
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
async function publicSettings(c: Context<AppEnv>, key: string): Promise<{ row: SettingsRow; config: TrafficSettings; origin: URL }> {
  let origin: URL;
  try { origin = new URL(c.req.header("Origin") ?? (c.req.header("Sec-Fetch-Site") === "same-origin" ? new URL(c.req.url).origin : "")); }
  catch { throw new ApiError(403, "invalid_origin", "Origin required."); }
  if (!["https:", "http:"].includes(origin.protocol)) throw new ApiError(403, "invalid_origin", "Invalid origin.");
  const row = await c.env.CONTROL_DB.prepare(`SELECT t.* FROM traffic_settings t JOIN projects p ON p.id = t.project_id
    JOIN workspaces w ON w.id = p.workspace_id
    WHERE t.public_key = ? AND t.enabled = 1 AND p.deleted_at IS NULL AND p.archived_at IS NULL AND w.status = 'active'`)
    .bind(key).first<SettingsRow>();
  if (!row) throw new ApiError(404, "traffic_disabled", "Traffic collection unavailable.");
  const config = JSON.parse(row.config_json) as TrafficSettings;
  if (!config.domains.includes(origin.hostname)) throw new ApiError(403, "invalid_origin", "Domain is not authorized.");
  c.header("Access-Control-Allow-Origin", origin.origin);
  c.header("Vary", "Origin");
  c.header("Cache-Control", "no-store");
  return { row, config, origin };
}

export const trafficPublicRoutes = new Hono<AppEnv>();
trafficPublicRoutes.get("/v1.js", (c) => {
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Access-Control-Allow-Origin", "*");
  return c.body(TRAFFIC_TAG);
});
trafficPublicRoutes.get("/config/:key", async (c) => {
  const { config } = await publicSettings(c, c.req.param("key"));
  return c.json({ aliases: trafficAliases(config.aliases) });
});
trafficPublicRoutes.post("/collect", async (c) => {
  const parsed = EventSchema.safeParse(await body(c, 4096));
  if (!parsed.success) throw new ApiError(400, "invalid_event", "Invalid traffic event.");
  const e = parsed.data;
  const { row, config, origin } = await publicSettings(c, e.key);
  const db = c.env.CONTROL_DB;
  const now = Date.now();
  if (e.activityAt > now + 5000 || e.activityAt < now - SESSION_TIMEOUT || e.startedAt > e.activityAt) {
    throw new ApiError(400, "expired_session", "Session expired.");
  }
  const existing = await db.prepare("SELECT hostname, activity_at FROM traffic_sessions WHERE project_id = ? AND id = ?")
    .bind(row.project_id, e.sessionId).first<{ hostname: string; activity_at: number }>();
  const source = trafficAliases(config.aliases)[e.utm];
  if ((!existing && (!source || e.startedAt < now - SESSION_TIMEOUT)) ||
      (existing && (existing.hostname !== origin.hostname || e.activityAt - existing.activity_at > SESSION_TIMEOUT))) {
    throw new ApiError(400, "invalid_session", "Invalid traffic session.");
  }
  // One bounded rate-limit row per project, never keyed by visitor IP or identifier.
  await checkLoginRateLimit(db, `traffic:${row.project_id}`, 30_000);
  const cf = c.req.raw.cf as IncomingRequestCfProperties | undefined;
  const country = typeof cf?.country === "string" && /^[A-Z]{2}$/.test(cf.country) ? cf.country : "unknown";
  const statements = [
    db.prepare(`INSERT INTO traffic_sessions (project_id, id, source, hostname, entry_path, country, device, started_at, activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, id) DO UPDATE SET activity_at = MAX(activity_at, excluded.activity_at)`)
      .bind(row.project_id, e.sessionId, source ?? "unknown", origin.hostname, e.entryPath, country, trafficDevice(c.req.header("User-Agent") ?? ""), e.startedAt, Math.min(now, e.activityAt)),
  ];
  for (const goal of config.goals) {
    if ((goal.type === "path" && goal.value === e.path) || (goal.type === "event" && e.type === "event" && goal.value === e.event)) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO traffic_conversions (project_id, session_id, goal_id, goal_name)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${goal.type === "path" ? "traffic_pages" : "traffic_events"} WHERE project_id = ? AND session_id = ? AND id = ?)`)
        .bind(row.project_id, e.sessionId, goal.id, goal.name, row.project_id, e.sessionId, goal.type === "path" ? e.pageId : e.id));
    }
  }
  statements.push(db.prepare(`INSERT INTO traffic_pages (project_id, session_id, id, path, visible_ms) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, session_id, id) DO UPDATE SET visible_ms = MAX(visible_ms, excluded.visible_ms)`)
    .bind(row.project_id, e.sessionId, e.pageId, e.path, Math.min(e.visibleMs, Math.max(0, now - e.startedAt))));
  // Page updates are cumulative; only custom events need a separate deduplication receipt.
  if (e.type === "event") statements.push(db.prepare("INSERT OR IGNORE INTO traffic_events VALUES (?, ?, ?)").bind(row.project_id, e.sessionId, e.id));
  statements.push(db.prepare("UPDATE traffic_settings SET last_event_at = ? WHERE project_id = ?").bind(now, row.project_id));
  await db.batch(statements);
  return c.body(null, 204);
});

export const trafficRoutes = new Hono<AppEnv>();
trafficRoutes.get("/:projectId/config", async (c) => {
  const row = await settings(c.env.CONTROL_DB, await project(c));
  return c.json({ data: row ? { ...(JSON.parse(row.config_json) as TrafficSettings), enabled: Boolean(row.enabled), key: row.public_key, lastEvent: row.last_event_at }
    : { enabled: false, domains: [], aliases: [], goals: [], key: null, lastEvent: null } });
});
trafficRoutes.put("/:projectId/config", async (c) => {
  requireRole(c, "editor");
  const id = await project(c);
  const parsed = TrafficSettingsSchema.safeParse(await body(c));
  if (!parsed.success) throw new ApiError(400, "invalid_settings", parsed.error.issues[0]?.message ?? "Invalid settings.");
  const previous = await settings(c.env.CONTROL_DB, id);
  const oldGoals = previous ? (JSON.parse(previous.config_json) as TrafficSettings).goals : [];
  // Changing a goal's matching rule creates a new definition; completed goals remain historical.
  parsed.data.goals = parsed.data.goals.map((goal) => {
    const old = oldGoals.find((g) => g.id === goal.id);
    return old && (old.type !== goal.type || old.value !== goal.value) ? { ...goal, id: crypto.randomUUID() } : goal;
  });
  await c.env.CONTROL_DB.prepare(`INSERT INTO traffic_settings (project_id, public_key, enabled, config_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json`)
    .bind(id, randomToken(), Number(parsed.data.enabled), JSON.stringify(parsed.data)).run();
  const row = (await settings(c.env.CONTROL_DB, id))!;
  return c.json({ data: { ...parsed.data, key: row.public_key, lastEvent: row.last_event_at } });
});

const ReportQuery = z.object({
  from: z.iso.date(), to: z.iso.date(), source: z.enum(TRAFFIC_SOURCES).optional(),
});
export function trafficRetentionCutoff(now = new Date()): number {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return cutoff.getTime();
}
export async function retainTraffic(db: D1Database) {
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
