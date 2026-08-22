import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "./app";
import type { Principal, Role, WorkspaceStatus } from "../../shared/contracts";
import { ApiError, nowIso } from "./http";
import { randomToken, sha256, timingSafeTextEqual } from "./crypto";

const SESSION_COOKIE = "ai_tracker_session";
const CSRF_COOKIE = "ai_tracker_csrf";
const SESSION_SECONDS = 60 * 60 * 24 * 14;

interface SessionRow {
  session_id: string;
  user_id: string;
  workspace_id: string;
  email: string;
  display_name: string;
  role: Role;
  csrf_hash: string;
  expires_at: string;
  last_seen_at: string;
  status: string;
  workspace_status: WorkspaceStatus;
}

const PUBLIC_PATHS = new Set([
  "/api/v1/status",
  "/api/v1/setup",
  "/api/v1/auth/login",
  "/api/v1/auth/signup/redeem",
  "/api/v1/auth/invitations/validate",
  "/api/v1/auth/invitations/accept",
  "/api/v1/auth/password-reset/request",
  "/api/v1/auth/password-reset/complete",
]);

const READ_ONLY_MUTATION_PATHS = new Set([
  "/api/v1/auth/logout",
  "/api/v1/auth/workspaces/select",
  "/api/v1/billing/checkout",
  "/api/v1/billing/management-session",
]);

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (!sessionToken) throw new ApiError(401, "authentication_required", "Sign in is required.");
  const timing = c.get("timing");
  const tokenHash = await timing.measure("auth_crypto", () => sha256(sessionToken));
  const sessionResult = await timing.measureD1("auth_db", () =>
    c.env.CONTROL_DB.prepare(
      `SELECT
        s.id AS session_id, s.user_id, m.workspace_id, u.email, u.display_name,
        m.role, s.csrf_hash, s.expires_at, s.last_seen_at, u.status,
        w.status AS workspace_status
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN memberships m
        ON m.user_id = u.id AND m.workspace_id = s.active_workspace_id
      JOIN workspaces w ON w.id = m.workspace_id
      WHERE s.token_hash = ?
        AND m.status = 'active'
        AND w.status != 'deleted'
      LIMIT 1`,
    )
      .bind(tokenHash)
      .all<SessionRow>(),
  );
  const row = sessionResult.results[0];

  if (!row || row.status !== "active" || Date.parse(row.expires_at) <= Date.now()) {
    deleteAuthCookies(c);
    throw new ApiError(401, "session_expired", "Your session has expired.");
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const cookieCsrf = getCookie(c, CSRF_COOKIE);
    const headerCsrf = c.req.header("x-csrf-token");
    if (
      !cookieCsrf ||
      !headerCsrf ||
      !(await timingSafeTextEqual(cookieCsrf, headerCsrf)) ||
      !(await timingSafeTextEqual(await sha256(headerCsrf), row.csrf_hash))
    ) {
      throw new ApiError(403, "csrf_failed", "The request could not be verified.");
    }
  }

  const principal: Principal = {
    sessionId: row.session_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    workspaceStatus: row.workspace_status,
  };
  c.set("principal", principal);

  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    row.workspace_status !== "active" &&
    !READ_ONLY_MUTATION_PATHS.has(c.req.path)
  ) {
    if (row.workspace_status === "pending_payment") {
      throw new ApiError(402, "payment_required", "Complete checkout to activate this workspace.");
    }
    throw new ApiError(403, "read_only", "This workspace is read-only.");
  }
  await next();

  const lastSeenAt = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt >= 5 * 60 * 1000) {
    const updateLastSeen = c.env.CONTROL_DB
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .bind(nowIso(), row.session_id)
      .run()
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: "error",
            message: "session_last_seen_update_failed",
            sessionId: row.session_id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    c.executionCtx.waitUntil(updateLastSeen);
  }
});

export async function createSession(
  c: Context<AppEnv>,
  userId: string,
  requestedWorkspaceId?: string,
): Promise<void> {
  const membership = await c.env.CONTROL_DB.prepare(
    `SELECT membership.workspace_id
     FROM memberships membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     WHERE membership.user_id = ? AND membership.status = 'active'
       AND workspace.status != 'deleted'
       AND (? IS NULL OR membership.workspace_id = ?)
     ORDER BY membership.created_at, membership.workspace_id
     LIMIT 1`,
  ).bind(userId, requestedWorkspaceId ?? null, requestedWorkspaceId ?? null)
    .first<{ workspace_id: string }>();
  if (!membership) {
    throw new ApiError(403, "workspace_access_required", "No accessible workspace was found.");
  }
  const token = randomToken();
  const csrf = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
  const ip = c.req.header("cf-connecting-ip");
  await c.env.CONTROL_DB.prepare(
    `INSERT INTO sessions (
      id, user_id, token_hash, csrf_hash, expires_at, created_at, last_seen_at,
      ip_hash, user_agent, active_workspace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      await sha256(token),
      await sha256(csrf),
      expires.toISOString(),
      now.toISOString(),
      now.toISOString(),
      ip ? await sha256(ip) : null,
      c.req.header("user-agent")?.slice(0, 500) ?? null,
      membership.workspace_id,
    )
    .run();

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  setCookie(c, CSRF_COOKIE, csrf, {
    httpOnly: false,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
}

export function deleteAuthCookies(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, CSRF_COOKIE, { path: "/" });
}

const ROLE_LEVEL: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export function requireRole(c: Context<AppEnv>, minimum: Role): Principal {
  const principal = c.get("principal");
  if (ROLE_LEVEL[principal.role] < ROLE_LEVEL[minimum]) {
    throw new ApiError(403, "insufficient_role", `This action requires the ${minimum} role.`);
  }
  return principal;
}

export async function assertOperator(c: Context<AppEnv>): Promise<void> {
  const principal = c.get("principal");
  const operator = await c.env.CONTROL_DB.prepare(
    "SELECT email FROM platform_operators WHERE email = ? COLLATE NOCASE",
  )
    .bind(principal.email)
    .first<{ email: string }>();
  if (!operator) {
    throw new ApiError(
      403,
      "operator_required",
      "Platform operator access is required.",
    );
  }
  if (String(c.env.DEPLOYMENT_MODE) === "managed") {
    const accessEmail = c.req.header("cf-access-authenticated-user-email");
    if (
      !accessEmail ||
      accessEmail.toLowerCase() !== principal.email.toLowerCase()
    ) {
      throw new ApiError(
        403,
        "cloudflare_access_required",
        "Cloudflare Access authentication is required.",
      );
    }
  }
}

export async function checkLoginRateLimit(
  db: D1Database,
  key: string,
  maximum = 10,
): Promise<void> {
  const currentWindow = new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString();
  await db
    .prepare(
      `INSERT INTO rate_limits (key, window_started_at, attempts)
       VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         window_started_at = CASE
           WHEN rate_limits.window_started_at = excluded.window_started_at
             THEN rate_limits.window_started_at
           ELSE excluded.window_started_at
         END,
         attempts = CASE
           WHEN rate_limits.window_started_at = excluded.window_started_at
             THEN rate_limits.attempts + 1
           ELSE 1
         END`,
    )
    .bind(key, currentWindow)
    .run();
  const row = await db
    .prepare("SELECT attempts FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<{ attempts: number }>();
  if ((row?.attempts ?? 0) > maximum) {
    throw new ApiError(429, "too_many_attempts", "Try again in a few minutes.");
  }
}
