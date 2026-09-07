import { Hono, type Context } from "hono";
import { TrafficSettingsSchema, trafficAliases, trafficDevice, type TrafficSettings } from "../../shared/traffic";
import { checkLoginRateLimit } from "../lib/auth";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/http";
import { body, EventSchema, SESSION_TIMEOUT, type SettingsRow, type TrafficEnv } from "../lib/traffic-common";
async function publicSettings(c: Context<TrafficEnv>, key: string, testToken?: string): Promise<{ row: SettingsRow; config: TrafficSettings; origin: URL }> {
  let origin: URL;
  try { origin = new URL(c.req.header("Origin") ?? (c.req.header("Sec-Fetch-Site") === "same-origin" ? new URL(c.req.url).origin : "")); }
  catch { throw new ApiError(403, "invalid_origin", "Origin required."); }
  if (!["https:", "http:"].includes(origin.protocol)) throw new ApiError(403, "invalid_origin", "Invalid origin.");
  const row = await c.env.CONTROL_DB.prepare(`SELECT t.* FROM traffic_settings t JOIN projects p ON p.id = t.project_id
    JOIN workspaces w ON w.id = p.workspace_id
    WHERE t.public_key = ? AND p.deleted_at IS NULL AND p.archived_at IS NULL AND w.status = 'active'`)
    .bind(key).first<SettingsRow>();
  if (!row) throw new ApiError(404, "traffic_disabled", "Traffic collection unavailable.");
  if (testToken) {
    const test = await c.env.CONTROL_DB.prepare("SELECT expires_at FROM traffic_installation_tests WHERE project_id = ? AND token_hash = ? AND expires_at > ?")
      .bind(row.project_id, await sha256(testToken), Date.now()).first();
    if (!test) throw new ApiError(410, "test_expired", "Create a new installation test in Belki.");
  } else if (!row.enabled) throw new ApiError(404, "traffic_disabled", "Traffic collection unavailable.");
  const config = TrafficSettingsSchema.parse(JSON.parse(row.config_json));
  if (!config.domains.includes(origin.hostname)) throw new ApiError(403, "invalid_origin", "Domain is not authorized.");
  c.header("Access-Control-Allow-Origin", origin.origin);
  c.header("Vary", "Origin");
  c.header("Cache-Control", "no-store");
  return { row, config, origin };
}

export const trafficPublicRoutes = new Hono<TrafficEnv>();
trafficPublicRoutes.use("/v1/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  // Public responses contain no credentials. Reflect Origin on errors as well so
  // clients can distinguish permanent rejection from a transient network failure.
  const origin = c.req.header("Origin");
  if (origin && /^https?:\/\/[^/]+$/.test(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  await next();
});
trafficPublicRoutes.get("/v1/health", (c) => c.json({ service: "belki-analytics", protocol: 1 }));
trafficPublicRoutes.options("/v1/*", (c) => {
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  c.header("Access-Control-Max-Age", "600");
  return c.body(null, 204);
});
trafficPublicRoutes.get("/v1/config/:key", async (c) => {
  const testToken = c.req.query("test");
  const url = new URL(c.req.url);
  const origin = c.req.header("Origin") ?? (c.req.header("Sec-Fetch-Site") === "same-origin" ? url.origin : "");
  url.search = new URLSearchParams({ origin }).toString();
  const cacheKey = new Request(url.href);
  const cache = await caches.open("belki-analytics-config");
  if (!testToken) {
    const hit = await cache.match(cacheKey);
    if (hit) { c.header("Cache-Control", "public, max-age=60"); return hit; }
  }
  const { config } = await publicSettings(c, c.req.param("key"), testToken);
  if (!testToken) c.header("Cache-Control", "public, max-age=60");
  const response = c.json({ aliases: trafficAliases(config) });
  if (!testToken) await cache.put(cacheKey, response.clone());
  return response;
});
trafficPublicRoutes.post("/v1/events", async (c) => {
  const parsed = EventSchema.safeParse(await body(c, 4096));
  if (!parsed.success) throw new ApiError(400, "invalid_event", "Invalid traffic event.");
  const e = parsed.data;
  const { row, config, origin } = await publicSettings(c, e.key, e.test);
  const db = c.env.CONTROL_DB;
  const now = Date.now();
  if (e.occurredAt > now + 5000 || e.occurredAt < now - 5 * 60_000 || e.occurredAt < e.startedAt || e.activityAt > now + 5000 || e.activityAt < now - SESSION_TIMEOUT || e.startedAt > e.activityAt) {
    throw new ApiError(400, "expired_session", "Session expired.");
  }
  if (e.test) {
    await checkLoginRateLimit(db, `traffic-test:${row.project_id}`, 300);
    const goals = config.goals.filter((goal) => goal.type === "path" ? goal.value === e.path : e.type === "event" && goal.value === e.event).map((goal) => goal.name);
    const result = { receivedAt: now, path: e.path, ...(e.event ? { event: e.event } : {}), ...(goals.length ? { goals } : {}) };
    // Test data is isolated, bounded to one result per project, and expires.
    await db.prepare("UPDATE traffic_installation_tests SET result_json = json_patch(COALESCE(result_json, '{}'), ?) WHERE project_id = ? AND token_hash = ? AND expires_at > ?")
      .bind(JSON.stringify(result), row.project_id, await sha256(e.test), now).run();
    return c.body(null, 204);
  }
  const existing = await db.prepare("SELECT hostname, activity_at FROM traffic_sessions WHERE project_id = ? AND id = ?")
    .bind(row.project_id, e.sessionId).first<{ hostname: string; activity_at: number }>();
  const source = trafficAliases(config)[e.utm];
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
