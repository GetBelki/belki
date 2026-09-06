import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ANALYTICS_SDK } from "../src/analytics/sdk";
import { TRAFFIC_ALIASES, TrafficSettingsSchema, trafficAliases } from "../src/shared/traffic";

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
type Payload = Record<string, unknown>;
async function browser(url: string, options: {
  storage?: Map<string, string>; blocked?: boolean; script?: string; api?: string;
  response?: (payload: Payload) => number | "offline";
  queue?: Array<{ name: string; at: number; url: string }>;
} = {}) {
  let now = 100000000;
  const storage = options.storage ?? new Map<string, string>();
  const events: Payload[] = [], requests: string[] = [];
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  const intervals: Array<() => void> = [];
  const timers = new Map<number, { at: number; fn: () => void }>(); let nextTimer = 0;
  const listen = (name: string, callback: (event?: unknown) => void) => listeners.set(name, [...listeners.get(name) ?? [], callback]);
  const location = { href: url };
  const document = { currentScript: { src: options.script ?? "https://belki.example/belki-analytics.js", getAttribute: (name: string) => name === "data-site" ? "test-key" : options.api ?? null }, visibilityState: "visible", addEventListener: listen };
  const history = {
    pushState(_state: unknown, _unused: unknown, path: string) { location.href = new URL(path, location.href).href; },
    replaceState(_state: unknown, _unused: unknown, path: string) { location.href = new URL(path, location.href).href; },
  };
  const win = { belki: { q: options.queue ?? [] } as unknown as { track: (name: string) => void } };
  const fetch = (url: string, init?: { body?: string }) => {
    requests.push(url);
    let status = 200;
    if (init?.body) {
      const payload = JSON.parse(init.body) as Payload; events.push(payload);
      const result = options.response?.(payload) ?? 204;
      if (result === "offline") return Promise.reject(new Error("offline"));
      status = result;
    }
    return Promise.resolve({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: () => Promise.resolve({ aliases: { ...TRAFFIC_ALIASES, custom: "claude" } }) });
  };
  runInNewContext(ANALYTICS_SDK, {
    window: win, document, location, history, crypto, URL, fetch,
    navigator: { sendBeacon(_url: string, body: string) { events.push(JSON.parse(body) as Payload); return true; } },
    sessionStorage: {
      getItem(k: string) { if (options.blocked) throw Error(); return storage.get(k); },
      setItem(k: string, v: string) { if (options.blocked) throw Error(); storage.set(k, v); },
      removeItem(k: string) { storage.delete(k); },
    },
    Date: { now: () => now }, addEventListener: listen, setInterval: (fn: () => void) => intervals.push(fn),
    setTimeout(fn: () => void, delay: number) { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  await settle();
  return { events, requests, storage, document, history, win, location,
    fire(name: string, event?: unknown) { for (const fn of listeners.get(name) ?? []) fn(event); },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      for (const fn of intervals) fn();
    },
  };
}
describe("standalone traffic tag", () => {
  it("does not emit events or identifiers for untagged or unknown sources", async () => {
    for (const query of ["", "?utm_source=google", "?utm_source=__proto__"]) {
      const tab = await browser(`https://example.com/${query}`);
      tab.win.belki.track("signup"); tab.advance(15000); await settle();
      expect(tab.events).toHaveLength(0);
      expect(tab.storage.size).toBe(0);
      if (!query) expect(tab.requests).toHaveLength(0);
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
    tab.advance(31 * 60000); await settle();
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
  it("uses an explicit API origin when the script is hosted on a CDN", async () => {
    const tab = await browser("https://example.com/?utm_source=chatgpt", { script: "https://cdn.example/belki-analytics.js", api: "https://analytics.example" });
    expect(tab.requests.every((url) => url.startsWith("https://analytics.example/v1/"))).toBe(true);
  });
  it("retains conversion IDs and their page context across a failed delivery and navigation", async () => {
    const first = await browser("https://example.com/?utm_source=chatgpt", { response: () => "offline" });
    first.history.pushState(null, "", "/signup"); first.win.belki.track("signup_completed"); await settle();
    const original = first.events.find((event) => event.type === "event")!;
    const next = await browser("https://example.com/thanks", { storage: first.storage });
    next.advance(3000); await settle();
    expect(next.events.find((event) => event.id === original.id)).toEqual(original);
    await settle();
    expect([...next.storage.keys()].some((key) => key.includes(":outbox:"))).toBe(false);
  });
  it("retries transient failures with the same ID but drops permanent validation errors", async () => {
    let attempt = 0;
    const tab = await browser("https://example.com/?utm_source=chatgpt", { response: (event) => event.type === "event" && ++attempt === 1 ? 503 : 204 });
    tab.win.belki.track("signup"); await settle(); tab.advance(3000); await settle();
    const events = tab.events.filter((event) => event.type === "event");
    expect(events).toHaveLength(2); expect(events[1]?.id).toBe(events[0]?.id);
    const invalid = await browser("https://example.com/?utm_source=chatgpt", { response: () => 400 });
    await settle(); expect([...invalid.storage.keys()].some((key) => key.includes(":outbox:"))).toBe(false);
  });
  it("captures pre-load calls with their original URL without attributing earlier untagged events", async () => {
    const tab = await browser("https://example.com/?utm_source=chatgpt", { queue: [
      { name: "too_early", at: 99999000, url: "https://example.com/" },
      { name: "signup", at: 100000000, url: "https://example.com/?utm_source=chatgpt" },
    ] });
    expect(tab.events.filter((event) => event.type === "event").map((event) => event.event)).toEqual(["signup"]);
  });
  it("starts collection on a later tagged SPA navigation without an initial configuration request", async () => {
    const tab = await browser("https://example.com/");
    expect(tab.requests).toHaveLength(0);
    tab.history.pushState(null, "", "/pricing?utm_source=custom"); await settle();
    expect(tab.events[0]).toMatchObject({ utm: "custom", entryPath: "/pricing" });
  });
  it("keeps diagnostic traffic separate and removes its token from the visible URL", async () => {
    const tab = await browser("https://example.com/?belki_test=temporary-test-token&x=1");
    tab.win.belki.track("signup"); await settle();
    expect(tab.events.every((event) => event.test === "temporary-test-token")).toBe(true);
    expect(tab.location.href).toBe("https://example.com/?x=1");
    expect([...tab.storage.keys()]).toEqual(["belki-analytics:test-key:test"]);
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
