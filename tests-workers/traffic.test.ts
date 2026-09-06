import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/control/0037_ai_traffic.sql?raw";
import type { AppEnv } from "../src/worker/lib/app";
import { ApiError } from "../src/worker/lib/http";
import { retainTraffic, trafficPublicRoutes, trafficRoutes } from "../src/worker/routes/traffic";
import type { TrafficReport, TrafficSettings } from "../src/shared/traffic";

const db = (env as unknown as { TRAFFIC_TEST_DB: D1Database }).TRAFFIC_TEST_DB;
const key = "test-public-key-with-enough-entropy";
const goalId = crypto.randomUUID();
const config: TrafficSettings = { enabled: true, domains: ["example.com"], aliases: [{ alias: "custom", source: "claude" }], goals: [
  { id: goalId, name: "Thanks", type: "path", value: "/thanks" },
  { id: crypto.randomUUID(), name: "Signup", type: "event", value: "signup" },
] };
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("principal", { workspaceId: c.req.header("x-workspace") ?? "w1", role: c.req.header("x-role") ?? "editor" } as AppEnv["Variables"]["principal"]);
  await next();
});
app.onError((e, c) => c.json({ error: e.message }, e instanceof ApiError ? e.status : 500));
app.route("/api/traffic", trafficPublicRoutes);
app.route("/api/v1/traffic", trafficRoutes);
const bindings = { CONTROL_DB: db } as Env;
function request(path: string, init?: RequestInit) { return app.request(`https://belki.example${path}`, init, bindings); }
function event(overrides = {}) {
  return { key, id: crypto.randomUUID(), sessionId: crypto.randomUUID(), pageId: crypto.randomUUID(),
    utm: "chatgpt", startedAt: Date.now() - 60000, activityAt: Date.now(), entryPath: "/", path: "/", visibleMs: 0, type: "page", ...overrides };
}
function collect(payload: ReturnType<typeof event>, origin = "https://example.com") {
  return request("/api/traffic/collect", { method: "POST", headers: { Origin: origin, "User-Agent": "Mozilla/5.0 (iPhone) Mobile" }, body: JSON.stringify(payload) });
}
async function report() {
  const day = new Date().toISOString().slice(0, 10);
  const response = await request(`/api/v1/traffic/p1/report?from=${day}&to=${day}`);
  expect(response.status).toBe(200);
  const payload: { data: TrafficReport } = await response.json();
  return payload.data;
}
beforeAll(async () => {
  await db.batch([
    db.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, status TEXT)"),
    db.prepare("CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT, deleted_at TEXT, archived_at TEXT)"),
    db.prepare("CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_started_at TEXT, attempts INTEGER)"),
    ...migration.split(";").map((s) => s.trim()).filter(Boolean).map((sql) => db.prepare(sql)),
  ]);
});
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM traffic_sessions"), db.prepare("DELETE FROM traffic_settings"), db.prepare("DELETE FROM projects"),
    db.prepare("DELETE FROM workspaces"), db.prepare("DELETE FROM rate_limits"),
    db.prepare("INSERT INTO workspaces VALUES ('w1', 'active'), ('w2', 'active')"),
    db.prepare("INSERT INTO projects VALUES ('p1', 'w1', NULL, NULL), ('p2', 'w2', NULL, NULL)"),
    db.prepare("INSERT INTO traffic_settings VALUES ('p1', ?, 1, ?, NULL)").bind(key, JSON.stringify(config)),
  ]);
});
describe("AI traffic on D1", () => {
  it("rejects unknown sources, unauthorized domains and oversized bodies without storing sessions", async () => {
    expect((await collect(event({ utm: "google" }))).status).toBe(400);
    expect((await collect(event(), "https://evil.example.com")).status).toBe(403);
    expect((await request("/api/traffic/collect", { method: "POST", body: "x".repeat(5000) })).status).toBe(413);
    expect((await report()).summary.sessions).toBe(0);
  });
  it("deduplicates views, cumulative visible time and conversion retries", async () => {
    const first = event({ path: "/thanks", visibleMs: 1000 });
    expect((await collect(first)).status).toBe(204);
    await collect(first);
    await collect({ ...first, id: crypto.randomUUID(), visibleMs: 5000 });
    await collect({ ...first, id: crypto.randomUUID(), visibleMs: 3000 });
    const signup = { ...first, id: crypto.randomUUID(), type: "event", event: "signup", visibleMs: 5000 };
    await collect(signup); await collect(signup);
    const result = await report();
    expect(result.summary).toEqual({ sessions: 1, views: 1, visibleMs: 5000, converted: 1 });
    expect(result.goals.map((g) => g.sessions)).toEqual([1, 1]);
    expect(result.devices[0]?.label).toBe("mobile");
    expect(result.countries[0]?.label).toBe("unknown");
    await collect({ ...first, id: crypto.randomUUID(), pageId: crypto.randomUUID(), path: "/pricing", visibleMs: 0 });
    expect((await report()).summary.views).toBe(2);
  });
  it("accepts custom aliases and enforces tenant and role isolation", async () => {
    await collect(event({ utm: "custom" }));
    expect((await report()).sources[0]?.label).toBe("claude");
    expect((await request("/api/v1/traffic/p1/config", { headers: { "x-workspace": "w2" } })).status).toBe(404);
    expect((await request("/api/v1/traffic/p1/config", { method: "PUT", headers: { "x-role": "viewer" }, body: JSON.stringify(config) })).status).toBe(403);
    expect((await request(`/api/traffic/config/${key}`, { headers: { Origin: "https://example.com" } })).headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  });
  it("does not apply newly configured path goals to a heartbeat or a retried event", async () => {
    const first = event({ path: "/pricing", type: "event", event: "purchase" });
    await collect(first);
    const updated = { ...config, goals: [
      { id: crypto.randomUUID(), name: "Pricing", type: "path", value: "/pricing" },
      { id: crypto.randomUUID(), name: "Purchase", type: "event", value: "purchase" },
    ] };
    await request("/api/v1/traffic/p1/config", { method: "PUT", body: JSON.stringify(updated) });
    await collect(first);
    await collect({ ...first, id: crypto.randomUUID(), type: "page" });
    expect((await report()).summary.converted).toBe(0);
    await collect({ ...first, id: crypto.randomUUID(), pageId: crypto.randomUUID(), type: "page" });
    expect((await report()).summary.converted).toBe(1);
  });
  it("expires inactive sessions and rejects collection after disabling", async () => {
    const first = event(); await collect(first);
    await db.prepare("UPDATE traffic_sessions SET activity_at = ?").bind(Date.now() - 31 * 60000).run();
    expect((await collect({ ...first, activityAt: Date.now() })).status).toBe(400);
    await db.prepare("UPDATE traffic_settings SET enabled = 0").run();
    expect((await collect(event())).status).toBe(404);
  });
  it("accepts activity just before expiry when its heartbeat arrives slightly later", async () => {
    const first = event(); await collect(first);
    await db.prepare("UPDATE traffic_sessions SET activity_at = ?").bind(Date.now() - 30 * 60000 - 5000).run();
    expect((await collect({ ...first, activityAt: Date.now() - 10000 })).status).toBe(204);
  });
  it("deletes expired history with its child records", async () => {
    await collect(event({ path: "/thanks", type: "event", event: "signup" }));
    await db.prepare("UPDATE traffic_sessions SET started_at = ?").bind(Date.now() - 400 * 86400000).run();
    await retainTraffic(db);
    for (const table of ["traffic_sessions", "traffic_pages", "traffic_conversions", "traffic_events"]) {
      expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n).toBe(0);
    }
  });
});
