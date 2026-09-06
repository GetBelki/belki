import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { TRAFFIC_TAG } from "../src/worker/lib/traffic-tag";
import { TRAFFIC_ALIASES, TrafficSettingsSchema, trafficAliases } from "../src/shared/traffic";

async function browser(url: string, options: { storage?: Map<string, string>; blocked?: boolean } = {}) {
  let now = 100000000;
  const storage = options.storage ?? new Map<string, string>();
  const events: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  const intervals: Array<() => void> = [];
  const listen = (name: string, callback: (event?: unknown) => void) => listeners.set(name, [...listeners.get(name) ?? [], callback]);
  const location = { href: url };
  const document = { currentScript: { src: "https://belki.example/api/traffic/v1.js", getAttribute: () => "test-key" }, visibilityState: "visible", addEventListener: listen };
  const history = {
    pushState(_state: unknown, _unused: unknown, path: string) { location.href = new URL(path, location.href).href; },
    replaceState(_state: unknown, _unused: unknown, path: string) { location.href = new URL(path, location.href).href; },
  };
  const win = { belki: undefined as unknown as { track: (name: string) => void } };
  const fetch = (_url: string, init?: { body?: string }) => {
    if (init?.body) events.push(JSON.parse(init.body) as Record<string, unknown>);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ aliases: { ...TRAFFIC_ALIASES, custom: "claude" } }) });
  };
  runInNewContext(TRAFFIC_TAG, {
    window: win, document, location, history, crypto, URL, fetch,
    navigator: { sendBeacon(_url: string, body: string) { events.push(JSON.parse(body) as Record<string, unknown>); return true; } },
    sessionStorage: {
      getItem(k: string) { if (options.blocked) throw Error(); return storage.get(k); },
      setItem(k: string, v: string) { if (options.blocked) throw Error(); storage.set(k, v); },
      removeItem(k: string) { storage.delete(k); },
    },
    Date: { now: () => now }, addEventListener: listen, setInterval: (fn: () => void) => intervals.push(fn),
  });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return { events, storage, document, history, win,
    fire(name: string, event?: unknown) { for (const fn of listeners.get(name) ?? []) fn(event); },
    advance(ms: number) { now += ms; for (const fn of intervals) fn(); },
  };
}
describe("standalone traffic tag", () => {
  it("does not emit events or identifiers for untagged or unknown sources", async () => {
    for (const query of ["", "?utm_source=google", "?utm_source=__proto__"]) {
      const tab = await browser(`https://example.com/${query}`);
      tab.win.belki.track("signup"); tab.advance(15000);
      expect(tab.events).toHaveLength(0);
      expect(tab.storage.size).toBe(0);
    }
  });
  it("attributes SPA navigation and explicit conversions without leaking query data", async () => {
    const tab = await browser("https://example.com/?utm_source=ChatGPT&email=private@example.com");
    const id = tab.events[0]?.sessionId;
    tab.advance(15000);
    tab.history.pushState(null, "", "/pricing");
    tab.win.belki.track("signup");
    expect(tab.events.every((e) => e.sessionId === id)).toBe(true);
    expect(new Set(tab.events.map((e) => e.pageId)).size).toBe(2);
    expect(tab.events.at(-1)).toMatchObject({ type: "event", event: "signup", path: "/pricing", utm: "chatgpt" });
    expect(JSON.stringify(tab.events)).not.toContain("private@example.com");
    tab.history.replaceState(null, "", "/pricing?sort=asc#detail");
    expect(new Set(tab.events.map((e) => e.pageId)).size).toBe(2);
  });
  it("preserves sessions on reload and starts a new attribution for a different campaign", async () => {
    const tab = await browser("https://example.com/?utm_source=chatgpt");
    const reload = await browser("https://example.com/?utm_source=chatgpt", { storage: tab.storage });
    expect(reload.events[0]?.sessionId).toBe(tab.events[0]?.sessionId);
    expect(reload.events[0]?.pageId).not.toBe(tab.events[0]?.pageId);
    reload.history.pushState(null, "", "/?utm_source=custom");
    expect(reload.events.at(-1)?.sessionId).not.toBe(tab.events[0]?.sessionId);
    expect(reload.events.at(-1)?.utm).toBe("custom");
    reload.history.pushState(null, "", "/?utm_source=newsletter");
    const length = reload.events.length;
    reload.win.belki.track("signup"); reload.advance(15000);
    expect(reload.events).toHaveLength(length);
  });
  it("heartbeats do not keep an inactive session alive", async () => {
    const tab = await browser("https://example.com/?utm_source=chatgpt");
    tab.advance(31 * 60000);
    expect(tab.events).toHaveLength(1);
    tab.win.belki.track("signup");
    expect(tab.events).toHaveLength(1);
    expect(tab.storage.size).toBe(0);
  });
  it("updates activity from interactions and excludes hidden time", async () => {
    const tab = await browser("https://example.com/?utm_source=chatgpt");
    tab.advance(15000);
    expect(tab.events.at(-1)?.visibleMs).toBe(15000);
    tab.document.visibilityState = "hidden"; tab.fire("visibilitychange");
    tab.advance(60000);
    tab.document.visibilityState = "visible"; tab.fire("visibilitychange");
    tab.fire("pointerdown"); tab.advance(15000);
    expect(tab.events.at(-1)?.visibleMs).toBe(30000);
    expect(tab.events.at(-1)?.activityAt).toBeGreaterThan(tab.events[0]?.activityAt as number);
  });
  it("falls back to the current document if sessionStorage is blocked", async () => {
    const tab = await browser("https://example.com/?utm_source=chatgpt", { blocked: true });
    tab.win.belki.track("signup");
    expect(tab.events.at(-1)?.type).toBe("event");
    const next = await browser("https://example.com/thanks", { blocked: true });
    expect(next.events).toHaveLength(0);
  });
});
describe("traffic settings", () => {
  it("normalizes aliases and rejects ambiguity, wildcard domains and query-based goals", () => {
    const settings = { enabled: true, domains: ["example.com"], aliases: [{ alias: " MY-AI ", source: "grok" }], goals: [] };
    const parsed = TrafficSettingsSchema.parse(settings);
    expect(trafficAliases(parsed.aliases)["my-ai"]).toBe("grok");
    expect(TrafficSettingsSchema.safeParse({ ...settings, aliases: [{ alias: "chatgpt", source: "grok" }] }).success).toBe(false);
    expect(TrafficSettingsSchema.safeParse({ ...settings, domains: ["*.example.com"] }).success).toBe(false);
    expect(TrafficSettingsSchema.safeParse({ ...settings, goals: [{ id: crypto.randomUUID(), name: "Goal", type: "path", value: "/thanks?user=1" }] }).success).toBe(false);
  });
});
