import { sha256 } from "./crypto";
import { nowIso } from "./http";

export type AiCacheStatus = "hit" | "miss" | "disabled";

export interface AiCacheEntry {
  cacheKey: string;
  projectId: string;
  trackedQueryId: string;
  feature: string;
  operation: string;
  model: string;
  promptVersion: string;
  responseJson: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface AiUsageEvent {
  id: string;
  feature: string;
  operation: string;
  model: string;
  projectId: string | null;
  trackedQueryId: string | null;
  jobId: string | null;
  requestId: string | null;
  retryAttempt: number;
  cacheStatus: AiCacheStatus;
  status: "success" | "failure";
  inputCharacters: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  errorType: string | null;
  createdAt: string;
}

export interface AiUsageStore {
  getCachedResponse(cacheKey: string): Promise<string | null>;
  putCachedResponse(entry: AiCacheEntry): Promise<void>;
  touchCachedResponse(cacheKey: string, usedAt: string): Promise<void>;
  recordUsage(event: AiUsageEvent): Promise<void>;
}

export interface RunAiContext {
  feature: string;
  operation: string;
  model: string;
  promptVersion: string;
  projectId?: string;
  trackedQueryId?: string;
  jobId?: string;
  requestId?: string;
  retryAttempt: number;
}

export interface RunAiResult<T> {
  value: T;
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
}

type AiLogger = (record: Record<string, unknown>) => void;

interface AiUsagePreparedStatement {
  bind(...values: unknown[]): AiUsagePreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface AiUsageDatabase {
  prepare(query: string): AiUsagePreparedStatement;
}

function defaultLogger(record: Record<string, unknown>): void {
  const serialized = JSON.stringify(record);
  if (record.level === "error") console.error(serialized);
  else if (record.level === "warn") console.warn(serialized);
  else console.log(serialized);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function aiUsage(result: unknown): { inputTokens: number; outputTokens: number } {
  const usage = record(record(result)?.usage);
  return {
    inputTokens: Number(usage?.prompt_tokens ?? 0),
    outputTokens: Number(usage?.completion_tokens ?? 0),
  };
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

function serializedInput(input: unknown): string {
  const value = JSON.stringify(input);
  return value === undefined ? String(input) : value;
}

export async function aiCacheKey(
  context: Pick<
    RunAiContext,
    | "feature"
    | "operation"
    | "model"
    | "promptVersion"
    | "projectId"
    | "trackedQueryId"
  >,
  inputJson: string,
): Promise<string> {
  return await sha256(JSON.stringify({
    feature: context.feature,
    operation: context.operation,
    model: context.model,
    promptVersion: context.promptVersion,
    projectId: context.projectId ?? null,
    trackedQueryId: context.trackedQueryId ?? null,
    input: inputJson,
  }));
}

async function bestEffort(
  operation: () => Promise<unknown>,
  logger: AiLogger,
  action: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger({
      level: "warn",
      message: "workers_ai_persistence_failed",
      action,
      errorType: errorType(error),
    });
  }
}

function usageLogRecord(event: AiUsageEvent): Record<string, unknown> {
  return {
    level: event.status === "failure" ? "error" : "info",
    message: "workers_ai_usage",
    timestamp: event.createdAt,
    feature: event.feature,
    operation: event.operation,
    model: event.model,
    projectId: event.projectId,
    trackedQueryId: event.trackedQueryId,
    jobId: event.jobId,
    requestId: event.requestId,
    retryAttempt: event.retryAttempt,
    cacheStatus: event.cacheStatus,
    success: event.status === "success",
    inputCharacters: event.inputCharacters,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    durationMs: event.durationMs,
    errorType: event.errorType,
  };
}

function usageEvent(
  context: RunAiContext,
  fields: Pick<
    AiUsageEvent,
    | "cacheStatus"
    | "status"
    | "inputCharacters"
    | "inputTokens"
    | "outputTokens"
    | "durationMs"
    | "errorType"
  >,
): AiUsageEvent {
  return {
    id: crypto.randomUUID(),
    feature: context.feature,
    operation: context.operation,
    model: context.model,
    projectId: context.projectId ?? null,
    trackedQueryId: context.trackedQueryId ?? null,
    jobId: context.jobId ?? null,
    requestId: context.requestId ?? null,
    retryAttempt: context.retryAttempt,
    createdAt: nowIso(),
    ...fields,
  };
}

export function d1AiUsageStore(db: AiUsageDatabase): AiUsageStore {
  return {
    async getCachedResponse(cacheKey) {
      const row = await db.prepare(
        "SELECT response_json FROM ai_inference_cache WHERE cache_key = ?",
      ).bind(cacheKey).first<{ response_json: string }>();
      return row?.response_json ?? null;
    },
    async putCachedResponse(entry) {
      await db.prepare(
        `INSERT INTO ai_inference_cache (
          cache_key, project_id, tracked_query_id, feature, operation, model,
          prompt_version, response_json, input_tokens, output_tokens,
          created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          response_json = excluded.response_json,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          last_used_at = excluded.last_used_at`,
      ).bind(
        entry.cacheKey,
        entry.projectId,
        entry.trackedQueryId,
        entry.feature,
        entry.operation,
        entry.model,
        entry.promptVersion,
        entry.responseJson,
        entry.inputTokens,
        entry.outputTokens,
        entry.createdAt,
        entry.createdAt,
      ).run();
    },
    async touchCachedResponse(cacheKey, usedAt) {
      await db.prepare(
        `UPDATE ai_inference_cache SET hit_count = hit_count + 1,
          last_used_at = ? WHERE cache_key = ?`,
      ).bind(usedAt, cacheKey).run();
    },
    async recordUsage(event) {
      await db.prepare(
        `INSERT INTO ai_usage_events (
          id, feature, operation, model, project_id, tracked_query_id, job_id,
          request_id, retry_attempt, cache_status, status, input_characters,
          input_tokens, output_tokens, duration_ms, error_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        event.id,
        event.feature,
        event.operation,
        event.model,
        event.projectId,
        event.trackedQueryId,
        event.jobId,
        event.requestId,
        event.retryAttempt,
        event.cacheStatus,
        event.status,
        event.inputCharacters,
        event.inputTokens,
        event.outputTokens,
        event.durationMs,
        event.errorType,
        event.createdAt,
      ).run();
    },
  };
}

export async function runAI<T>(options: {
  context: RunAiContext;
  input: unknown;
  invoke: () => Promise<unknown>;
  parse: (result: unknown) => T;
  store?: AiUsageStore;
  logger?: AiLogger;
}): Promise<RunAiResult<T>> {
  const logger = options.logger ?? defaultLogger;
  const inputJson = serializedInput(options.input);
  const inputCharacters = inputJson.length;
  const startedAt = performance.now();
  const cacheEnabled = Boolean(
    options.store && options.context.projectId && options.context.trackedQueryId,
  );
  const cacheKey = cacheEnabled
    ? await aiCacheKey(options.context, inputJson)
    : null;

  if (cacheKey && options.store) {
    let cachedResponse: string | null = null;
    try {
      cachedResponse = await options.store.getCachedResponse(cacheKey);
    } catch (error) {
      logger({
        level: "warn",
        message: "workers_ai_persistence_failed",
        action: "cache_read",
        errorType: errorType(error),
      });
    }
    if (cachedResponse !== null) {
      try {
        const value = options.parse(JSON.parse(cachedResponse) as unknown);
        const event = usageEvent(options.context, {
          cacheStatus: "hit",
          status: "success",
          inputCharacters,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          errorType: null,
        });
        await Promise.all([
          bestEffort(
            () => options.store!.touchCachedResponse(cacheKey, event.createdAt),
            logger,
            "cache_touch",
          ),
          bestEffort(() => options.store!.recordUsage(event), logger, "usage_event"),
        ]);
        logger(usageLogRecord(event));
        return { value, cacheHit: true, inputTokens: 0, outputTokens: 0 };
      } catch {
        // A stale or malformed cache entry is treated as a miss and replaced
        // only after a fresh response passes the current parser.
      }
    }
  }

  let rawResult: unknown = undefined;
  try {
    rawResult = await options.invoke();
    const usage = aiUsage(rawResult);
    const value = options.parse(rawResult);
    const completedAt = nowIso();
    const event = usageEvent(options.context, {
      cacheStatus: cacheEnabled ? "miss" : "disabled",
      status: "success",
      inputCharacters,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      errorType: null,
    });
    const responseJson = JSON.stringify(rawResult);
    const persistence: Promise<void>[] = [];
    if (
      cacheKey &&
      options.store &&
      options.context.projectId &&
      options.context.trackedQueryId &&
      responseJson !== undefined
    ) {
      persistence.push(bestEffort(
        () => options.store!.putCachedResponse({
          cacheKey,
          projectId: options.context.projectId!,
          trackedQueryId: options.context.trackedQueryId!,
          feature: options.context.feature,
          operation: options.context.operation,
          model: options.context.model,
          promptVersion: options.context.promptVersion,
          responseJson,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          createdAt: completedAt,
        }),
        logger,
        "cache_write",
      ));
    }
    if (options.store) {
      persistence.push(bestEffort(
        () => options.store!.recordUsage(event),
        logger,
        "usage_event",
      ));
    }
    await Promise.all(persistence);
    logger(usageLogRecord(event));
    return { value, cacheHit: false, ...usage };
  } catch (error) {
    const usage = aiUsage(rawResult);
    const event = usageEvent(options.context, {
      cacheStatus: cacheEnabled ? "miss" : "disabled",
      status: "failure",
      inputCharacters,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      errorType: errorType(error),
    });
    if (options.store) {
      await bestEffort(() => options.store!.recordUsage(event), logger, "usage_event");
    }
    logger(usageLogRecord(event));
    throw error;
  }
}
