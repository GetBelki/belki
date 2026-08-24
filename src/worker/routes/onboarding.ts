import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  PlanKeySchema,
  SignupCodeCreateSchema,
  SignupCodeRedeemSchema,
  WorkspaceStatusSchema,
} from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import { writeAudit } from "../lib/audit";
import { assertOperator, createSession } from "../lib/auth";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto";
import { ApiError, nowIso } from "../lib/http";
import { requestPublicAppOrigin } from "../lib/public-origin";
import { stripeLivemode } from "../lib/stripe";
import { PLAN_ENTITLEMENTS, syncUsageEntitlement } from "../lib/usage";
import { cancelWorkspaceBillingPlanChange, reconcileWorkspaceBilling } from "./billing";

const OperatorWorkspaceParamSchema = z.object({ id: z.string().uuid() });
const OperatorSignupCodeParamSchema = z.object({ id: z.string().uuid() });
const OperatorWorkspaceUpdateSchema = z.object({
  status: WorkspaceStatusSchema.optional(),
  planKey: PlanKeySchema.optional(),
  monthlyUnits: z.number().int().min(0).max(1_000_000_000).optional(),
  projectLimit: z.number().int().min(0).max(1_000_000).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

interface ExistingUserRow {
  id: string;
  status: string;
  iterations: number;
  salt: string;
  password_hash: string;
}

function monthCycle(): { start: string; end: string } {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

export const onboardingRoutes = new Hono<AppEnv>();

onboardingRoutes.post(
  "/auth/signup/redeem",
  zValidator("json", SignupCodeRedeemSchema),
  async (c) => {
    const input = c.req.valid("json");
    const normalizedEmail = input.email.toLowerCase();
    const code = await c.env.CONTROL_DB.prepare(
      `SELECT id, email, expires_at, consumed_at, revoked_at
       FROM signup_codes WHERE token_hash = ? LIMIT 1`,
    ).bind(await sha256(input.code)).first<{
      id: string;
      email: string;
      expires_at: string;
      consumed_at: string | null;
      revoked_at: string | null;
    }>();
    if (!code || code.consumed_at || code.revoked_at || Date.parse(code.expires_at) <= Date.now()) {
      throw new ApiError(410, "signup_code_expired", "This signup code is invalid or expired.");
    }
    if (code.email.toLowerCase() !== normalizedEmail) {
      throw new ApiError(403, "signup_email_mismatch", "This signup code belongs to another email.");
    }

    const existing = await c.env.CONTROL_DB.prepare(
      `SELECT user.id, user.status, credential.iterations, credential.salt,
        credential.password_hash
       FROM users user
       JOIN password_credentials credential ON credential.user_id = user.id
       WHERE user.email = ? COLLATE NOCASE`,
    ).bind(normalizedEmail).first<ExistingUserRow>();
    let userId: string;
    const now = nowIso();
    const statements: D1PreparedStatement[] = [];
    if (existing) {
      if (
        existing.status !== "active" ||
        !(await verifyPassword(input.password, existing.salt, existing.iterations, existing.password_hash))
      ) {
        throw new ApiError(401, "invalid_credentials", "The password for this email is incorrect.");
      }
      userId = existing.id;
    } else {
      userId = crypto.randomUUID();
      const credential = await hashPassword(input.password);
      statements.push(
        c.env.CONTROL_DB.prepare(
          `INSERT INTO users (id, email, display_name, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        ).bind(userId, normalizedEmail, input.displayName, now, now),
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

    const workspaceId = crypto.randomUUID();
    const managed = String(c.env.PAYMENT_MODE) !== "disabled";
    const workspaceStatus = managed ? "pending_payment" : "active";
    const cycle = monthCycle();
    statements.push(
      c.env.CONTROL_DB.prepare(
        `INSERT INTO workspaces (
          id, name, public_base_url, monthly_run_cap, timezone, status, plan_key,
          signup_code_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        workspaceId,
        input.workspaceName,
        requestPublicAppOrigin(c.env, c.req.url),
        PLAN_ENTITLEMENTS.starter.monthlyUnits,
        input.timezone,
        workspaceStatus,
        managed ? "starter" : "self_hosted",
        code.id,
        now,
        now,
      ),
      c.env.CONTROL_DB.prepare(
        `INSERT INTO memberships (workspace_id, user_id, role, status, created_at)
         VALUES (?, ?, 'owner', 'active', ?)`,
      ).bind(workspaceId, userId, now),
      c.env.CONTROL_DB.prepare(
        `INSERT INTO billing_accounts (
          workspace_id, provider, payment_mode, stripe_livemode, plan_key, status, monthly_units,
          project_limit, prompt_limit, source_limit,
          cycle_started_at, cycle_ends_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        workspaceId,
        managed ? "stripe" : "self_hosted",
        String(c.env.PAYMENT_MODE),
        managed ? (stripeLivemode(c.env) ? 1 : 0) : null,
        managed ? "starter" : "self_hosted",
        managed ? "pending" : "active",
        managed ? PLAN_ENTITLEMENTS.starter.monthlyUnits : Number(c.env.DEFAULT_MONTHLY_RUN_CAP),
        managed ? PLAN_ENTITLEMENTS.starter.projectLimit : 1_000_000,
        managed ? PLAN_ENTITLEMENTS.starter.promptLimit : 1_000_000,
        managed ? PLAN_ENTITLEMENTS.starter.sourceLimit : 4,
        cycle.start,
        cycle.end,
        now,
        now,
      ),
      c.env.CONTROL_DB.prepare(
        `UPDATE signup_codes SET consumed_at = ?, consumed_by_user_id = ?, workspace_id = ?
         WHERE id = ? AND consumed_at IS NULL`,
      ).bind(now, userId, workspaceId, code.id),
    );
    await c.env.CONTROL_DB.batch(statements);
    await syncUsageEntitlement(c.env, workspaceId);
    await createSession(c, userId, workspaceId);
    return c.json({ data: { workspaceId, checkoutRequired: managed } }, 201);
  },
);

onboardingRoutes.delete(
  "/operator/workspaces/:id/billing/plan-change",
  zValidator("param", OperatorWorkspaceParamSchema),
  async (c) => {
    await assertOperator(c);
    const { id } = c.req.valid("param");
    const cancelled = await cancelWorkspaceBillingPlanChange(c.env, id);
    return c.json({ data: { id, cancelled } });
  },
);

onboardingRoutes.post(
  "/operator/signup-codes",
  zValidator("json", SignupCodeCreateSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const input = c.req.valid("json");
    const token = randomToken();
    const id = crypto.randomUUID();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO signup_codes (
        id, email, token_hash, expires_at, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.email.toLowerCase(),
      await sha256(token),
      expiresAt,
      principal.userId,
      now,
    ).run();
    const signupUrl = `${requestPublicAppOrigin(c.env, c.req.url)}/signup?code=${encodeURIComponent(token)}&email=${encodeURIComponent(input.email.toLowerCase())}`;
    return c.json({ data: { id, signupUrl, expiresAt } }, 201);
  },
);

onboardingRoutes.get("/operator/signup-codes", async (c) => {
  await assertOperator(c);
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT id, email, expires_at, consumed_at, revoked_at, workspace_id, created_at
     FROM signup_codes ORDER BY created_at DESC LIMIT 200`,
  ).all();
  return c.json({ data: rows.results });
});

onboardingRoutes.delete(
  "/operator/signup-codes/:id",
  zValidator("param", OperatorSignupCodeParamSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const code = await c.env.CONTROL_DB.prepare(
      "SELECT consumed_at, revoked_at FROM signup_codes WHERE id = ?",
    ).bind(id).first<{ consumed_at: string | null; revoked_at: string | null }>();
    if (!code) throw new ApiError(404, "signup_code_not_found", "Signup code not found.");
    if (code.consumed_at) throw new ApiError(409, "signup_code_consumed", "A redeemed signup code cannot be revoked.");
    if (!code.revoked_at) {
      const revokedAt = nowIso();
      await c.env.CONTROL_DB.prepare(
        "UPDATE signup_codes SET revoked_at = ?, revoked_by_user_id = ? WHERE id = ? AND revoked_at IS NULL",
      ).bind(revokedAt, principal.userId, id).run();
      await writeAudit(c.env.CONTROL_DB, {
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        action: "operator.signup_code_revoked",
        resourceType: "signup_code",
        resourceId: id,
      });
    }
    return c.json({ data: { id, revoked: true } });
  },
);

onboardingRoutes.get("/operator/workspaces", async (c) => {
  await assertOperator(c);
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT workspace.id, workspace.name, workspace.status, workspace.plan_key,
      billing.status AS subscription_status, billing.monthly_units,
      billing.project_limit, billing.prompt_limit, billing.source_limit,
      billing.stripe_livemode,
      billing.cycle_started_at, billing.cycle_ends_at,
      COUNT(DISTINCT membership.user_id) AS seats,
      COUNT(DISTINCT project.id) AS projects,
      COUNT(DISTINCT CASE WHEN query.is_active = 1 AND query.deleted_at IS NULL THEN query.id END) AS prompts
     FROM workspaces workspace
     LEFT JOIN billing_accounts billing ON billing.workspace_id = workspace.id
     LEFT JOIN memberships membership
       ON membership.workspace_id = workspace.id AND membership.status = 'active'
     LEFT JOIN projects project
       ON project.workspace_id = workspace.id AND project.deleted_at IS NULL
      AND project.archived_at IS NULL
     LEFT JOIN tracked_queries query ON query.project_id = project.id
     GROUP BY workspace.id
     ORDER BY workspace.created_at DESC`,
  ).all();
  return c.json({ data: rows.results });
});

onboardingRoutes.patch(
  "/operator/workspaces/:id",
  zValidator("param", OperatorWorkspaceParamSchema),
  zValidator("json", OperatorWorkspaceUpdateSchema),
  async (c) => {
    await assertOperator(c);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT workspace.status, workspace.plan_key, billing.monthly_units, billing.project_limit,
        billing.prompt_limit, billing.source_limit,
        billing.payment_mode
       FROM workspaces workspace
       JOIN billing_accounts billing ON billing.workspace_id = workspace.id
       WHERE workspace.id = ?`,
    ).bind(id).first<{
      status: string;
      plan_key: string;
      monthly_units: number;
      project_limit: number;
      prompt_limit: number;
      source_limit: number;
      payment_mode: string;
    }>();
    if (!current) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
    if (
      (current.payment_mode === "stripe_direct" || current.payment_mode === "stripe_managed") &&
      (input.planKey !== undefined || input.monthlyUnits !== undefined || input.projectLimit !== undefined)
    ) {
      throw new ApiError(
        409,
        "stripe_is_billing_authority",
        "Stripe-backed plan and allowance fields must be changed through the billing flow.",
      );
    }
    const planKey = input.planKey ?? current.plan_key;
    const predefined = planKey === "starter" || planKey === "studio" || planKey === "agency"
      ? PLAN_ENTITLEMENTS[planKey]
      : null;
    const monthlyUnits = input.monthlyUnits ?? predefined?.monthlyUnits ?? current.monthly_units;
    const projectLimit = input.projectLimit ?? predefined?.projectLimit ?? current.project_limit;
    const promptLimit = predefined?.promptLimit ?? current.prompt_limit;
    const sourceLimit = predefined?.sourceLimit ?? current.source_limit;
    const status = input.status ?? current.status;
    const subscriptionStatus = status === "active" ? "active" : status === "pending_payment" ? "pending" : "paused";
    const now = nowIso();
    await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        "UPDATE workspaces SET status = ?, plan_key = ?, updated_at = ? WHERE id = ?",
      ).bind(status, planKey, now, id),
      c.env.CONTROL_DB.prepare(
        `UPDATE billing_accounts SET status = ?, plan_key = ?, monthly_units = ?,
          project_limit = ?, prompt_limit = ?, source_limit = ?,
          updated_at = ? WHERE workspace_id = ?`,
      ).bind(
        subscriptionStatus,
        planKey,
        monthlyUnits,
        projectLimit,
        promptLimit,
        sourceLimit,
        now,
        id,
      ),
    ]);
    const usage = await syncUsageEntitlement(c.env, id);
    return c.json({ data: { id, status, planKey, monthlyUnits, projectLimit, promptLimit, sourceLimit, usage } });
  },
);

onboardingRoutes.post(
  "/operator/workspaces/:id/billing/reconcile",
  zValidator("param", OperatorWorkspaceParamSchema),
  async (c) => {
    await assertOperator(c);
    const { id } = c.req.valid("param");
    const result = await reconcileWorkspaceBilling(c.env, id);
    await syncUsageEntitlement(c.env, id);
    return c.json({ data: result });
  },
);
