import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobQueueMessage } from "../src/shared/contracts";
import { dispatchLiveBatch, dispatchStandardBatch } from "../src/worker/ingestion/dispatch";

vi.mock("../src/worker/providers/accounts", () => ({
  loadCaptureProviderCredential: () => Promise.resolve({ provider: "olostep", credentials: { apiKey: "test-key" } }),
}));
vi.mock("../src/worker/lib/tracking-sources", () => ({
  availableSources: () => Promise.resolve(["chatgpt", "perplexity", "copilot"]),
}));
vi.mock("../src/worker/automation/alerts", () => ({ emitRunFailureAlerts: vi.fn() }));

afterEach(() => vi.restoreAllMocks());
const response = (value: unknown) => new Response(JSON.stringify(value));

function fixture(status: "queued" | "awaiting_result", delivery: "standard" | "live") {
  const job = {
    id: "job-1", query_text: "Question", location_code: 2840, language_code: "en", force_web_search: 1,
    provider_tag: "tag", capture_html: 0, delivery_method: delivery, public_base_url: "https://example.com",
    workspace_id: "w", project_id: "p", usage_reservation_id: null, usage_units: 0, tracking_source: "perplexity",
    provider_account_id: "account-1", capture_provider: "olostep", capture_provider_attempt_id: "attempt-1",
    capture_adapter_version: "olostep-v1", submit_attempts: 0, credential_version: 1, status,
    dataforseo_task_id: status === "queued" ? null : "batch-1", submitted_at: new Date().toISOString(),
    paused_at: null, location_name: "United States", location_payload_json: null,
  };
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const send = vi.fn().mockResolvedValue(undefined);
  const normalize = vi.fn().mockResolvedValue(undefined);
  const put = vi.fn().mockResolvedValue(undefined);
  const db = {
    prepare(sql: string) {
      const query = { sql, bindings: [] as unknown[] };
      statements.push(query);
      const statement = {
        bind(...bindings: unknown[]) { query.bindings = bindings; return statement; },
        all: () => Promise.resolve({ results: [job] }),
        run: () => Promise.resolve({ meta: { changes: 1 } }),
      };
      return statement;
    },
    batch: (queries: Array<{ run: () => Promise<unknown> }>) => Promise.all(queries.map((query) => query.run())),
  };
  const env = {
    CONTROL_DB: db, EVIDENCE_BUCKET: { put },
    STANDARD_QUEUE: { send }, LIVE_QUEUE: { send }, NORMALIZE_QUEUE: { send: normalize },
  } as unknown as Env;
  const batch = { messages: [{ body: { jobId: "job-1" }, ack: vi.fn() }] } as unknown as MessageBatch<JobQueueMessage>;
  const dispatch = () => delivery === "live" ? dispatchLiveBatch(env, batch) : dispatchStandardBatch(env, batch);
  return { dispatch, job, statements, send, normalize, put };
}

describe.each(["standard", "live"] as const)("Olostep %s queue lifecycle", (delivery) => {
  it("persists accepted batch IDs and schedules polling before normalization", async () => {
    const test = fixture("queued", delivery);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ id: "batch-1", status: "in_progress" }));
    await test.dispatch();
    const update = test.statements.find(({ sql }) => sql.includes("UPDATE crawl_jobs SET status = 'awaiting_result'"));
    expect(update?.bindings[0]).toBe("batch-1");
    expect(test.send).toHaveBeenCalledWith({ jobId: "job-1" }, { delaySeconds: 30 });
    expect(test.normalize).not.toHaveBeenCalled();
  });

  it("polls accepted runs without submitting another batch", async () => {
    const test = fixture("awaiting_result", delivery);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ status: "in_progress" }));
    await test.dispatch();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.olostep.com/v1/batches/batch-1");
    expect(test.send).toHaveBeenCalledWith({ jobId: "job-1" }, { delaySeconds: 30 });
    expect(test.put).not.toHaveBeenCalled();
    expect(test.normalize).not.toHaveBeenCalled();
  });

  it("stores retrieved evidence and queues normalization with the original batch ID", async () => {
    const test = fixture("awaiting_result", delivery);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ status: "completed", cost_usd: 0.003 }))
      .mockResolvedValueOnce(response({ items: [{ custom_id: "job-1", retrieve_id: "ret-1" }] }))
      .mockResolvedValueOnce(response({ json_content: JSON.stringify({ answer_markdown: "Answer" }) }));
    await test.dispatch();
    expect(test.put).toHaveBeenCalledTimes(1);
    const update = test.statements.find(({ sql }) => sql.includes("UPDATE crawl_jobs SET status = 'normalizing'"));
    expect(update?.bindings[1]).toBe(0.003);
    expect(test.normalize).toHaveBeenCalledWith({
      jobId: "job-1", taskId: "batch-1", rawR2Key: update?.bindings[0], contentEncoding: "identity",
    });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("marks a completed batch with no successful item as failed without normalizing", async () => {
    const test = fixture("awaiting_result", delivery);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ status: "completed" }))
      .mockResolvedValueOnce(response({ items: [] }));
    await test.dispatch();
    expect(test.statements.some(({ sql }) => sql.includes("UPDATE crawl_jobs SET status = 'failed'") && sql.includes("provider_result_failed"))).toBe(true);
    expect(test.send).not.toHaveBeenCalled();
    expect(test.normalize).not.toHaveBeenCalled();
  });

  it("stops polling after the result deadline", async () => {
    const test = fixture("awaiting_result", delivery);
    test.job.submitted_at = new Date(Date.now() - 31 * 60_000).toISOString();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ status: "in_progress" }));
    await test.dispatch();
    expect(test.statements.some(({ sql }) => sql.includes("UPDATE crawl_jobs SET status = 'failed'"))).toBe(true);
    expect(test.send).not.toHaveBeenCalled();
  });
});
