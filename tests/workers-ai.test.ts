import { describe, expect, it, vi } from "vitest";
import {
  aiCacheKey,
  runAI,
  type AiCacheEntry,
  type AiUsageEvent,
  type AiUsageStore,
} from "../src/worker/lib/workers-ai";
import { claimEntityExtractionJob } from "../src/worker/automation/entity-job-claim";

class MemoryAiUsageStore implements AiUsageStore {
  readonly cache = new Map<string, string>();
  readonly events: AiUsageEvent[] = [];
  readonly entries: AiCacheEntry[] = [];

  getCachedResponse(cacheKey: string): Promise<string | null> {
    return Promise.resolve(this.cache.get(cacheKey) ?? null);
  }

  putCachedResponse(entry: AiCacheEntry): Promise<void> {
    this.entries.push(entry);
    this.cache.set(entry.cacheKey, entry.responseJson);
    return Promise.resolve();
  }

  touchCachedResponse(): Promise<void> {
    return Promise.resolve();
  }

  recordUsage(event: AiUsageEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

const context = {
  feature: "entity_extraction",
  operation: "span_extraction",
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  promptVersion: "span-v1",
  projectId: "project-1",
  trackedQueryId: "query-1",
  jobId: "job-1",
  requestId: "job-1:chunk:0:span",
  retryAttempt: 1,
};

const noLog = () => {};

describe("Workers AI cost controls", () => {
  it("atomically allows only one delivery to claim an entity job", async () => {
    let status = "queued";
    let attempts = 0;
    const db = {
      prepare(sql: string) {
        expect(sql).toContain("status IN ('queued', 'failed')");
        return {
          bind() {
            return this;
          },
          run() {
            if (!["queued", "failed"].includes(status)) {
              return Promise.resolve({ meta: { changes: 0 } });
            }
            status = "processing";
            attempts += 1;
            return Promise.resolve({ meta: { changes: 1 } });
          },
        };
      },
    };

    await expect(claimEntityExtractionJob(db, "job-1", "2026-08-31T00:00:00Z"))
      .resolves.toBe(true);
    await expect(claimEntityExtractionJob(db, "job-1", "2026-08-31T00:00:01Z"))
      .resolves.toBe(false);
    expect(attempts).toBe(1);
  });

  it("reuses a validated exact response without invoking AI twice", async () => {
    const store = new MemoryAiUsageStore();
    const invoke = vi.fn(() => Promise.resolve({
      response: { entities: [{ surface: "Contoso", entity_type: "brand" }] },
      usage: { prompt_tokens: 120, completion_tokens: 20 },
    }));
    const parse = (result: unknown) =>
      (result as { response: { entities: unknown[] } }).response;
    const input = { messages: [{ role: "user", content: "Contoso" }] };

    const first = await runAI({ context, input, invoke, parse, store, logger: noLog });
    const second = await runAI({ context, input, invoke, parse, store, logger: noLog });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ cacheHit: false, inputTokens: 120, outputTokens: 20 });
    expect(second).toMatchObject({ cacheHit: true, inputTokens: 0, outputTokens: 0 });
    expect(second.value).toEqual(first.value);
    expect(store.events.map((event) => event.cacheStatus)).toEqual(["miss", "hit"]);
  });

  it("invalidates cache keys when model, prompt version, scope, or input changes", async () => {
    const input = JSON.stringify({ answer: "Contoso" });
    const original = await aiCacheKey(context, input);

    await expect(aiCacheKey({ ...context, model: "smaller-model" }, input))
      .resolves.not.toBe(original);
    await expect(aiCacheKey({ ...context, promptVersion: "span-v2" }, input))
      .resolves.not.toBe(original);
    await expect(aiCacheKey({ ...context, projectId: "project-2" }, input))
      .resolves.not.toBe(original);
    await expect(aiCacheKey(context, JSON.stringify({ answer: "Acme" })))
      .resolves.not.toBe(original);
  });

  it("does not cache a response that fails current validation", async () => {
    const store = new MemoryAiUsageStore();
    const invoke = vi.fn(() => Promise.resolve({ response: { malformed: true } }));
    const parse = () => {
      throw new Error("invalid structured output");
    };

    await expect(runAI({
      context,
      input: { answer: "Contoso" },
      invoke,
      parse,
      store,
      logger: noLog,
    })).rejects.toThrow("invalid structured output");

    expect(store.cache.size).toBe(0);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ status: "failure", cacheStatus: "miss" });
  });

  it("keeps successful inference independent of telemetry persistence failures", async () => {
    const store = new MemoryAiUsageStore();
    store.recordUsage = vi.fn(() => Promise.reject(new Error("D1 unavailable")));

    await expect(runAI({
      context,
      input: { answer: "Contoso" },
      invoke: () => Promise.resolve({
        response: { entities: [] },
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
      parse: (result) => (result as { response: unknown }).response,
      store,
      logger: noLog,
    })).resolves.toMatchObject({ cacheHit: false, inputTokens: 10, outputTokens: 2 });
  });
});
