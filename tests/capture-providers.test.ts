import { describe, expect, it } from "vitest";
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

const context = {
  taskId: "task-1",
  query: "best running shoes",
  locationCode: 2840,
  languageCode: "en",
};

describe("capture providers", () => {
  it("preserves the operator's provider priority", () => {
    expect(Object.entries(CAPTURE_PROVIDER_PRIORITY)
      .sort(([, left], [, right]) => left - right)
      .map(([provider]) => provider)).toEqual([
      "dataforseo",
      "brightdata",
      "cloro",
      "oxylabs",
    ]);
  });

  it("only routes platforms supported by the current adapter", () => {
    expect(captureProviderSupportsSource("brightdata", "chatgpt")).toBe(true);
    expect(captureProviderSupportsSource("brightdata", "gemini")).toBe(false);
    expect(captureProviderSupportsSource("cloro", "gemini")).toBe(true);
    expect(captureProviderSupportsSource("oxylabs", "gemini")).toBe(false);
  });

  it("links each provider to its own account dashboard", () => {
    expect(CAPTURE_PROVIDER_DASHBOARD_URLS).toEqual({
      dataforseo: "https://app.dataforseo.com/",
      brightdata: "https://brightdata.com/cp/",
      cloro: "https://dashboard.cloro.dev/",
      oxylabs: "https://dashboard.oxylabs.io/",
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
      results: [{
        created_at: "2026-08-28T10:00:00.000Z",
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
});
