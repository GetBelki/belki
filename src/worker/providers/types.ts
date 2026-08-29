import type {
  CaptureProvider,
  CaptureProviderCredentialInput,
  TrackingSource,
} from "../../shared/contracts";

export interface CaptureExecutionRequest {
  jobId: string;
  query: string;
  source: TrackingSource;
  locationCode: number;
  locationName: string;
  countryCode: string | null;
  languageCode: string;
  forceWebSearch: boolean;
}

export interface CaptureExecutionResult {
  externalTaskId: string;
  bytes: ArrayBuffer;
  requestCostUsd: number | null;
  providerStatusCode: number | null;
  providerStatusMessage: string | null;
}

export interface CaptureProviderExecutionAdapter {
  provider: CaptureProvider;
  version: string;
  execute(
    credentials: CaptureProviderCredentialInput,
    request: CaptureExecutionRequest,
  ): Promise<CaptureExecutionResult>;
}

export async function boundedProviderBytes(
  providerLabel: string,
  response: Response,
): Promise<ArrayBuffer> {
  if (!response.ok) {
    throw new Error(`${providerLabel} returned HTTP ${response.status}`);
  }
  const maximum = 20 * 1024 * 1024;
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maximum) {
    throw new Error(`${providerLabel} response exceeds ${maximum} bytes`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximum) {
    throw new Error(`${providerLabel} response exceeds ${maximum} bytes`);
  }
  return bytes;
}

export function jsonRecord(bytes: ArrayBuffer): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider returned an unexpected response shape");
  }
  return value as Record<string, unknown>;
}
