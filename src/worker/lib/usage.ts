import type {
  PlanKey,
  SubscriptionStatus,
  UsageSku,
  WorkspaceStatus,
} from "../../shared/contracts";
import type {
  UsageEntitlement,
  UsageReservationInput,
  UsageReservationResult,
  UsageSummary,
  WorkspaceUsageGate,
} from "../durable-objects/workspace-usage-gate";
import { ApiError, nowIso } from "./http";

export const PLAN_ENTITLEMENTS = {
  starter: { monthlyUnits: 1_000, projectLimit: 1 },
  studio: { monthlyUnits: 5_000, projectLimit: 5 },
  agency: { monthlyUnits: 30_000, projectLimit: 30 },
} as const;

export const BILLING_PLANS = {
  starter: { rank: 0, priceEur: 10, ...PLAN_ENTITLEMENTS.starter },
  studio: { rank: 1, priceEur: 29, ...PLAN_ENTITLEMENTS.studio },
  agency: { rank: 2, priceEur: 149, ...PLAN_ENTITLEMENTS.agency },
} as const;

export const USAGE_UNITS: Record<UsageSku, number> = {
  llm_standard: 1,
  llm_priority_html: 2,
  llm_live: 4,
  entity_extraction: 1,
  product_enrichment: 1,
};

interface BillingEntitlementRow {
  plan_key: PlanKey;
  status: SubscriptionStatus;
  monthly_units: number;
  project_limit: number;
  cycle_started_at: string;
  cycle_ends_at: string;
  read_only_until: string | null;
  workspace_status: WorkspaceStatus;
  pending_plan_key: PlanKey | null;
}

function gate(env: Env, workspaceId: string): DurableObjectStub<WorkspaceUsageGate> {
  return env.WORKSPACE_USAGE.getByName(workspaceId);
}

function currentUtcMonth(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function syncUsageEntitlement(env: Env, workspaceId: string): Promise<UsageSummary> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT billing.plan_key, billing.status, billing.monthly_units, billing.project_limit,
      billing.cycle_started_at, billing.cycle_ends_at, billing.read_only_until,
      workspace.status AS workspace_status, pending.to_plan_key AS pending_plan_key
     FROM billing_accounts billing
     JOIN workspaces workspace ON workspace.id = billing.workspace_id
     LEFT JOIN billing_plan_changes pending
       ON pending.workspace_id = billing.workspace_id
      AND pending.status IN ('creating', 'updating', 'scheduled', 'releasing')
     WHERE billing.workspace_id = ?`,
  )
    .bind(workspaceId)
    .first<BillingEntitlementRow>();
  if (!row) throw new ApiError(500, "entitlement_not_configured", "Workspace usage is not configured.");

  let cycleStartedAt = row.cycle_started_at;
  let cycleEndsAt = row.cycle_ends_at;
  if (row.plan_key === "self_hosted" && Date.parse(cycleEndsAt) <= Date.now()) {
    const cycle = currentUtcMonth();
    cycleStartedAt = cycle.start;
    cycleEndsAt = cycle.end;
    await env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET cycle_started_at = ?, cycle_ends_at = ?, updated_at = ?
       WHERE workspace_id = ?`,
    ).bind(cycleStartedAt, cycleEndsAt, nowIso(), workspaceId).run();
  }

  const pendingEntitlement = row.pending_plan_key === "starter" ||
    row.pending_plan_key === "studio" || row.pending_plan_key === "agency"
    ? PLAN_ENTITLEMENTS[row.pending_plan_key]
    : null;
  const entitlement: UsageEntitlement = {
    planKey: row.plan_key,
    subscriptionStatus: row.status,
    workspaceStatus: row.workspace_status,
    allowance: Number(row.monthly_units),
    projectLimit: Math.min(Number(row.project_limit), pendingEntitlement?.projectLimit ?? Number(row.project_limit)),
    cycleStartedAt,
    cycleEndsAt,
    readOnlyUntil: row.read_only_until,
  };
  const stub = gate(env, workspaceId);
  await stub.setEntitlement(entitlement);
  const count = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM projects WHERE workspace_id = ? AND deleted_at IS NULL",
  ).bind(workspaceId).first<{ count: number }>();
  return stub.syncProjectCount(Number(count?.count ?? 0));
}

function usageError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("usage_limit")) {
    return new ApiError(402, "usage_limit", "This workspace has used its monthly allowance.");
  }
  if (message.includes("project_limit")) {
    return new ApiError(402, "project_limit", "This workspace has reached its project limit.");
  }
  if (message.includes("payment_required") || message.includes("billing_cycle_inactive")) {
    return new ApiError(402, "payment_required", "An active subscription is required.");
  }
  if (message.includes("workspace_read_only")) {
    return new ApiError(403, "read_only", "This workspace is read-only.");
  }
  return new ApiError(503, "usage_gate_unavailable", "Usage could not be authorized. Try again.");
}

async function mirror(
  env: Env,
  workspaceId: string,
  input: UsageReservationInput,
  result: UsageReservationResult,
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO usage_events (
      id, workspace_id, reservation_id, sku, units, status, resource_type,
      resource_id, cycle_started_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    workspaceId,
    input.reservationId,
    input.sku,
    input.units,
    result.status,
    input.resourceType,
    input.resourceId,
    result.cycleStartedAt,
    nowIso(),
  ).run();
}

export async function reserveUsage(
  env: Env,
  workspaceId: string,
  input: UsageReservationInput,
): Promise<UsageReservationResult> {
  try {
    await syncUsageEntitlement(env, workspaceId);
    const result = await gate(env, workspaceId).reserve(input);
    await mirror(env, workspaceId, input, result);
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw usageError(error);
  }
}

export async function commitUsage(
  env: Env,
  workspaceId: string,
  input: UsageReservationInput,
): Promise<UsageReservationResult> {
  try {
    const result = await gate(env, workspaceId).commit(input.reservationId);
    await mirror(env, workspaceId, input, result);
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw usageError(error);
  }
}

export async function releaseUsage(
  env: Env,
  workspaceId: string,
  input: UsageReservationInput,
): Promise<UsageReservationResult> {
  try {
    const result = await gate(env, workspaceId).release(input.reservationId);
    await mirror(env, workspaceId, input, result);
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw usageError(error);
  }
}

export async function getUsageSummary(env: Env, workspaceId: string): Promise<UsageSummary> {
  try {
    return await syncUsageEntitlement(env, workspaceId);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw usageError(error);
  }
}

export async function claimProjectSlot(env: Env, workspaceId: string): Promise<void> {
  try {
    await syncUsageEntitlement(env, workspaceId);
    await gate(env, workspaceId).claimProject();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw usageError(error);
  }
}

export async function releaseProjectSlot(env: Env, workspaceId: string): Promise<void> {
  try {
    await gate(env, workspaceId).releaseProject();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "project_slot_release_failed",
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
