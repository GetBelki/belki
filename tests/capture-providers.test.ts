import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_PROVIDER_DASHBOARD_URLS,
  CAPTURE_PROVIDER_PRIORITY,
  captureProviderSupportsSource,
} from "../src/shared/capture-providers";
import {
  summarizeCaptureProviderActivity,
  type CaptureProviderActivityRow,
} from "../src/shared/provider-activity";
import { parseCapturePayload } from "../src/worker/providers/normalize";
import {
  brightDataProgressStatus,
  brightDataAdapter,
  brightDataSnapshotId,
} from "../src/worker/providers/brightdata";
import { oxylabsAdapter } from "../src/worker/providers/oxylabs";
import { CaptureProviderExecutionError } from "../src/worker/providers/types";

const context = {
  taskId: "task-1",
  query: "best running shoes",
  locationCode: 2840,
  languageCode: "en",
};

afterEach(() => vi.restoreAllMocks());

describe("capture providers", () => {
  it("preserves the operator's provider priority", () => {
    expect(Object.entries(CAPTURE_PROVIDER_PRIORITY)
      .sort(([, left], [, right]) => left - right)
      .map(([provider]) => provider)).toEqual([
      "dataforseo",
      "brightdata",
      "cloro",
      "oxylabs",
      "olostep",
    ]);
  });

  it("only routes platforms supported by the current adapter", () => {
    expect(captureProviderSupportsSource("brightdata", "chatgpt")).toBe(true);
    expect(captureProviderSupportsSource("brightdata", "gemini")).toBe(false);
    expect(captureProviderSupportsSource("cloro", "gemini")).toBe(true);
    expect(captureProviderSupportsSource("oxylabs", "gemini")).toBe(false);
  });

  it("recognizes Bright Data's asynchronous snapshot lifecycle", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ snapshot_id: "snapshot-123" }));
    expect(brightDataSnapshotId(bytes.buffer)).toBe("snapshot-123");
    expect(brightDataProgressStatus({ status: "running" })).toBe("running");
    expect(brightDataProgressStatus({ status: "ready" })).toBe("ready");
    expect(brightDataProgressStatus({ status: "unexpected" })).toBeNull();
  });

  it("keeps HTTP 202 Bright Data scrapes pending instead of normalizing them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ snapshot_id: "snapshot-accepted" }),
      { status: 202, statusText: "Accepted" },
    ));

    const result = await brightDataAdapter.execute(
      { provider: "brightdata", credentials: { apiToken: "test-token" } },
      {
        jobId: "job-1",
        query: "test query",
        source: "chatgpt",
        locationCode: 2840,
        locationName: "United States",
        countryCode: "US",
        languageCode: "en",
        forceWebSearch: true,
      },
    );

    expect(result).toMatchObject({
      externalTaskId: "snapshot-accepted",
      pending: true,
      providerStatusCode: 202,
    });
  });

  it("links each provider to its own account dashboard", () => {
    expect(CAPTURE_PROVIDER_DASHBOARD_URLS).toEqual({
      dataforseo: "https://app.dataforseo.com/",
      brightdata: "https://brightdata.com/cp/",
      cloro: "https://dashboard.cloro.dev/",
      oxylabs: "https://dashboard.oxylabs.io/",
      olostep: "https://www.olostep.com/auth/",
    });
  });

  it("reports provider work without depending on provider cost fields", () => {
    const rows: CaptureProviderActivityRow[] = [
      {
        provider_account_id: "dfs-1",
        provider: "dataforseo",
        tracking_source: "chatgpt",
        attempts: 4,
        submitted: 4,
        completed: 3,
        failed: 1,
        ambiguous: 0,
        in_progress: 0,
        latency_samples: 3,
        latency_total_ms: 9_000,
        last_activity_at: "2026-08-28T10:00:00.000Z",
      },
      {
        provider_account_id: "cloro-1",
        provider: "cloro",
        tracking_source: "gemini",
        attempts: 3,
        submitted: 2,
        completed: 1,
        failed: 0,
        ambiguous: 1,
        in_progress: 1,
        latency_samples: 1,
        latency_total_ms: 6_000,
        last_activity_at: "2026-08-28T11:00:00.000Z",
      },
    ];
    const report = summarizeCaptureProviderActivity(rows, {
      from: "2026-07-30T00:00:00.000Z",
      to: "2026-08-28T23:59:59.999Z",
    });

    expect(report.summary).toMatchObject({
      attempts: 7,
      submitted: 6,
      completed: 4,
      failed: 1,
      ambiguous: 1,
      needsAttention: 2,
      inProgress: 1,
      successRate: 66.7,
      averageLatencyMs: 3_750,
      lastActivityAt: "2026-08-28T11:00:00.000Z",
    });
    expect(report.byPlatform.find((item) => item.trackingSource === "gemini"))
      .toMatchObject({ completed: 1, needsAttention: 1, inProgress: 1 });
  });

  it("normalizes Bright Data answers and citations", () => {
    const payload = parseCapturePayload("brightdata", [{
      answer_text: "A grounded answer",
      model: "gpt-test",
      prompt_sent_at: "2026-08-28T10:00:00.000Z",
      citations: [{ title: "Example", url: "https://example.com/article" }],
      search_sources: [{ title: "Retrieved", url: "https://search.example/page" }],
    }], "chatgpt", context);

    expect(payload.tasks[0]?.result?.[0]).toMatchObject({
      keyword: context.query,
      markdown: "A grounded answer",
      model: "gpt-test",
    });
    expect(payload.tasks[0]?.result?.[0]?.sources).toHaveLength(2);
  });

  it("normalizes the answer field names returned by the ChatGPT dataset", () => {
    const payload = parseCapturePayload("brightdata", [{
      answer_text_markdown: "**Markdown answer from Bright Data**",
      answer_text_raw: "Raw answer from Bright Data",
      citations: [{ title: "Example", url: "https://example.com/article" }],
    }], "chatgpt", context);

    expect(payload.tasks[0]?.result?.[0]).toMatchObject({
      markdown: "**Markdown answer from Bright Data**",
      model: null,
      surface_present: true,
    });
  });

  it("normalizes Cloro fan-out telemetry", () => {
    const payload = parseCapturePayload("cloro", {
      success: true,
      result: {
        text: "Answer",
        sources: [{ label: "Example", url: "https://example.com" }],
        searchQueries: ["first expansion", "second expansion"],
      },
    }, "chatgpt", context);

    expect(payload.tasks[0]?.result?.[0]?.fan_out_queries).toEqual([
      "first expansion",
      "second expansion",
    ]);
  });

  it("normalizes Oxylabs response metadata", () => {
    const payload = parseCapturePayload("oxylabs", {
      job: { id: "7499869041700391937", status: "done" },
      results: [{
        created_at: "2026-08-28T10:00:00.000Z",
        status_code: 12000,
        content: {
          response_text: "Oxylabs answer",
          llm_model: "gpt-5",
          citations: [{ text: "Example", url: "https://example.com" }],
        },
      }],
    }, "chatgpt", context);

    expect(payload.tasks[0]?.result?.[0]).toMatchObject({
      markdown: "Oxylabs answer",
      model: "gpt-5",
    });
  });

  it("rejects a faulted Oxylabs realtime response instead of storing an empty snapshot", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      job: { id: "7499954392326526977", status: "faulted" },
      results: [{ status_code: 613, content: [] }],
    }), { status: 200, statusText: "OK" }));

    const execution = oxylabsAdapter.execute(
      {
        provider: "oxylabs",
        credentials: { username: "test-user", password: "test-password" },
      },
      {
        jobId: "job-1",
        query: "Why choose Rebill?",
        source: "chatgpt",
        locationCode: 2840,
        locationName: "United States",
        countryCode: "US",
        languageCode: "en",
        forceWebSearch: true,
      },
    );

    await expect(execution).rejects.toMatchObject({
      name: "CaptureProviderExecutionError",
      statusCode: 613,
      statusMessage: "Faulted after too many retries",
      externalTaskId: "oxylabs:7499954392326526977",
      retryable: true,
    } satisfies Partial<CaptureProviderExecutionError>);
  });

  it("defensively rejects faulted Oxylabs payloads during normalization", () => {
    expect(() => parseCapturePayload("oxylabs", {
      job: { id: "7499954392326526977", status: "faulted" },
      results: [{ status_code: 613, content: [] }],
    }, "chatgpt", context)).toThrow("Oxylabs job faulted with status 613");
  });
});
