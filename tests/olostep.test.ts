import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureProviderAccountInputSchema, CaptureProviderCredentialInputSchema } from "../src/shared/contracts";
import { TRACKING_SOURCES } from "../src/shared/tracking-sources";
import { captureProviderSupportsSource } from "../src/shared/capture-providers";
import { olostepAdapter, OLOSTEP_ENGINES, pollOlostepBatch } from "../src/worker/providers/olostep";
import { parseCapturePayload } from "../src/worker/providers/normalize";
import { testCaptureProviderCredentials } from "../src/worker/providers/registry";

const credentials = { provider: "olostep", credentials: { apiKey: "test-key" } } as const;
const request = {
  jobId: "job-1", query: "best headphones & speakers?", source: "chatgpt" as const,
  locationCode: 2276, locationName: "Germany", countryCode: "DE", languageCode: "de", forceWebSearch: true,
};
const context = { ...request, taskId: "batch-1" };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.restoreAllMocks());

describe("Olostep", () => {
  it("accepts and verifies API-key credentials without creating a paid batch", async () => {
    expect(CaptureProviderCredentialInputSchema.parse(credentials)).toEqual(credentials);
    expect(CaptureProviderAccountInputSchema.parse({ ...credentials, label: "Olostep primary" })).toMatchObject(credentials);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ credits: 30 }));
    expect(await testCaptureProviderCredentials(credentials)).toMatchObject({ status: "passed" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.olostep.com/user/credits/info");
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer test-key" });
  });

  it("rejects invalid credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}, 401));
    expect(await testCaptureProviderCredentials(credentials)).toMatchObject({ status: "failed" });
  });

  it.each(TRACKING_SOURCES)("submits a geo-targeted asynchronous %s batch", async (source) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ id: "batch-1", status: "in_progress" }));
    expect(captureProviderSupportsSource("olostep", source)).toBe(true);
    expect(await olostepAdapter.execute(credentials, { ...request, source })).toMatchObject({
      pending: true, externalTaskId: "batch-1", requestCostUsd: null,
    });
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {
      parser: { id: string }; country: string; items: [{ custom_id: string; url: string }];
    };
    expect(body).toEqual({
      parser: { id: OLOSTEP_ENGINES[source].parser }, country: "DE",
      items: [{ custom_id: "job-1", url: body.items[0].url }],
    });
    expect(new URL(body.items[0].url).searchParams.get("q")).toBe(request.query);
    expect(body.items[0].url.split("?")[0]).toBe(OLOSTEP_ENGINES[source].url);
  });

  it("does not silently substitute a country for an unknown location", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(olostepAdapter.execute(credentials, { ...request, countryCode: null })).rejects.toThrow("country code");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an external ID before accepting a submission", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ status: "in_progress" }));
    await expect(olostepAdapter.execute(credentials, request)).rejects.toThrow("without returning an ID");
  });

  it("keeps in-progress batches pending without trying to retrieve results", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ status: "in_progress" }));
    expect(await pollOlostepBatch("test-key", "batch-1", "job-1", "chatgpt")).toEqual({ pending: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retrieves only the matching successful item and preserves the reported cost", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ status: "completed", credits_consumed: 5, cost_usd: 0.005 }))
      .mockResolvedValueOnce(response({ items: [{ custom_id: "job-1", retrieve_id: "ret /?1" }] }))
      .mockResolvedValueOnce(response({ json_content: JSON.stringify({ answer_markdown: "Answer" }) }));
    const result = await pollOlostepBatch("test-key", "batch/1", "job-1", "chatgpt");
    expect(result).toMatchObject({ pending: false, requestCostUsd: 0.005 });
    if (!result.pending) expect(JSON.parse(new TextDecoder().decode(result.bytes))).toEqual({ answer_markdown: "Answer" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.olostep.com/v1/batches/batch%2F1");
    const retrieve = new URL(fetch.mock.calls[2]?.[0] as string);
    expect(retrieve.searchParams.get("retrieve_id")).toBe("ret /?1");
    expect(retrieve.searchParams.get("formats")).toBe("json");
  });

  it.each([[], [{ custom_id: "another-job", retrieve_id: "wrong" }], [{ custom_id: "job-1" }]])(
    "fails terminal batches without this run's successful item (%j)", async (...items) => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(response({ status: "completed" }))
        .mockResolvedValueOnce(response({ items }));
      await expect(pollOlostepBatch("test-key", "batch-1", "job-1", "chatgpt")).rejects.toMatchObject({ retryable: false });
    },
  );

  it.each(["{bad", JSON.stringify({}), JSON.stringify({ answer_markdown: "" })])(
    "rejects malformed or missing answers (%s)", async (json_content) => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(response({ status: "completed" }))
        .mockResolvedValueOnce(response({ items: [{ custom_id: "job-1", retrieve_id: "ret-1" }] }))
        .mockResolvedValueOnce(response({ json_content }));
      await expect(pollOlostepBatch("test-key", "batch-1", "job-1", "chatgpt")).rejects.toMatchObject({ retryable: false });
    },
  );

  it.each([401, 402, 429, 500])("classifies HTTP %s for polling retries", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}, status));
    await expect(pollOlostepBatch("test-key", "batch-1", "job-1", "chatgpt")).rejects.toMatchObject({
      statusCode: status, retryable: status === 429 || status >= 500,
    });
  });

  it.each(TRACKING_SOURCES)("normalizes %s answers and source field variants", (source) => {
    const result = parseCapturePayload("olostep", {
      answer_markdown: "**Answer**", model: source,
      inline_references: [{ url: "https://one.example/", text: "Inline reference", position: 1 }],
      sources: [{ url: "https://one.example/", title: "Duplicate" }, { url: "https://two.example/", label: "Source", position: 1124 }],
      search_model_queries: [{ query: "expanded prompt", engine: "web" }],
    }, source, context).tasks[0]?.result?.[0];
    expect(result).toMatchObject({ markdown: "**Answer**", surface_present: true, model: null });
    expect(result?.sources).toHaveLength(2);
    expect(result?.sources[0]?.title).toBe("Inline reference");
    expect(result?.sources[1]).not.toHaveProperty("rank_absolute");
    expect(result?.fan_out_queries).toEqual([{ query: "expanded prompt", engine: "web" }]);
  });

  it("separates uncited retrieved sources and maps ChatGPT commercial modules", () => {
    const result = parseCapturePayload("olostep", {
      answer_markdown: "Answer",
      sources: [
        { url: "https://cited.example/", cited: true },
        { url: "https://retrieved.example/", cited: false },
      ],
      network_search_calls: { search_queries: [{ query: "headphones", type: "model_query" }] },
      ads: [{ brand: { name: "Brand", url: "https://brand.example/" }, cards: [{ title: "Headphones", body: "Ad copy", url: "https://brand.example/product", image: "https://brand.example/image.png" }] }],
      products: [{ title: "Product", price: 139.99, currency: "$", vendors: [{ website: "Shop", link: "https://shop.example/product" }] }],
    }, "chatgpt", context).tasks[0]?.result?.[0];
    expect(result?.sources.map((source) => source.url)).toEqual(["https://cited.example/"]);
    expect(result?.search_results.map((source) => source.url)).toEqual(["https://retrieved.example/"]);
    expect(result?.fan_out_queries).toEqual([{ query: "headphones", type: "model_query" }]);
    expect(result?.items[0]).toMatchObject({ type: "chat_gpt_ad", snippet: "Ad copy", advertiser: { name: "Brand" } });
    expect(result?.items[1]?.items[0]).toMatchObject({ title: "Product", price: 139.99, merchants: "Shop", url: "https://shop.example/product" });
  });

  it("records an explicitly absent AI Overview", () => {
    const result = parseCapturePayload("olostep", { answer_markdown: "" }, "google_ai_overview", context).tasks[0]?.result?.[0];
    expect(result).toMatchObject({ surface_present: false, markdown: null });
    expect(() => parseCapturePayload("olostep", {}, "google_ai_overview", context)).toThrow("without parsed answer");
  });
});
