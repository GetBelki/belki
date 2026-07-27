import type { Context } from "hono";
import type { ApiErrorShape } from "../../shared/contracts";

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function requestId(): string {
  return crypto.randomUUID();
}

export function errorResponse(c: Context, error: unknown): Response {
  const id = c.get("requestId") as string | undefined ?? requestId();
  if (error instanceof ApiError) {
    const body: ApiErrorShape = {
      error: {
        code: error.code,
        message: error.message,
        requestId: id,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
    return c.json(body, error.status);
  }
  console.error(JSON.stringify({ level: "error", requestId: id, error: String(error) }));
  return c.json<ApiErrorShape>(
    {
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
        requestId: id,
      },
    },
    500,
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function exclusiveDateEnd(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

export function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
