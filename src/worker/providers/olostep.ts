import type { TrackingSource } from "../../shared/contracts";
import { resolveProviderCost } from "../../shared/provider-cost";
import type { CaptureProviderExecutionAdapter } from "./types";
import { boundedProviderBytes, CaptureProviderExecutionError, jsonRecord } from "./types";

const API_ORIGIN = "https://api.olostep.com";

// https://docs.olostep.com/examples/geo — one parser per batch.
export const OLOSTEP_ENGINES: Record<TrackingSource, { parser: string; url: string }> = {
  chatgpt: { parser: "@olostep/chatgpt-results", url: "https://chatgpt.com/" },
  gemini: { parser: "@olostep/gemini-results", url: "https://gemini.google.com/" },
  google_ai_mode: { parser: "@olostep/google-aimode-results", url: "https://www.google.com/aimode" },
  google_ai_overview: { parser: "@olostep/google-ai-overview-results", url: "https://www.google.com/search" },
  perplexity: { parser: "@olostep/perplexity-results", url: "https://www.perplexity.ai/" },
  copilot: { parser: "@olostep/microsoft-copilot-results", url: "https://copilot.microsoft.com/chats" },
};

async function requestJson(apiKey: string, path: string, init?: RequestInit) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "content-type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CaptureProviderExecutionError(`Olostep returned HTTP ${response.status}`, {
      statusCode: response.status,
      statusMessage: response.statusText || null,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  const bytes = await boundedProviderBytes("Olostep", response);
  return { bytes, payload: jsonRecord(bytes), status: response.status };
}

export function validateOlostepPayload(payload: unknown, source: TrackingSource): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CaptureProviderExecutionError("Olostep returned invalid parsed content.");
  }
  const result = payload as Record<string, unknown>;
  // An explicitly empty AI Overview is a valid observation of an absent surface.
  if (typeof result.answer_markdown !== "string" ||
    (source !== "google_ai_overview" && !result.answer_markdown.trim())) {
    throw new CaptureProviderExecutionError("Olostep completed without parsed answer content.");
  }
}

export async function pollOlostepBatch(
  apiKey: string,
  batchId: string,
  jobId: string,
  source: TrackingSource,
): Promise<{ pending: true } | { pending: false; bytes: ArrayBuffer; requestCostUsd: number | null }> {
  const batchPath = `/v1/batches/${encodeURIComponent(batchId)}`;
  const { payload: batch } = await requestJson(apiKey, batchPath);
  if (batch.status === "in_progress") return { pending: true };
  if (batch.status !== "completed") {
    throw new CaptureProviderExecutionError("Olostep returned an unexpected batch status.");
  }
  const { payload: list } = await requestJson(apiKey, `${batchPath}/items?status=completed&limit=10`);
  // Each Belki run creates one batch item, so no pagination is needed. Never
  // associate another run's result by array position alone.
  const item = Array.isArray(list.items)
    ? list.items.find((value: unknown) => typeof value === "object" && value !== null &&
      "custom_id" in value && value.custom_id === jobId) as Record<string, unknown> | undefined
    : undefined;
  if (typeof item?.retrieve_id !== "string" || !item.retrieve_id) {
    throw new CaptureProviderExecutionError("Olostep batch completed without a successful result for this run.");
  }
  const params = new URLSearchParams({ retrieve_id: item.retrieve_id, formats: "json" });
  const { payload: retrieved } = await requestJson(apiKey, `/v1/retrieve?${params.toString()}`);
  let content: unknown;
  try {
    content = typeof retrieved.json_content === "string" ? JSON.parse(retrieved.json_content) : null;
  } catch {
    throw new CaptureProviderExecutionError("Olostep returned malformed json_content.");
  }
  validateOlostepPayload(content, source);
  return {
    pending: false,
    bytes: new Uint8Array(new TextEncoder().encode(JSON.stringify(content))).buffer,
    requestCostUsd: resolveProviderCost(typeof batch.cost_usd === "number" ? batch.cost_usd : null),
  };
}

export const olostepAdapter: CaptureProviderExecutionAdapter = {
  provider: "olostep",
  version: "olostep-v1",
  async execute(credentials, request) {
    if (credentials.provider !== "olostep") throw new Error("Olostep credentials are required");
    if (!request.countryCode || !/^[A-Z]{2}$/.test(request.countryCode)) {
      throw new CaptureProviderExecutionError("Olostep requires a location with a known two-letter country code.");
    }
    const engine = OLOSTEP_ENGINES[request.source];
    const url = new URL(engine.url);
    url.searchParams.set("q", request.query);
    const { bytes, payload, status } = await requestJson(credentials.credentials.apiKey, "/v1/batches", {
      method: "POST",
      body: JSON.stringify({
        parser: { id: engine.parser },
        country: request.countryCode,
        items: [{ custom_id: request.jobId, url: url.toString() }],
      }),
    });
    if (typeof payload.id !== "string" || !payload.id.trim()) {
      throw new CaptureProviderExecutionError("Olostep accepted the batch without returning an ID.");
    }
    return {
      externalTaskId: payload.id,
      bytes,
      pending: true,
      requestCostUsd: null,
      providerStatusCode: status,
      providerStatusMessage: typeof payload.status === "string" ? payload.status : "Accepted",
    };
  },
};
