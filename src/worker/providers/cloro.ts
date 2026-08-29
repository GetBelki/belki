import type {
  CaptureExecutionRequest,
  CaptureProviderExecutionAdapter,
} from "./types";
import { boundedProviderBytes, jsonRecord } from "./types";

const ENDPOINTS: Record<CaptureExecutionRequest["source"], string> = {
  chatgpt: "chatgpt",
  gemini: "gemini",
  google_ai_mode: "aimode",
  google_ai_overview: "google",
};

export const cloroAdapter: CaptureProviderExecutionAdapter = {
  provider: "cloro",
  version: "cloro-v1",
  async execute(credentials, request) {
    if (credentials.provider !== "cloro") throw new Error("Cloro credentials are required");
    const google = request.source === "google_ai_overview";
    const response = await fetch(`https://api.cloro.dev/v1/monitor/${ENDPOINTS[request.source]}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.credentials.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        [google ? "query" : "prompt"]: request.query,
        ...(request.countryCode ? { country: request.countryCode } : {}),
        ...(google
          ? { include: { aioverview: true, markdown: true } }
          : { include: { markdown: true } }),
      }),
    });
    const bytes = await boundedProviderBytes("Cloro", response);
    const payload = jsonRecord(bytes);
    const task = typeof payload.task === "object" && payload.task !== null
      ? payload.task as Record<string, unknown>
      : null;
    return {
      externalTaskId: typeof task?.id === "string"
        ? `cloro:${task.id}`
        : `cloro:${request.jobId}`,
      bytes,
      requestCostUsd: null,
      providerStatusCode: response.status,
      providerStatusMessage: response.statusText || null,
    };
  },
};
