import type { CaptureProviderExecutionAdapter } from "./types";
import { boundedProviderBytes, jsonRecord } from "./types";

function authorization(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export const oxylabsAdapter: CaptureProviderExecutionAdapter = {
  provider: "oxylabs",
  version: "oxylabs-v1",
  async execute(credentials, request) {
    if (credentials.provider !== "oxylabs") throw new Error("Oxylabs credentials are required");
    if (request.source === "gemini") {
      throw new Error("Oxylabs does not support Gemini in this adapter version");
    }
    const chatgpt = request.source === "chatgpt";
    const aiMode = request.source === "google_ai_mode";
    const body = chatgpt
      ? {
          source: "chatgpt",
          prompt: request.query,
          parse: true,
          search: request.forceWebSearch,
          geo_location: request.locationName,
        }
      : {
          source: aiMode ? "google_ai_mode" : "google_search",
          query: request.query,
          parse: true,
          ...(aiMode ? { render: "html" } : {}),
          geo_location: request.locationName,
        };
    const response = await fetch("https://realtime.oxylabs.io/v1/queries", {
      method: "POST",
      headers: {
        authorization: authorization(
          credentials.credentials.username,
          credentials.credentials.password,
        ),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const bytes = await boundedProviderBytes("Oxylabs", response);
    const payload = jsonRecord(bytes);
    const job = typeof payload.job === "object" && payload.job !== null
      ? payload.job as Record<string, unknown>
      : null;
    return {
      externalTaskId: typeof job?.id === "string" || typeof job?.id === "number"
        ? `oxylabs:${String(job.id)}`
        : `oxylabs:${request.jobId}`,
      bytes,
      requestCostUsd: null,
      providerStatusCode: response.status,
      providerStatusMessage: response.statusText || null,
    };
  },
};
