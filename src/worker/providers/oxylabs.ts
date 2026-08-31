import type { TrackingSource } from "../../shared/contracts";
import type { CaptureProviderExecutionAdapter } from "./types";
import {
  boundedProviderBytes,
  CaptureProviderExecutionError,
  jsonRecord,
} from "./types";

const RETRYABLE_STATUS_CODES = new Set([500, 524, 612, 613]);
const FAILED_PARSER_STATUS_CODES = new Set([
  12002,
  12003,
  12006,
  12007,
  12008,
  12009,
]);

const STATUS_MESSAGES: Record<number, string> = {
  500: "Internal server error",
  524: "Timeout",
  612: "Undefined internal error",
  613: "Faulted after too many retries",
  12000: "Success",
  12002: "Parser failure",
  12003: "Parser not supported",
  12004: "Partial success",
  12005: "Partial success",
  12006: "Unexpected parser error",
  12007: "Unknown parser result",
  12008: "Parsed content is missing",
  12009: "Result not found",
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resultCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function externalTaskId(job: Record<string, unknown> | null): string | null {
  return typeof job?.id === "string" || typeof job?.id === "number"
    ? `oxylabs:${String(job.id)}`
    : null;
}

export interface OxylabsResponseMetadata {
  externalTaskId: string | null;
  statusCode: number | null;
  statusMessage: string | null;
}

export function validateOxylabsPayload(
  payload: unknown,
  source: TrackingSource,
): OxylabsResponseMetadata {
  const root = record(payload);
  if (!root) {
    throw new CaptureProviderExecutionError(
      "Oxylabs returned an unexpected response shape.",
    );
  }
  const job = record(root.job);
  const jobStatus = nonEmptyText(job?.status)?.toLowerCase() ?? null;
  const firstResult = Array.isArray(root.results) ? record(root.results[0]) : null;
  const statusCode = resultCode(firstResult?.status_code);
  const statusMessage = statusCode === null
    ? jobStatus
    : STATUS_MESSAGES[statusCode] ?? jobStatus;
  const taskId = externalTaskId(job);

  if (jobStatus === "faulted") {
    throw new CaptureProviderExecutionError(
      `Oxylabs job faulted${statusCode === null ? "" : ` with status ${statusCode}`}${statusMessage ? ` (${statusMessage})` : ""}.`,
      {
        statusCode,
        statusMessage,
        externalTaskId: taskId,
        retryable: statusCode !== null && RETRYABLE_STATUS_CODES.has(statusCode),
      },
    );
  }
  if (jobStatus !== "done") {
    throw new CaptureProviderExecutionError(
      `Oxylabs returned a non-terminal job status${jobStatus ? ` (${jobStatus})` : ""}.`,
      { statusCode, statusMessage, externalTaskId: taskId },
    );
  }
  if (!firstResult) {
    throw new CaptureProviderExecutionError(
      "Oxylabs completed the job without a result.",
      { statusCode: 12008, statusMessage: STATUS_MESSAGES[12008], externalTaskId: taskId },
    );
  }
  if (
    statusCode !== null &&
    (RETRYABLE_STATUS_CODES.has(statusCode) || FAILED_PARSER_STATUS_CODES.has(statusCode))
  ) {
    throw new CaptureProviderExecutionError(
      `Oxylabs result failed with status ${statusCode}${statusMessage ? ` (${statusMessage})` : ""}.`,
      {
        statusCode,
        statusMessage,
        externalTaskId: taskId,
        retryable: RETRYABLE_STATUS_CODES.has(statusCode),
      },
    );
  }
  if (source === "chatgpt") {
    const content = record(firstResult.content);
    const answer = nonEmptyText(content?.response_text) ??
      nonEmptyText(content?.response_text_markdown);
    if (!answer) {
      throw new CaptureProviderExecutionError(
        "Oxylabs completed the ChatGPT job without parsed answer content.",
        {
          statusCode: statusCode ?? 12008,
          statusMessage: statusMessage ?? STATUS_MESSAGES[12008],
          externalTaskId: taskId,
        },
      );
    }
  }
  return { externalTaskId: taskId, statusCode, statusMessage };
}

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
    let bytes: ArrayBuffer;
    try {
      bytes = await boundedProviderBytes("Oxylabs", response);
    } catch (error) {
      throw new CaptureProviderExecutionError(String(error), {
        statusCode: response.status,
        statusMessage: response.statusText || null,
        retryable: RETRYABLE_STATUS_CODES.has(response.status),
      });
    }
    const payload = jsonRecord(bytes);
    const metadata = validateOxylabsPayload(payload, request.source);
    return {
      externalTaskId: metadata.externalTaskId ?? `oxylabs:${request.jobId}`,
      bytes,
      requestCostUsd: null,
      providerStatusCode: metadata.statusCode ?? response.status,
      providerStatusMessage: metadata.statusMessage ?? (response.statusText || null),
    };
  },
};
