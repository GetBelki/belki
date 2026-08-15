import { z } from "zod";
import type { DataForSeoCredentials } from "./provider-credentials";

const API_BASE = "https://api.dataforseo.com/v3/merchant/google/product_info";
const MAX_PROVIDER_BODY_BYTES = 20 * 1024 * 1024;

const TaskSchema = z.object({
  id: z.string().optional(),
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  cost: z.number().nullable().optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  result: z.array(z.unknown()).nullable().optional(),
}).passthrough();

const MerchantResponseSchema = z.object({
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  tasks: z.array(TaskSchema).default([]),
}).passthrough();

export type MerchantResponse = z.infer<typeof MerchantResponseSchema>;

export interface ProductInfoTaskInput {
  product_id?: string;
  data_docid?: string;
  gid?: string;
  location_code: number;
  language_code: string;
  priority: 1 | 2;
  tag: string;
  postback_url: string;
  postback_data: "advanced";
}

function authorization(credentials: DataForSeoCredentials): string {
  return `Basic ${btoa(`${credentials.login}:${credentials.password}`)}`;
}

async function readBounded(response: Response): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_PROVIDER_BODY_BYTES) {
    throw new Error(`Provider response exceeds ${MAX_PROVIDER_BODY_BYTES} bytes`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PROVIDER_BODY_BYTES) {
    throw new Error(`Provider response exceeds ${MAX_PROVIDER_BODY_BYTES} bytes`);
  }
  return bytes;
}

export async function postProductInfoTask(
  credentials: DataForSeoCredentials,
  task: ProductInfoTaskInput,
): Promise<MerchantResponse> {
  const response = await fetch(`${API_BASE}/task_post`, {
    method: "POST",
    headers: {
      authorization: authorization(credentials),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify([task]),
  });
  if (!response.ok) throw new Error(`DataForSEO product_info task_post returned HTTP ${response.status}`);
  return MerchantResponseSchema.parse(
    JSON.parse(new TextDecoder().decode(await readBounded(response))),
  );
}

export async function getProductInfoTasksReady(credentials: DataForSeoCredentials): Promise<Array<{
  id: string;
  tag: string | null;
  endpointAdvanced: string | null;
}>> {
  const response = await fetch(`${API_BASE}/tasks_ready`, {
    headers: { authorization: authorization(credentials), accept: "application/json" },
  });
  if (!response.ok) throw new Error(`DataForSEO product_info tasks_ready returned HTTP ${response.status}`);
  const payload = MerchantResponseSchema.parse(
    JSON.parse(new TextDecoder().decode(await readBounded(response))),
  );
  const ready: Array<{ id: string; tag: string | null; endpointAdvanced: string | null }> = [];
  for (const task of payload.tasks) {
    for (const raw of task.result ?? []) {
      if (typeof raw !== "object" || raw === null) continue;
      const result = raw as Record<string, unknown>;
      if (typeof result.id !== "string") continue;
      ready.push({
        id: result.id,
        tag: typeof result.tag === "string" ? result.tag : null,
        endpointAdvanced:
          typeof result.endpoint_advanced === "string" ? result.endpoint_advanced : null,
      });
    }
  }
  return ready;
}

export async function getProductInfoTaskResult(
  credentials: DataForSeoCredentials,
  endpoint: string,
): Promise<ArrayBuffer> {
  if (!endpoint.startsWith("/v3/merchant/google/product_info/")) {
    throw new Error("Unexpected DataForSEO product_info endpoint");
  }
  const response = await fetch(`https://api.dataforseo.com${endpoint}`, {
    headers: { authorization: authorization(credentials), accept: "application/json" },
  });
  if (!response.ok) throw new Error(`DataForSEO product_info result returned HTTP ${response.status}`);
  return readBounded(response);
}

export function parseProductInfoPayload(payload: unknown): MerchantResponse {
  return MerchantResponseSchema.parse(payload);
}
