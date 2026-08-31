import type { CaptureProviderExecutionAdapter } from "./types";
import { boundedProviderBytes } from "./types";

const CHATGPT_DATASET_ID = "gd_m7aof0k82r803d5bjm";

type BrightDataProgress = "starting" | "running" | "ready" | "failed";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function brightDataSnapshotId(bytes: ArrayBuffer): string | null {
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const root = record(payload);
    const id = root?.snapshot_id ?? root?.snapshotId;
    return typeof id === "string" && id.trim().length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function brightDataProgressStatus(payload: unknown): BrightDataProgress | null {
  const root = record(payload);
  const status = root?.status;
  return status === "starting" || status === "running" ||
      status === "ready" || status === "failed"
    ? status
    : null;
}

function authorization(apiToken: string): HeadersInit {
  return {
    authorization: `Bearer ${apiToken}`,
    accept: "application/json",
  };
}

export async function getBrightDataSnapshotProgress(
  apiToken: string,
  snapshotId: string,
): Promise<BrightDataProgress> {
  const response = await fetch(
    `https://api.brightdata.com/datasets/v3/progress/${encodeURIComponent(snapshotId)}`,
    { headers: authorization(apiToken) },
  );
  const bytes = await boundedProviderBytes("Bright Data progress", response);
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const status = brightDataProgressStatus(payload);
  if (!status) throw new Error("Bright Data returned an unknown snapshot status");
  return status;
}

export async function downloadBrightDataSnapshot(
  apiToken: string,
  snapshotId: string,
): Promise<ArrayBuffer> {
  const response = await fetch(
    `https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`,
    { headers: authorization(apiToken) },
  );
  return boundedProviderBytes("Bright Data snapshot", response);
}

export const brightDataAdapter: CaptureProviderExecutionAdapter = {
  provider: "brightdata",
  version: "brightdata-v1",
  async execute(credentials, request) {
    if (credentials.provider !== "brightdata") {
      throw new Error("Bright Data credentials are required");
    }
    if (request.source !== "chatgpt") {
      throw new Error(`Bright Data does not support ${request.source} in this adapter version`);
    }
    const response = await fetch(
      `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${CHATGPT_DATASET_ID}&format=json`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.credentials.apiToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify([{
          url: "https://chatgpt.com/",
          prompt: request.query,
          web_search: request.forceWebSearch,
        }]),
      },
    );
    const bytes = await boundedProviderBytes("Bright Data", response);
    const snapshotId = brightDataSnapshotId(bytes);
    const pending = response.status === 202 || snapshotId !== null;
    if (pending && !snapshotId) {
      throw new Error("Bright Data accepted the scrape without returning a snapshot ID");
    }
    return {
      externalTaskId: snapshotId ?? `brightdata:${request.jobId}`,
      bytes,
      pending,
      requestCostUsd: null,
      providerStatusCode: response.status,
      providerStatusMessage: response.statusText || null,
    };
  },
};
