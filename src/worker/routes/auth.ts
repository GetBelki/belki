import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  AcceptInviteSchema,
  CompletePasswordResetSchema,
  InviteSchema,
  LoginSchema,
  MembershipUpdateSchema,
  PasswordResetRequestSchema,
  SetupSchema,
  WorkspaceSelectionSchema,
} from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import {
  checkLoginRateLimit,
  createSession,
  deleteAuthCookies,
  requireRole,
} from "../lib/auth";
import { writeAudit } from "../lib/audit";
import {
  hashPassword,
  randomToken,
  sha256,
  timingSafeTextEqual,
  verifyPassword,
} from "../lib/crypto";
import { ApiError, nowIso } from "../lib/http";
import { sendInvitationEmail, sendPasswordResetEmail } from "../lib/email";
import { listProjects } from "../lib/projects";
import { z } from "zod";

interface LoginRow {
  id: string;
  email: string;
  status: string;
  iterations: number;
  salt: string;
  password_hash: string;
}

export const authRoutes = new Hono<AppEnv>();
const UserParamSchema = z.object({ id: z.string().uuid() });
const InvitationParamSchema = z.object({ id: z.string().uuid() });

authRoutes.get("/status", async (c) => {
  const owner = await c.env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM memberships WHERE role = 'owner'",
  ).first<{ count: number }>();
  return c.json({ data: { setupRequired: (owner?.count ?? 0) === 0 } });
});

authRoutes.post("/setup", zValidator("json", SetupSchema), async (c) => {
  const existing = await c.env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM memberships WHERE role = 'owner'",
  ).first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) {
    throw new ApiError(409, "already_configured", "This installation is already configured.");
  }
  const input = c.req.valid("json");
  if (!(await timingSafeTextEqual(input.bootstrapToken, c.env.BOOTSTRAP_TOKEN))) {
    throw new ApiError(403, "invalid_bootstrap_token", "The bootstrap token is not valid.");
  }

  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const now = nowIso();
  const credential = await hashPassword(input.password);
  const publicBaseUrl = new URL(c.req.url).origin;
  const cycleStartedAt = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    1,
  )).toISOString();
  const cycleEndsAt = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth() + 1,
    1,
  )).toISOString();
  await c.env.CONTROL_DB.batch([
    c.env.CONTROL_DB.prepare(
      `INSERT INTO workspaces (
        id, name, public_base_url, monthly_run_cap, timezone, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      workspaceId,
      input.workspaceName,
      publicBaseUrl,
      input.monthlyRunCap,
      input.timezone,
      now,
      now,
    ),
    c.env.CONTROL_DB.prepare(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).bind(userId, input.email.toLowerCase(), input.displayName, now, now),
    c.env.CONTROL_DB.prepare(
      `INSERT INTO password_credentials (
        user_id, algorithm, iterations, salt, password_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      credential.algorithm,
      credential.iterations,
      credential.salt,
      credential.passwordHash,
      now,
      now,
    ),
    c.env.CONTROL_DB.prepare(
      `INSERT INTO memberships (workspace_id, user_id, role, created_at)
       VALUES (?, ?, 'owner', ?)`,
    ).bind(workspaceId, userId, now),
    c.env.CONTROL_DB.prepare(
      `INSERT INTO billing_accounts (
        workspace_id, provider, payment_mode, plan_key, status, monthly_units,
        project_limit, prompt_limit, source_limit,
        cycle_started_at, cycle_ends_at, created_at, updated_at
      ) VALUES (?, 'self_hosted', 'disabled', 'self_hosted', 'active', ?, 1000000, 1000000, 4, ?, ?, ?, ?)`,
    ).bind(workspaceId, input.monthlyRunCap, cycleStartedAt, cycleEndsAt, now, now),
    c.env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO platform_operators (
        email, user_id, created_at, created_by_user_id
      ) VALUES (?, ?, ?, ?)`,
    ).bind(input.email.toLowerCase(), userId, now, userId),
  ]);
  await writeAudit(c.env.CONTROL_DB, {
    workspaceId,
    userId,
    action: "installation.setup",
    resourceType: "workspace",
    resourceId: workspaceId,
  });
  await createSession(c, userId, workspaceId);
  return c.json({ data: { workspaceId, userId } }, 201);
});

authRoutes.post("/auth/login", zValidator("json", LoginSchema), async (c) => {
  const input = c.req.valid("json");
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  await checkLoginRateLimit(
    c.env.CONTROL_DB,
    await sha256(`${input.email.toLowerCase()}|${ip}`),
  );
  const user = await c.env.CONTROL_DB.prepare(
    `SELECT
      u.id, u.email, u.status, p.iterations, p.salt, p.password_hash
    FROM users u
    JOIN password_credentials p ON p.user_id = u.id
    WHERE u.email = ? COLLATE NOCASE
    LIMIT 1`,
  )
    .bind(input.email)
    .first<LoginRow>();
  if (
    !user ||
    user.status !== "active" ||
    !(await verifyPassword(input.password, user.salt, user.iterations, user.password_hash))
  ) {
    throw new ApiError(401, "invalid_credentials", "The email or password is incorrect.");
  }
  await c.env.CONTROL_DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .bind(nowIso(), user.id)
    .run();
  await createSession(c, user.id);
  return c.json({ data: { signedIn: true } });
});

authRoutes.get("/auth/session", async (c) => {
  const principal = c.get("principal");
  const [projects, workspace, workspaces, operator] = await Promise.all([
    listProjects(c.env.CONTROL_DB, principal.workspaceId),
    c.env.CONTROL_DB.prepare("SELECT id, name, status, plan_key FROM workspaces WHERE id = ?")
      .bind(principal.workspaceId)
      .first<{ id: string; name: string; status: string; plan_key: string }>(),
    c.env.CONTROL_DB.prepare(
      `SELECT workspace.id, workspace.name, workspace.status, workspace.plan_key,
        membership.role
       FROM memberships membership
       JOIN workspaces workspace ON workspace.id = membership.workspace_id
       WHERE membership.user_id = ? AND membership.status = 'active'
         AND workspace.status != 'deleted'
       ORDER BY workspace.name COLLATE NOCASE, workspace.id`,
    ).bind(principal.userId).all(),
    c.env.CONTROL_DB.prepare(
      "SELECT 1 AS found FROM platform_operators WHERE email = ? COLLATE NOCASE",
    ).bind(principal.email).first<{ found: number }>(),
  ]);
  if (!workspace) {
    throw new ApiError(500, "workspace_not_found", "The current workspace could not be loaded.");
  }
  return c.json({
    data: {
      user: {
        id: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
        role: principal.role,
      },
      workspaceId: principal.workspaceId,
      workspace,
      workspaces: workspaces.results,
      projects,
      csrfTokenPresent: Boolean(getCookie(c, "ai_tracker_csrf")),
      isPlatformOperator: Boolean(operator?.found),
    },
  });
});

authRoutes.get("/auth/workspaces", async (c) => {
  const principal = c.get("principal");
  const workspaces = await c.env.CONTROL_DB.prepare(
    `SELECT workspace.id, workspace.name, workspace.status, workspace.plan_key,
      membership.role
     FROM memberships membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     WHERE membership.user_id = ? AND membership.status = 'active'
       AND workspace.status != 'deleted'
     ORDER BY workspace.name COLLATE NOCASE, workspace.id`,
  ).bind(principal.userId).all();
  return c.json({ data: workspaces.results });
});

authRoutes.post(
  "/auth/workspaces/select",
  zValidator("json", WorkspaceSelectionSchema),
  async (c) => {
    const principal = c.get("principal");
    const { workspaceId } = c.req.valid("json");
    const membership = await c.env.CONTROL_DB.prepare(
      `SELECT membership.role
       FROM memberships membership
       JOIN workspaces workspace ON workspace.id = membership.workspace_id
       WHERE membership.user_id = ? AND membership.workspace_id = ?
         AND membership.status = 'active' AND workspace.status != 'deleted'`,
    ).bind(principal.userId, workspaceId).first<{ role: string }>();
    if (!membership) {
      throw new ApiError(404, "workspace_not_found", "Workspace not found.");
    }
    await c.env.CONTROL_DB.prepare(
      "UPDATE sessions SET active_workspace_id = ?, last_seen_at = ? WHERE id = ? AND user_id = ?",
    ).bind(workspaceId, nowIso(), principal.sessionId, principal.userId).run();
    return c.json({ data: { workspaceId } });
  },
);

authRoutes.post("/auth/logout", async (c) => {
  const principal = c.get("principal");
  await c.env.CONTROL_DB.prepare("DELETE FROM sessions WHERE id = ?")
    .bind(principal.sessionId)
    .run();
  deleteAuthCookies(c);
  return c.json({ data: { signedOut: true } });
});

authRoutes.post(
  "/auth/invitations",
  zValidator("json", InviteSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const input = c.req.valid("json");
    const token = randomToken();
    const id = crypto.randomUUID();
    const now = nowIso();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO auth_tokens (
        id, workspace_id, email, role, purpose, token_hash, expires_at,
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, 'invite', ?, ?, ?, ?)`,
    )
      .bind(
        id,
        principal.workspaceId,
        input.email.toLowerCase(),
        input.role,
        await sha256(token),
        expires,
        principal.userId,
        now,
      )
      .run();
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "membership.invited",
      resourceType: "auth_token",
      resourceId: id,
      metadata: { email: input.email, role: input.role, emailRequested: input.sendEmail },
    });
    const link = `${new URL(c.req.url).origin}/accept-invite?token=${encodeURIComponent(token)}`;
    let emailDelivery: "failed" | "not_requested" | "sent" = "not_requested";
    if (input.sendEmail) {
      try {
        const workspace = await c.env.CONTROL_DB.prepare(
          "SELECT name FROM workspaces WHERE id = ?",
        )
          .bind(principal.workspaceId)
          .first<{ name: string }>();
        const result = await sendInvitationEmail(
          c.env.EMAIL,
          { email: c.env.EMAIL_FROM_ADDRESS, name: c.env.APP_NAME },
          {
            appName: c.env.APP_NAME,
            inviteeEmail: input.email.toLowerCase(),
            inviterName: principal.displayName,
            workspaceName: workspace?.name ?? "your workspace",
            role: input.role,
            link,
            expiresAt: expires,
          },
        );
        emailDelivery = "sent";
        console.log(
          JSON.stringify({
            level: "info",
            message: "invitation_email_sent",
            invitationId: id,
            messageId: result.messageId,
          }),
        );
      } catch (error) {
        emailDelivery = "failed";
        console.error(
          JSON.stringify({
            level: "error",
            message: "invitation_email_failed",
            invitationId: id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return c.json({ data: { id, link, expiresAt: expires, emailDelivery } }, 201);
  },
);

authRoutes.get("/auth/invitations", async (c) => {
  const principal = requireRole(c, "admin");
  const invitations = await c.env.CONTROL_DB.prepare(
    `SELECT id, email, role, expires_at, created_at
     FROM auth_tokens
     WHERE workspace_id = ?
       AND purpose = 'invite'
       AND consumed_at IS NULL
       AND expires_at > ?
     ORDER BY created_at DESC`,
  )
    .bind(principal.workspaceId, nowIso())
    .all();
  return c.json({ data: invitations.results });
});

authRoutes.delete(
  "/auth/invitations/:id",
  zValidator("param", InvitationParamSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const { id } = c.req.valid("param");
    const invitation = await c.env.CONTROL_DB.prepare(
      `SELECT email, role
       FROM auth_tokens
       WHERE id = ? AND workspace_id = ? AND purpose = 'invite' AND consumed_at IS NULL`,
    )
      .bind(id, principal.workspaceId)
      .first<{ email: string; role: string }>();
    if (!invitation) {
      throw new ApiError(404, "invitation_not_found", "Pending invitation not found.");
    }
    const result = await c.env.CONTROL_DB.prepare(
      "DELETE FROM auth_tokens WHERE id = ? AND workspace_id = ? AND purpose = 'invite' AND consumed_at IS NULL",
    )
      .bind(id, principal.workspaceId)
      .run();
    if (result.meta.changes === 0) {
      throw new ApiError(409, "invitation_not_pending", "This invitation is no longer pending.");
    }
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "membership.invitation_revoked",
      resourceType: "auth_token",
      resourceId: id,
      metadata: invitation,
    });
    return c.json({ data: { id, revoked: true } });
  },
);

authRoutes.post(
  "/auth/invitations/accept",
  zValidator("json", AcceptInviteSchema),
  async (c) => {
    const input = c.req.valid("json");
    const tokenHash = await sha256(input.token);
    const invitation = await c.env.CONTROL_DB.prepare(
      `SELECT id, workspace_id, email, role, expires_at, consumed_at
       FROM auth_tokens
       WHERE token_hash = ? AND purpose = 'invite'
       LIMIT 1`,
    )
      .bind(tokenHash)
      .first<{
        id: string;
        workspace_id: string;
        email: string;
        role: "admin" | "editor" | "viewer";
        expires_at: string;
        consumed_at: string | null;
      }>();
    if (
      !invitation ||
      invitation.consumed_at ||
      Date.parse(invitation.expires_at) <= Date.now()
    ) {
      throw new ApiError(410, "invitation_expired", "This invitation is invalid or expired.");
    }
    const duplicate = await c.env.CONTROL_DB.prepare(
      `SELECT user.id, user.status, credential.iterations, credential.salt,
        credential.password_hash
       FROM users user
       JOIN password_credentials credential ON credential.user_id = user.id
       WHERE user.email = ? COLLATE NOCASE`,
    )
      .bind(invitation.email)
      .first<{
        id: string;
        status: string;
        iterations: number;
        salt: string;
        password_hash: string;
      }>();

    const now = nowIso();
    let userId: string;
    const statements: D1PreparedStatement[] = [];
    if (duplicate) {
      if (
        duplicate.status !== "active" ||
        !(await verifyPassword(
          input.password,
          duplicate.salt,
          duplicate.iterations,
          duplicate.password_hash,
        ))
      ) {
        throw new ApiError(401, "invalid_credentials", "Sign in with this email to accept the invitation.");
      }
      const membership = await c.env.CONTROL_DB.prepare(
        "SELECT status FROM memberships WHERE workspace_id = ? AND user_id = ?",
      ).bind(invitation.workspace_id, duplicate.id).first<{ status: string }>();
      if (membership?.status === "active") {
        throw new ApiError(409, "already_a_member", "This user already belongs to the workspace.");
      }
      userId = duplicate.id;
    } else {
      userId = crypto.randomUUID();
      const credential = await hashPassword(input.password);
      statements.push(
        c.env.CONTROL_DB.prepare(
          `INSERT INTO users (id, email, display_name, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        ).bind(userId, invitation.email, input.displayName, now, now),
        c.env.CONTROL_DB.prepare(
          `INSERT INTO password_credentials (
            user_id, algorithm, iterations, salt, password_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          userId,
          credential.algorithm,
          credential.iterations,
          credential.salt,
          credential.passwordHash,
          now,
          now,
        ),
      );
    }
    statements.push(
      c.env.CONTROL_DB.prepare(
        `INSERT INTO memberships (workspace_id, user_id, role, status, created_at)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET
           role = excluded.role, status = 'active'`,
      ).bind(invitation.workspace_id, userId, invitation.role, now),
      c.env.CONTROL_DB.prepare(
        "UPDATE auth_tokens SET consumed_at = ?, user_id = ? WHERE id = ? AND consumed_at IS NULL",
      ).bind(now, userId, invitation.id),
    );
    await c.env.CONTROL_DB.batch(statements);
    await createSession(c, userId, invitation.workspace_id);
    return c.json({ data: { userId } }, 201);
  },
);

authRoutes.post(
  "/auth/password-reset/request",
  zValidator("json", PasswordResetRequestSchema),
  async (c) => {
    const { email } = c.req.valid("json");
    const normalizedEmail = email.toLowerCase();
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    await checkLoginRateLimit(c.env.CONTROL_DB, await sha256(`reset|${normalizedEmail}|${ip}`), 5);
    const user = await c.env.CONTROL_DB.prepare(
      `SELECT user.id, membership.workspace_id
       FROM users user
       JOIN memberships membership ON membership.user_id = user.id
       WHERE user.email = ? COLLATE NOCASE AND user.status = 'active'
         AND membership.status = 'active'
       ORDER BY membership.created_at
       LIMIT 1`,
    ).bind(normalizedEmail).first<{ id: string; workspace_id: string }>();
    if (user) {
      const token = randomToken();
      const tokenId = crypto.randomUUID();
      const now = nowIso();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await c.env.CONTROL_DB.prepare(
        `INSERT INTO auth_tokens (
          id, workspace_id, user_id, email, purpose, token_hash, expires_at, created_at
        ) VALUES (?, ?, ?, ?, 'password_reset', ?, ?, ?)`,
      ).bind(
        tokenId,
        user.workspace_id,
        user.id,
        normalizedEmail,
        await sha256(token),
        expiresAt,
        now,
      ).run();
      const link = `${new URL(c.req.url).origin}/reset-password?token=${encodeURIComponent(token)}`;
      try {
        await sendPasswordResetEmail(
          c.env.EMAIL,
          { email: c.env.EMAIL_FROM_ADDRESS, name: c.env.APP_NAME },
          { appName: c.env.APP_NAME, email: normalizedEmail, link, expiresAt },
        );
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "password_reset_email_failed",
          tokenId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return c.json({ data: { accepted: true } }, 202);
  },
);

authRoutes.post(
  "/auth/password-reset/complete",
  zValidator("json", CompletePasswordResetSchema),
  async (c) => {
    const input = c.req.valid("json");
    const token = await c.env.CONTROL_DB.prepare(
      `SELECT id, user_id, expires_at, consumed_at
       FROM auth_tokens
       WHERE token_hash = ? AND purpose = 'password_reset'
       LIMIT 1`,
    )
      .bind(await sha256(input.token))
      .first<{
        id: string;
        user_id: string | null;
        expires_at: string;
        consumed_at: string | null;
      }>();
    if (!token?.user_id || token.consumed_at || Date.parse(token.expires_at) <= Date.now()) {
      throw new ApiError(410, "password_reset_expired", "This reset link is invalid or expired.");
    }
    const credential = await hashPassword(input.password);
    const now = nowIso();
    await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        `UPDATE password_credentials SET
          algorithm = ?, iterations = ?, salt = ?, password_hash = ?, updated_at = ?
         WHERE user_id = ?`,
      ).bind(
        credential.algorithm,
        credential.iterations,
        credential.salt,
        credential.passwordHash,
        now,
        token.user_id,
      ),
      c.env.CONTROL_DB.prepare(
        "UPDATE auth_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
      ).bind(now, token.id),
      c.env.CONTROL_DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(token.user_id),
    ]);
    return c.json({ data: { reset: true } });
  },
);

authRoutes.get("/users", async (c) => {
  const principal = requireRole(c, "admin");
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT u.id, u.email, u.display_name,
      CASE WHEN m.status = 'active' THEN 'active' ELSE 'disabled' END AS status,
      u.last_login_at, m.role, m.created_at
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ?
     ORDER BY u.display_name`,
  )
    .bind(principal.workspaceId)
    .all();
  return c.json({ data: rows.results });
});

authRoutes.patch(
  "/users/:id",
  zValidator("param", UserParamSchema),
  zValidator("json", MembershipUpdateSchema),
  async (c) => {
    const principal = requireRole(c, "owner");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const target = await c.env.CONTROL_DB.prepare(
      `SELECT m.role, m.status
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.user_id = ?`,
    )
      .bind(principal.workspaceId, id)
      .first<{ role: string; status: string }>();
    if (!target) throw new ApiError(404, "user_not_found", "Workspace user not found.");
    if (target.role === "owner") {
      throw new ApiError(403, "owner_protected", "The workspace owner cannot be changed.");
    }
    if (id === principal.userId && input.status === "disabled") {
      throw new ApiError(409, "self_disable", "You cannot disable your own account.");
    }
    const statements: D1PreparedStatement[] = [];
    if (input.role) {
      statements.push(
        c.env.CONTROL_DB.prepare(
          "UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?",
        ).bind(input.role, principal.workspaceId, id),
      );
    }
    if (input.status) {
      statements.push(
        c.env.CONTROL_DB.prepare(
          "UPDATE memberships SET status = ? WHERE workspace_id = ? AND user_id = ?",
        ).bind(input.status === "active" ? "active" : "suspended", principal.workspaceId, id),
      );
      if (input.status === "disabled") {
        statements.push(
          c.env.CONTROL_DB.prepare(
            "DELETE FROM sessions WHERE user_id = ? AND active_workspace_id = ?",
          ).bind(id, principal.workspaceId),
        );
      }
    }
    await c.env.CONTROL_DB.batch(statements);
    return c.json({ data: { id } });
  },
);

authRoutes.delete(
  "/users/:id",
  zValidator("param", UserParamSchema),
  async (c) => {
    const principal = requireRole(c, "owner");
    const { id } = c.req.valid("param");
    const target = await c.env.CONTROL_DB.prepare(
      `SELECT u.email, u.display_name, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.user_id = ?`,
    )
      .bind(principal.workspaceId, id)
      .first<{ email: string; display_name: string; role: string }>();
    if (!target) throw new ApiError(404, "user_not_found", "Workspace user not found.");
    if (target.role === "owner") {
      throw new ApiError(403, "owner_protected", "The workspace owner cannot be removed.");
    }
    if (id === principal.userId) {
      throw new ApiError(409, "self_remove", "You cannot remove your own account.");
    }

    const otherMembership = await c.env.CONTROL_DB.prepare(
      `SELECT 1 AS found FROM memberships
       WHERE user_id = ? AND workspace_id <> ? AND status != 'removed' LIMIT 1`,
    )
      .bind(id, principal.workspaceId)
      .first<{ found: number }>();
    const statements = [
      c.env.CONTROL_DB.prepare(
        "DELETE FROM sessions WHERE user_id = ? AND active_workspace_id = ?",
      ).bind(id, principal.workspaceId),
      c.env.CONTROL_DB.prepare(
        "DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?",
      ).bind(principal.workspaceId, id),
    ];
    if (!otherMembership) {
      statements.push(c.env.CONTROL_DB.prepare("DELETE FROM users WHERE id = ?").bind(id));
    }
    await c.env.CONTROL_DB.batch(statements);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "membership.removed",
      resourceType: "user",
      resourceId: id,
      metadata: target,
    });
    return c.json({ data: { id, removed: true } });
  },
);

authRoutes.post(
  "/users/:id/password-reset",
  zValidator("param", UserParamSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const { id: userId } = c.req.valid("param");
    const target = await c.env.CONTROL_DB.prepare(
      `SELECT u.email, m.role
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.user_id = ?`,
    )
      .bind(principal.workspaceId, userId)
      .first<{ email: string; role: string }>();
    if (!target) throw new ApiError(404, "user_not_found", "Workspace user not found.");
    if (target.role === "owner" && principal.role !== "owner") {
      throw new ApiError(403, "owner_protected", "Only the owner can reset the owner account.");
    }
    const rawToken = randomToken();
    const tokenId = crypto.randomUUID();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO auth_tokens (
        id, workspace_id, user_id, email, role, purpose, token_hash,
        expires_at, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'password_reset', ?, ?, ?, ?)`,
    )
      .bind(
        tokenId,
        principal.workspaceId,
        userId,
        target.email,
        target.role,
        await sha256(rawToken),
        expiresAt,
        principal.userId,
        now,
      )
      .run();
    const link = `${new URL(c.req.url).origin}/reset-password?token=${encodeURIComponent(rawToken)}`;
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "password_reset.created",
      resourceType: "user",
      resourceId: userId,
    });
    return c.json({ data: { link, expiresAt } }, 201);
  },
);
