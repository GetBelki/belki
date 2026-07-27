export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

function cookie(name: string): string | null {
  const part = document.cookie
    .split("; ")
    .find((value) => value.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!["GET", "HEAD"].includes(init.method ?? "GET")) {
    const csrf = cookie("ai_tracker_csrf");
    if (csrf) headers.set("x-csrf-token", csrf);
  }
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const payload = (await response.json().catch(() => null)) as
    | { data: T; page?: { nextCursor: string | null } }
    | { error: { code: string; message: string } }
    | null;
  if (!response.ok || !payload || "error" in payload) {
    const error = payload && "error" in payload ? payload.error : null;
    throw new ApiClientError(
      error?.message ?? `Request failed (${response.status})`,
      response.status,
      error?.code ?? "request_failed",
    );
  }
  return payload.data;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function remove<T>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}

export interface Project {
  id: string;
  name: string;
  primary_domain: string | null;
  html_capture_enabled: number;
  query_count: number;
  last_snapshot_at: string | null;
}

export interface Session {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: "owner" | "admin" | "editor" | "viewer";
  };
  workspaceId: string;
}
