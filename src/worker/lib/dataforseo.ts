import { z } from "zod";
import { extractTaskHtml } from "./dataforseo-html";
import type { DataForSeoCredentials } from "./provider-credentials";
import type { TrackingSource } from "../../shared/contracts";

const API_ORIGIN = "https://api.dataforseo.com";
const MAX_PROVIDER_BODY_BYTES = 20 * 1024 * 1024;

const TaskResponseSchema = z
  .object({
    status_code: z.number().optional(),
    status_message: z.string().optional(),
    tasks: z
      .array(
        z
          .object({
            id: z.string().optional(),
            status_code: z.number().optional(),
            status_message: z.string().optional(),
            cost: z.number().nullable().optional(),
            data: z.record(z.string(), z.unknown()).nullable().optional(),
            result: z.array(z.unknown()).nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type DataForSeoResponse = z.infer<typeof TaskResponseSchema>;

export interface StandardTaskInput {
  keyword: string;
  location_code: number;
  language_code: string;
  force_web_search?: boolean;
  priority: 1 | 2;
  expand_citations?: boolean;
  device?: "desktop";
  os?: "windows";
  depth?: number;
  load_async_ai_overview?: boolean;
  tag: string;
  postback_url: string;
  postback_data: "advanced";
}

const SOURCE_PATHS: Record<TrackingSource, string> = {
  chatgpt: "/v3/ai_optimization/chat_gpt/llm_scraper",
  gemini: "/v3/ai_optimization/gemini/llm_scraper",
  google_ai_mode: "/v3/serp/google/ai_mode",
  google_ai_overview: "/v3/serp/google/organic",
};

const LANGUAGE_CODE_OVERRIDES: Record<
  TrackingSource,
  Readonly<Record<string, string>>
> = {
  chatgpt: {
    nb: "no",
  },
  gemini: {
    nb: "no",
    pt: "pt-BR",
    tl: "fil",
  },
  google_ai_mode: {
    nb: "no",
    pt: "pt-BR",
    tl: "fil",
  },
  google_ai_overview: {
    nb: "no",
  },
};

function apiBase(source: TrackingSource): string {
  return `${API_ORIGIN}${SOURCE_PATHS[source]}`;
}

export function dataForSeoLanguageCode(
  source: TrackingSource,
  languageCode: string,
): string {
  return LANGUAGE_CODE_OVERRIDES[source][languageCode] ?? languageCode;
}

export function dataForSeoTask(
  source: TrackingSource,
  input: Omit<StandardTaskInput, "force_web_search" | "expand_citations" | "device" | "os" | "depth" | "load_async_ai_overview"> & {
    force_web_search: boolean;
    expand_citations: boolean;
  },
): StandardTaskInput {
  const localizedInput = {
    ...input,
    language_code: dataForSeoLanguageCode(source, input.language_code),
  };
  if (source === "chatgpt") return localizedInput;
  if (source === "gemini") {
    const geminiTask: StandardTaskInput = { ...localizedInput };
    delete geminiTask.force_web_search;
    return geminiTask;
  }
  const common: StandardTaskInput = {
    keyword: localizedInput.keyword,
    location_code: localizedInput.location_code,
    language_code: localizedInput.language_code,
    priority: localizedInput.priority,
    tag: localizedInput.tag,
    postback_url: localizedInput.postback_url,
    postback_data: "advanced",
    device: "desktop",
    os: "windows",
  };
  return source === "google_ai_overview"
    ? { ...common, depth: 10, load_async_ai_overview: true }
    : common;
}

function authorization(credentials: DataForSeoCredentials): string {
  return `Basic ${btoa(`${credentials.login}:${credentials.password}`)}`;
}

async function readBounded(response: Response): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_PROVIDER_BODY_BYTES) {
    throw new Error(`Provider response exceeds ${MAX_PROVIDER_BODY_BYTES} bytes`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PROVIDER_BODY_BYTES) {
    throw new Error(`Provider response exceeds ${MAX_PROVIDER_BODY_BYTES} bytes`);
  }
  return buffer;
}

export async function postStandardTasks(
  credentials: DataForSeoCredentials,
  source: TrackingSource,
  tasks: StandardTaskInput[],
): Promise<DataForSeoResponse> {
  const response = await fetch(`${apiBase(source)}/task_post`, {
    method: "POST",
    headers: {
      authorization: authorization(credentials),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(tasks),
  });
  if (!response.ok) throw new Error(`DataForSEO task_post returned HTTP ${response.status}`);
  return TaskResponseSchema.parse(JSON.parse(new TextDecoder().decode(await readBounded(response))));
}

export async function postLiveAdvanced(
  credentials: DataForSeoCredentials,
  source: TrackingSource,
  task: Pick<
    StandardTaskInput,
    "keyword" | "location_code" | "language_code" | "force_web_search" | "tag"
  >,
): Promise<{ payload: DataForSeoResponse; bytes: ArrayBuffer }> {
  const localizedTask = {
    ...task,
    language_code: dataForSeoLanguageCode(source, task.language_code),
  };
  const liveTask = source === "chatgpt"
    ? localizedTask
    : source === "gemini"
      ? {
          keyword: localizedTask.keyword,
          location_code: localizedTask.location_code,
          language_code: localizedTask.language_code,
          tag: localizedTask.tag,
        }
    : {
        keyword: localizedTask.keyword,
        location_code: localizedTask.location_code,
        language_code: localizedTask.language_code,
        tag: localizedTask.tag,
        device: "desktop",
        os: "windows",
        ...(source === "google_ai_overview"
          ? { depth: 10, load_async_ai_overview: true }
          : {}),
      };
  const response = await fetch(`${apiBase(source)}/live/advanced`, {
    method: "POST",
    headers: {
      authorization: authorization(credentials),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify([liveTask]),
  });
  if (!response.ok) throw new Error(`DataForSEO live/advanced returned HTTP ${response.status}`);
  const bytes = await readBounded(response);
  const payload = TaskResponseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  return { payload, bytes };
}

export async function getTasksReady(credentials: DataForSeoCredentials, source: TrackingSource): Promise<
  Array<{
    id: string;
    tag: string | null;
    endpointAdvanced: string | null;
    endpointHtml: string | null;
  }>
> {
  const response = await fetch(`${apiBase(source)}/tasks_ready`, {
    headers: { authorization: authorization(credentials), accept: "application/json" },
  });
  if (!response.ok) throw new Error(`DataForSEO tasks_ready returned HTTP ${response.status}`);
  const payload = TaskResponseSchema.parse(
    JSON.parse(new TextDecoder().decode(await readBounded(response))),
  );
  const ready: Array<{
    id: string;
    tag: string | null;
    endpointAdvanced: string | null;
    endpointHtml: string | null;
  }> = [];
  for (const task of payload.tasks) {
    for (const rawResult of task.result ?? []) {
      if (typeof rawResult !== "object" || rawResult === null) continue;
      const result = rawResult as Record<string, unknown>;
      if (typeof result.id !== "string") continue;
      ready.push({
        id: result.id,
        tag: typeof result.tag === "string" ? result.tag : null,
        endpointAdvanced:
          typeof result.endpoint_advanced === "string" ? result.endpoint_advanced : null,
        endpointHtml: typeof result.endpoint_html === "string" ? result.endpoint_html : null,
      });
    }
  }
  return ready;
}

export async function getTaskResult(
  credentials: DataForSeoCredentials,
  source: TrackingSource,
  endpoint: string,
): Promise<ArrayBuffer> {
  if (!endpoint.startsWith(`${SOURCE_PATHS[source]}/`)) {
    throw new Error("Unexpected DataForSEO endpoint");
  }
  const response = await fetch(`https://api.dataforseo.com${endpoint}`, {
    headers: { authorization: authorization(credentials), accept: "application/json" },
  });
  if (!response.ok) throw new Error(`DataForSEO task result returned HTTP ${response.status}`);
  return readBounded(response);
}

export async function getTaskHtml(credentials: DataForSeoCredentials, taskId: string): Promise<string> {
  const bytes = await getTaskResult(
    credentials,
    "chatgpt",
    `/v3/ai_optimization/chat_gpt/llm_scraper/task_get/html/${taskId}`,
  );
  return extractTaskHtml(JSON.parse(new TextDecoder().decode(bytes)));
}

export async function getLocaleCatalog(
  credentials: DataForSeoCredentials,
  kind: "locations" | "languages",
): Promise<DataForSeoResponse> {
  const response = await fetch(`${apiBase("chatgpt")}/${kind}`, {
    headers: { authorization: authorization(credentials), accept: "application/json" },
  });
  if (!response.ok) throw new Error(`DataForSEO ${kind} returned HTTP ${response.status}`);
  return TaskResponseSchema.parse(JSON.parse(new TextDecoder().decode(await readBounded(response))));
}
