import type { Context } from "hono";
import type { ApiErrorShape } from "../../shared/contracts";

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the configured limit");
  }
}

export class InvalidContentLengthError extends Error {
  constructor() {
    super("Content-Length must be a finite non-negative integer");
  }
}

function assertDeclaredContentLength(request: Request, maximumBytes: number): void {
  const header = request.headers.get("content-length");
  if (header === null) return;
  const declared = Number(header);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw new InvalidContentLengthError();
  }
  if (declared > maximumBytes) throw new RequestBodyTooLargeError();
}

export async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  assertDeclaredContentLength(request, maximumBytes);
  if (!request.body) return new Uint8Array();

  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedText(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readBoundedBody(request, maximumBytes));
}

export function limitReadableBytes(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): ReadableStream<Uint8Array> {
  let length = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > maximumBytes) throw new RequestBodyTooLargeError();
      controller.enqueue(chunk);
    },
  }));
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
