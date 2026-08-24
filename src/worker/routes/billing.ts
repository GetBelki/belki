import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import {
  BillingCancellationSchema,
  BillingCheckoutSchema,
  BillingPlanChangeSchema,
  BillingPlanChangePreviewSchema,
  type PlanKey,
  type SubscriptionStatus,
  type TrackingSource,
  type UsageSku,
} from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import { writeAudit } from "../lib/audit";
import { requireRole } from "../lib/auth";
import { ApiError, jsonParse, nowIso } from "../lib/http";
import {
  assertStripeLivemode,
  optionalBinding,
  stripeEnvironment,
  stripeLivemode,
  stripeRequest,
} from "../lib/stripe";
import {
  BILLING_PLANS,
  getUsageSummary,
  PLAN_ENTITLEMENTS,
  releaseUsage,
  syncUsageEntitlement,
} from "../lib/usage";
import { availableSources, planSourceEntitlement } from "../lib/tracking-sources";
import { verifyStripeSignature } from "../lib/stripe-signature";
import { workspacePublicAppOrigin } from "../lib/public-origin";

const MAX_STRIPE_WEBHOOK_BYTES = 1024 * 1024;
const RENEWAL_CHANGE_CUTOFF_MS = 5 * 60 * 1000;
const UPGRADE_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const PLAN_KEYS = ["starter", "studio", "agency"] as const;

type ManagedPlanKey = typeof PLAN_KEYS[number];

interface BillingAccountRow {
  workspace_id: string;
  payment_mode: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  stripe_subscription_schedule_id: string | null;
  stripe_livemode: number | null;
  plan_key: PlanKey;
  status: SubscriptionStatus;
  monthly_units: number;
  project_limit: number;
  prompt_limit: number;
  source_limit: number;
  cycle_started_at: string;
  cycle_ends_at: string;
  cancel_at_period_end: number;
  read_only_until: string | null;
  billing_synced_at: string | null;
  billing_sync_error: string | null;
}

interface PlanChangeRow {
  id: string;
  workspace_id: string;
  requested_by_user_id: string | null;
  kind: "upgrade" | "downgrade";
  status: string;
  from_plan_key: ManagedPlanKey;
  to_plan_key: ManagedPlanKey;
  stripe_subscription_id: string;
  stripe_subscription_item_id: string | null;
  stripe_portal_session_id: string | null;
  stripe_subscription_schedule_id: string | null;
  effective_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  transition_json: string | null;
}

interface PlanTransitionPreview {
  targetPlanKey: ManagedPlanKey;
  effectiveAt: string;
  retainedProjectIds: string[];
  archivedProjects: Array<{ id: string; name: string }>;
  activePromptCount: number;
  pausedPromptCount: number;
  sourceChanges: Array<{
    projectId: string;
    projectName: string;
    current: string[];
    next: string[];
  }>;
}

interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  itemId: string;
  priceId: string;
  planKey: ManagedPlanKey;
  quantity: number;
  status: SubscriptionStatus;
  rawStatus: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  currentPeriodStartUnix: number;
  currentPeriodEndUnix: number;
  cancelAtPeriodEnd: boolean;
  scheduleId: string | null;
  hasTrial: boolean;
  hasDiscount: boolean;
  hasAutomaticTax: boolean;
  object: Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function eventSubscriptionId(object: Record<string, unknown>): string | null {
  const direct = typeof object.subscription === "string"
    ? object.subscription
    : stringValue(objectValue(object.subscription).id);
  if (direct) return direct;
  const details = objectValue(objectValue(objectValue(object.parent).subscription_details));
  return typeof details.subscription === "string"
    ? details.subscription
    : stringValue(objectValue(details.subscription).id);
}

function unixIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 86_400_000).toISOString();
}

function managedPlan(value: PlanKey): ManagedPlanKey | null {
  return value === "starter" || value === "studio" || value === "agency" ? value : null;
}

function priceId(env: Env, planKey: ManagedPlanKey): string {
  const value = optionalBinding(env, `STRIPE_${planKey.toUpperCase()}_PRICE_ID`);
  if (!value) throw new ApiError(503, "billing_not_configured", `The ${planKey} Stripe Price is not configured.`);
  return value;
}

function planFromPrice(env: Env, stripePriceId: string): ManagedPlanKey | null {
  return PLAN_KEYS.find((key) => optionalBinding(env, `STRIPE_${key.toUpperCase()}_PRICE_ID`) === stripePriceId) ?? null;
}

function planChangesEnabled(env: Env): boolean {
  return optionalBinding(env, "BILLING_PLAN_CHANGES_ENABLED") === "true";
}

async function planTransitionPreview(
  env: Env,
  workspaceId: string,
  target: ManagedPlanKey,
  effectiveAt: string,
  preferredProjectIds: string[] = [],
): Promise<PlanTransitionPreview> {
  const entitlement = PLAN_ENTITLEMENTS[target];
  const projects = await env.CONTROL_DB.prepare(
    `SELECT id, name FROM projects
     WHERE workspace_id = ? AND deleted_at IS NULL AND archived_at IS NULL
     ORDER BY updated_at DESC, created_at DESC, id`,
  ).bind(workspaceId).all<{ id: string; name: string }>();
  const preferred = new Map(preferredProjectIds.map((id, index) => [id, index]));
  const ordered = [...projects.results].sort((left, right) => {
    const leftRank = preferred.get(left.id);
    const rightRank = preferred.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }
    return projects.results.indexOf(left) - projects.results.indexOf(right);
  });
  const retained = ordered.slice(0, entitlement.projectLimit);
  const archivedProjects = ordered.slice(entitlement.projectLimit);
  const retainedIds = retained.map((project) => project.id);
  let activePromptCount = 0;
  if (retainedIds.length) {
    const placeholders = retainedIds.map(() => "?").join(",");
    const promptCount = await env.CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count FROM tracked_queries
       WHERE project_id IN (${placeholders}) AND deleted_at IS NULL AND is_active = 1`,
    ).bind(...retainedIds).first<{ count: number }>();
    activePromptCount = Number(promptCount?.count ?? 0);
  }
  let promptsInArchivedProjects = 0;
  if (archivedProjects.length) {
    const placeholders = archivedProjects.map(() => "?").join(",");
    const promptCount = await env.CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count FROM tracked_queries
       WHERE project_id IN (${placeholders}) AND deleted_at IS NULL AND is_active = 1`,
    ).bind(...archivedProjects.map((project) => project.id)).first<{ count: number }>();
    promptsInArchivedProjects = Number(promptCount?.count ?? 0);
  }
  const sourceEntitlement = planSourceEntitlement(target);
  const sourceChanges: PlanTransitionPreview["sourceChanges"] = [];
  for (const project of retained) {
    const rows = await env.CONTROL_DB.prepare(
      `SELECT source FROM project_tracking_sources
       WHERE project_id = ? AND enabled = 1
       ORDER BY CASE source WHEN 'chatgpt' THEN 0 WHEN 'gemini' THEN 1
         WHEN 'google_ai_mode' THEN 2 ELSE 3 END`,
    ).bind(project.id).all<{ source: TrackingSource }>();
    const current = rows.results.map((row) => row.source);
    let next = current
      .filter((source) => sourceEntitlement.allowedSources.includes(source))
      .slice(0, entitlement.sourceLimit);
    if (!next.length) next = ["chatgpt"];
    if (current.join("|") !== next.join("|")) {
      sourceChanges.push({
        projectId: project.id,
        projectName: project.name,
        current,
        next,
      });
    }
  }
  return {
    targetPlanKey: target,
    effectiveAt,
    retainedProjectIds: retainedIds,
    archivedProjects,
    activePromptCount: Math.min(activePromptCount, entitlement.promptLimit),
    pausedPromptCount:
      promptsInArchivedProjects + Math.max(0, activePromptCount - entitlement.promptLimit),
    sourceChanges,
  };
}

async function applyPlanTransition(
  env: Env,
  workspaceId: string,
  target: ManagedPlanKey,
  effectiveAt: string,
  storedTransition: string | null,
): Promise<PlanTransitionPreview> {
  const stored = jsonParse<Partial<PlanTransitionPreview>>(storedTransition ?? "{}", {});
  const transition = await planTransitionPreview(
    env,
    workspaceId,
    target,
    effectiveAt,
    Array.isArray(stored.retainedProjectIds) ? stored.retainedProjectIds : [],
  );
  const entitlement = PLAN_ENTITLEMENTS[target];
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (transition.archivedProjects.length) {
    const ids = transition.archivedProjects.map((project) => project.id);
    const placeholders = ids.map(() => "?").join(",");
    statements.push(
      env.CONTROL_DB.prepare(
        `UPDATE projects SET archived_at = ?, updated_at = ?
         WHERE id IN (${placeholders}) AND workspace_id = ? AND deleted_at IS NULL`,
      ).bind(now, now, ...ids, workspaceId),
      env.CONTROL_DB.prepare(
        `UPDATE tracked_queries SET is_active = 0, updated_at = ?
         WHERE project_id IN (${placeholders}) AND deleted_at IS NULL`,
      ).bind(now, ...ids),
    );
  }
  if (transition.retainedProjectIds.length) {
    const placeholders = transition.retainedProjectIds.map(() => "?").join(",");
    const keep = await env.CONTROL_DB.prepare(
      `SELECT id FROM tracked_queries
       WHERE project_id IN (${placeholders}) AND deleted_at IS NULL AND is_active = 1
       ORDER BY updated_at DESC, created_at DESC, id
       LIMIT ?`,
    ).bind(...transition.retainedProjectIds, entitlement.promptLimit)
      .all<{ id: string }>();
    const keepIds = keep.results.map((row) => row.id);
    if (keepIds.length) {
      const keepPlaceholders = keepIds.map(() => "?").join(",");
      statements.push(env.CONTROL_DB.prepare(
        `UPDATE tracked_queries SET is_active = 0, updated_at = ?
         WHERE project_id IN (${placeholders}) AND deleted_at IS NULL AND is_active = 1
           AND id NOT IN (${keepPlaceholders})`,
      ).bind(now, ...transition.retainedProjectIds, ...keepIds));
    } else {
      statements.push(env.CONTROL_DB.prepare(
        `UPDATE tracked_queries SET is_active = 0, updated_at = ?
         WHERE project_id IN (${placeholders}) AND deleted_at IS NULL AND is_active = 1`,
      ).bind(now, ...transition.retainedProjectIds));
    }
  }
  for (const change of transition.sourceChanges) {
    statements.push(...(["chatgpt", "gemini", "google_ai_mode", "google_ai_overview"] as TrackingSource[])
      .map((source) => env.CONTROL_DB.prepare(
        `INSERT INTO project_tracking_sources (project_id, source, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, source) DO UPDATE SET
           enabled = excluded.enabled, updated_at = excluded.updated_at`,
      ).bind(
        change.projectId,
        source,
        change.next.includes(source) ? 1 : 0,
        now,
        now,
      )));
  }
  if (statements.length) await env.CONTROL_DB.batch(statements);

  const queued = await env.CONTROL_DB.prepare(
    `SELECT job.id, job.workspace_id, job.usage_reservation_id, job.usage_units,
      job.delivery_method
     FROM crawl_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     JOIN projects project ON project.id = job.project_id
     LEFT JOIN project_tracking_sources source
       ON source.project_id = job.project_id AND source.source = job.tracking_source
     WHERE job.workspace_id = ? AND job.status = 'queued'
       AND (project.archived_at IS NOT NULL OR query.is_active = 0 OR COALESCE(source.enabled, 0) = 0)`,
  ).bind(workspaceId).all<{
    id: string;
    workspace_id: string;
    usage_reservation_id: string | null;
    usage_units: number;
    delivery_method: "standard" | "standard_priority" | "live";
  }>();
  if (queued.results.length) {
    const ids = queued.results.map((job) => job.id);
    const placeholders = ids.map(() => "?").join(",");
    await env.CONTROL_DB.prepare(
      `UPDATE crawl_jobs SET status = 'cancelled', error_code = 'plan_transition',
        error_message = 'Cancelled when the workspace plan changed.', updated_at = ?
       WHERE id IN (${placeholders}) AND status = 'queued'`,
    ).bind(now, ...ids).run();
    await Promise.all(queued.results.map(async (job) => {
      if (!job.usage_reservation_id || job.usage_units <= 0) return;
      const sku: UsageSku = job.delivery_method === "live"
        ? "llm_live"
        : job.delivery_method === "standard_priority"
          ? "llm_priority_html"
          : "llm_standard";
      await releaseUsage(env, workspaceId, {
        reservationId: job.usage_reservation_id,
        sku,
        units: job.usage_units,
        resourceType: "crawl_job",
        resourceId: job.id,
      });
    }));
  }
  return transition;
}

function assertAccountStripeEnvironment(env: Env, billing: BillingAccountRow): void {
  if (billing.payment_mode === "stripe_direct" || billing.payment_mode === "stripe_managed") {
    assertStripeLivemode(env, billing.stripe_livemode);
  }
}

function accountMatchesStripeEnvironment(env: Env, billing: BillingAccountRow): boolean {
  if (billing.payment_mode !== "stripe_direct" && billing.payment_mode !== "stripe_managed") return true;
  return billing.stripe_livemode !== null && Boolean(billing.stripe_livemode) === stripeLivemode(env);
}

function actionPortalConfiguration(env: Env): string {
  const value = optionalBinding(env, "STRIPE_BILLING_ACTION_PORTAL_CONFIGURATION_ID");
  if (!value) throw new ApiError(503, "billing_not_configured", "The Stripe billing action portal is not configured.");
  return value;
}

function normalizeSubscriptionStatus(value: string | null): SubscriptionStatus {
  switch (value) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "paused":
      return value;
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

async function account(env: Env, workspaceId: string): Promise<BillingAccountRow> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT workspace_id, payment_mode, stripe_customer_id, stripe_subscription_id,
      stripe_subscription_item_id, stripe_subscription_schedule_id, plan_key, status,
      stripe_livemode,
      monthly_units, project_limit, prompt_limit, source_limit,
      cycle_started_at, cycle_ends_at,
      cancel_at_period_end, read_only_until, billing_synced_at, billing_sync_error
     FROM billing_accounts WHERE workspace_id = ?`,
  ).bind(workspaceId).first<BillingAccountRow>();
  if (!row) throw new ApiError(500, "billing_account_not_found", "Billing account not found.");
  return row;
}

async function billingPublicAppOrigin(env: Env, workspaceId: string): Promise<string> {
  const workspace = await env.CONTROL_DB.prepare(
    "SELECT public_base_url FROM workspaces WHERE id = ?",
  ).bind(workspaceId).first<{ public_base_url: string }>();
  if (!workspace) throw new ApiError(500, "workspace_not_found", "Workspace not found.");
  return workspacePublicAppOrigin(env, workspace.public_base_url);
}

async function accountBySubscription(env: Env, subscriptionId: string): Promise<BillingAccountRow | null> {
  return env.CONTROL_DB.prepare(
    `SELECT workspace_id, payment_mode, stripe_customer_id, stripe_subscription_id,
      stripe_subscription_item_id, stripe_subscription_schedule_id, plan_key, status,
      stripe_livemode,
      monthly_units, project_limit, prompt_limit, source_limit,
      cycle_started_at, cycle_ends_at,
      cancel_at_period_end, read_only_until, billing_synced_at, billing_sync_error
     FROM billing_accounts WHERE stripe_subscription_id = ?`,
  ).bind(subscriptionId).first<BillingAccountRow>();
}

async function activePlanChange(env: Env, workspaceId: string): Promise<PlanChangeRow | null> {
  return env.CONTROL_DB.prepare(
    `SELECT * FROM billing_plan_changes
     WHERE workspace_id = ? AND status IN ('creating', 'updating', 'scheduled', 'releasing')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(workspaceId).first<PlanChangeRow>();
}

async function pendingUpgrade(env: Env, workspaceId: string, target: ManagedPlanKey): Promise<PlanChangeRow | null> {
  return env.CONTROL_DB.prepare(
    `SELECT * FROM billing_plan_changes
     WHERE workspace_id = ? AND kind = 'upgrade' AND status = 'pending_customer'
       AND to_plan_key = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(workspaceId, target).first<PlanChangeRow>();
}

async function setSyncError(env: Env, workspaceId: string, error: string | null): Promise<void> {
  await env.CONTROL_DB.prepare(
    "UPDATE billing_accounts SET billing_sync_error = ?, updated_at = ? WHERE workspace_id = ?",
  ).bind(error, nowIso(), workspaceId).run();
}

async function stripeSubscription(env: Env, subscriptionId: string): Promise<Record<string, unknown>> {
  return stripeRequest(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

function subscriptionSnapshot(env: Env, object: Record<string, unknown>): SubscriptionSnapshot {
  if (typeof object.livemode !== "boolean") {
    throw new ApiError(409, "unsupported_subscription", "Stripe subscription data is missing its environment marker.");
  }
  assertStripeLivemode(env, object.livemode);
  const id = stringValue(object.id);
  const customer = typeof object.customer === "string"
    ? object.customer
    : stringValue(objectValue(object.customer).id);
  const items = arrayValue(objectValue(object.items).data);
  if (!id || !customer || items.length !== 1) {
    throw new ApiError(409, "unsupported_subscription", "Belki requires exactly one Stripe subscription item.");
  }
  const item = objectValue(items[0]);
  const itemId = stringValue(item.id);
  const price = objectValue(item.price);
  const stripePriceId = stringValue(price.id);
  const planKey = stripePriceId ? planFromPrice(env, stripePriceId) : null;
  const start = numberValue(item.current_period_start ?? object.current_period_start);
  const end = numberValue(item.current_period_end ?? object.current_period_end);
  if (!itemId || !stripePriceId || !planKey || start === null || end === null) {
    throw new ApiError(409, "unsupported_subscription", "Stripe subscription data does not match the Belki plan catalogue.");
  }
  const schedule = typeof object.schedule === "string"
    ? object.schedule
    : stringValue(objectValue(object.schedule).id);
  const discounts = arrayValue(object.discounts ?? objectValue(object.discounts).data);
  return {
    id,
    customerId: customer,
    itemId,
    priceId: stripePriceId,
    planKey,
    quantity: numberValue(item.quantity) ?? 1,
    status: normalizeSubscriptionStatus(stringValue(object.status)),
    rawStatus: stringValue(object.status) ?? "unknown",
    currentPeriodStart: unixIso(start),
    currentPeriodEnd: unixIso(end),
    currentPeriodStartUnix: start,
    currentPeriodEndUnix: end,
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
    scheduleId: schedule,
    hasTrial: numberValue(object.trial_end) !== null || stringValue(object.status) === "trialing",
    hasDiscount: object.discount != null || discounts.length > 0,
    hasAutomaticTax: objectValue(object.automatic_tax).enabled === true,
    object,
  };
}

function assertSupportedPlanChange(snapshot: SubscriptionSnapshot): void {
  if (snapshot.rawStatus !== "active") {
    throw new ApiError(409, "subscription_not_active", "Plan changes require an active paid subscription.");
  }
  if (snapshot.quantity !== 1 || snapshot.hasTrial || snapshot.hasDiscount || !snapshot.hasAutomaticTax) {
    throw new ApiError(409, "unsupported_subscription", "Plan changes support one monthly plan at quantity 1 with automatic tax and without trials or discounts.");
  }
  if (snapshot.cancelAtPeriodEnd) {
    throw new ApiError(409, "subscription_cancelling", "Reactivate the subscription before changing plans.");
  }
}

async function releaseStripeSchedule(env: Env, scheduleId: string, changeId: string): Promise<void> {
  try {
    await stripeRequest(env, `/subscription_schedules/${encodeURIComponent(scheduleId)}/release`, {
      method: "POST",
      idempotencyKey: `belki:${changeId}:release`,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return;
    throw error;
  }
}

async function reconcileSubscriptionObject(
  env: Env,
  object: Record<string, unknown>,
  expectedWorkspaceId?: string,
): Promise<string> {
  let snapshot: SubscriptionSnapshot;
  try {
    snapshot = subscriptionSnapshot(env, object);
  } catch (error) {
    const subscriptionId = stringValue(object.id);
    const metadataWorkspaceId = stringValue(objectValue(object.metadata).workspace_id);
    const linked = subscriptionId ? await accountBySubscription(env, subscriptionId) : null;
    const workspaceId = expectedWorkspaceId ?? linked?.workspace_id ?? metadataWorkspaceId;
    if (workspaceId) await setSyncError(env, workspaceId, error instanceof ApiError ? error.code : "stripe_reconcile_failed");
    throw error;
  }
  const metadataWorkspaceId = stringValue(objectValue(object.metadata).workspace_id);
  const current = expectedWorkspaceId
    ? await account(env, expectedWorkspaceId)
    : await accountBySubscription(env, snapshot.id) ?? (metadataWorkspaceId ? await account(env, metadataWorkspaceId) : null);
  if (!current) throw new ApiError(409, "billing_workspace_missing", "Stripe subscription is not linked to a workspace.");
  assertAccountStripeEnvironment(env, current);
  if (current.stripe_subscription_id && current.stripe_subscription_id !== snapshot.id) {
    throw new ApiError(409, "billing_subscription_mismatch", "Stripe subscription does not match this workspace.");
  }
  if (current.stripe_customer_id && current.stripe_customer_id !== snapshot.customerId) {
    throw new ApiError(409, "billing_customer_mismatch", "Stripe customer does not match this workspace.");
  }
  const entitlement = PLAN_ENTITLEMENTS[snapshot.planKey];
  const now = new Date();
  const active = snapshot.status === "active" || snapshot.status === "trialing";
  const readOnly = snapshot.status === "unpaid" || snapshot.status === "cancelled";
  const workspaceStatus = active ? "active" : readOnly ? "read_only" : "pending_payment";
  const readOnlyUntil = readOnly ? addDays(now, 90) : null;
  const matchingDowngrade = await env.CONTROL_DB.prepare(
    `SELECT * FROM billing_plan_changes
     WHERE workspace_id = ? AND kind = 'downgrade'
       AND status IN ('creating', 'updating', 'scheduled', 'releasing')
       AND to_plan_key = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(current.workspace_id, snapshot.planKey).first<PlanChangeRow>();
  const matchingUpgrade = await pendingUpgrade(env, current.workspace_id, snapshot.planKey);
  const completedAt = now.toISOString();
  const currentManagedPlan = managedPlan(current.plan_key);
  const isDowngrade = currentManagedPlan !== null &&
    BILLING_PLANS[snapshot.planKey].rank < BILLING_PLANS[currentManagedPlan].rank;
  const appliedTransition = isDowngrade || matchingDowngrade
    ? await applyPlanTransition(
        env,
        current.workspace_id,
        snapshot.planKey,
        snapshot.currentPeriodStart,
        matchingDowngrade?.transition_json ?? null,
      )
    : null;
  const statements = [
    env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET stripe_customer_id = ?, stripe_subscription_id = ?,
        stripe_subscription_item_id = ?, stripe_subscription_schedule_id = ?,
        plan_key = ?, status = ?, monthly_units = ?, project_limit = ?,
        prompt_limit = ?, source_limit = ?,
        cycle_started_at = ?, cycle_ends_at = ?, cancel_at_period_end = ?,
        read_only_until = ?, billing_synced_at = ?, billing_sync_error = NULL, updated_at = ?
       WHERE workspace_id = ?`,
    ).bind(
      snapshot.customerId,
      snapshot.id,
      snapshot.itemId,
      snapshot.scheduleId,
      snapshot.planKey,
      snapshot.status,
      entitlement.monthlyUnits,
      entitlement.projectLimit,
      entitlement.promptLimit,
      entitlement.sourceLimit,
      snapshot.currentPeriodStart,
      snapshot.currentPeriodEnd,
      snapshot.cancelAtPeriodEnd ? 1 : 0,
      readOnlyUntil,
      completedAt,
      completedAt,
      current.workspace_id,
    ),
    env.CONTROL_DB.prepare(
      "UPDATE workspaces SET status = ?, plan_key = ?, read_only_until = ?, updated_at = ? WHERE id = ?",
    ).bind(workspaceStatus, snapshot.planKey, readOnlyUntil, completedAt, current.workspace_id),
  ];
  if (matchingDowngrade) {
    statements.push(env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'applied', completed_at = ?, updated_at = ?,
        stripe_subscription_item_id = ?, transition_json = ? WHERE id = ?`,
    ).bind(
      completedAt,
      completedAt,
      snapshot.itemId,
      JSON.stringify(appliedTransition),
      matchingDowngrade.id,
    ));
  }
  if (matchingUpgrade) {
    statements.push(env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'applied', completed_at = ?, updated_at = ?,
        stripe_subscription_item_id = ? WHERE id = ?`,
    ).bind(completedAt, completedAt, snapshot.itemId, matchingUpgrade.id));
    statements.push(env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'expired', completed_at = ?, updated_at = ?
       WHERE workspace_id = ? AND kind = 'upgrade' AND status = 'pending_customer' AND id != ?`,
    ).bind(completedAt, completedAt, current.workspace_id, matchingUpgrade.id));
  }
  await env.CONTROL_DB.batch(statements);
  await syncUsageEntitlement(env, current.workspace_id);
  if (matchingDowngrade?.stripe_subscription_schedule_id && snapshot.planKey === matchingDowngrade.to_plan_key) {
    await releaseStripeSchedule(env, matchingDowngrade.stripe_subscription_schedule_id, matchingDowngrade.id);
    await env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET stripe_subscription_schedule_id = NULL, updated_at = ?
       WHERE workspace_id = ? AND stripe_subscription_schedule_id = ?`,
    ).bind(nowIso(), current.workspace_id, matchingDowngrade.stripe_subscription_schedule_id).run();
  }
  return current.workspace_id;
}

async function reconcileSubscription(env: Env, subscriptionId: string, workspaceId?: string): Promise<string> {
  try {
    return await reconcileSubscriptionObject(env, await stripeSubscription(env, subscriptionId), workspaceId);
  } catch (error) {
    if (workspaceId) await setSyncError(env, workspaceId, error instanceof ApiError ? error.code : "stripe_reconcile_failed");
    throw error;
  }
}

async function reconcileDeletedSubscription(env: Env, object: Record<string, unknown>): Promise<string | null> {
  const subscriptionId = stringValue(object.id);
  if (!subscriptionId) return null;
  const current = await accountBySubscription(env, subscriptionId);
  if (!current) return null;
  assertAccountStripeEnvironment(env, current);
  const now = new Date();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET status = 'cancelled', cancel_at_period_end = 0,
        stripe_subscription_schedule_id = NULL, read_only_until = ?, billing_synced_at = ?,
        billing_sync_error = NULL, updated_at = ? WHERE workspace_id = ?`,
    ).bind(addDays(now, 90), now.toISOString(), now.toISOString(), current.workspace_id),
    env.CONTROL_DB.prepare(
      `UPDATE workspaces SET status = 'read_only', read_only_until = ?, updated_at = ? WHERE id = ?`,
    ).bind(addDays(now, 90), now.toISOString(), current.workspace_id),
    env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'cancelled', completed_at = ?, updated_at = ?
       WHERE workspace_id = ? AND status IN ('creating', 'updating', 'scheduled', 'releasing', 'pending_customer')`,
    ).bind(now.toISOString(), now.toISOString(), current.workspace_id),
  ]);
  await syncUsageEntitlement(env, current.workspace_id);
  return current.workspace_id;
}

async function reconcileScheduleEvent(
  env: Env,
  eventType: string,
  object: Record<string, unknown>,
): Promise<string | null> {
  const scheduleId = stringValue(object.id);
  const metadata = objectValue(object.metadata);
  const workspaceFromMetadata = stringValue(metadata.workspace_id);
  const linked = scheduleId
    ? await env.CONTROL_DB.prepare(
      "SELECT workspace_id FROM billing_accounts WHERE stripe_subscription_schedule_id = ?",
    ).bind(scheduleId).first<{ workspace_id: string }>()
    : null;
  const workspaceId = workspaceFromMetadata ?? linked?.workspace_id ?? null;
  if (!workspaceId) return null;
  assertAccountStripeEnvironment(env, await account(env, workspaceId));
  const terminal = eventType === "subscription_schedule.released" ||
    eventType === "subscription_schedule.completed" ||
    eventType === "subscription_schedule.canceled" ||
    eventType === "subscription_schedule.aborted";
  if (terminal) {
    const status = eventType === "subscription_schedule.released" || eventType === "subscription_schedule.completed"
      ? "cancelled"
      : "failed";
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE billing_accounts SET stripe_subscription_schedule_id = NULL,
          billing_synced_at = ?, updated_at = ? WHERE workspace_id = ?`,
      ).bind(nowIso(), nowIso(), workspaceId),
      env.CONTROL_DB.prepare(
        `UPDATE billing_plan_changes SET status = CASE WHEN status = 'applied' THEN status ELSE ? END,
          completed_at = COALESCE(completed_at, ?), updated_at = ?
         WHERE workspace_id = ? AND stripe_subscription_schedule_id = ?
           AND status IN ('creating', 'updating', 'scheduled', 'releasing', 'applied')`,
      ).bind(status, nowIso(), nowIso(), workspaceId, scheduleId),
    ]);
  } else if (scheduleId) {
    await env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET stripe_subscription_schedule_id = ?, billing_synced_at = ?, updated_at = ?
       WHERE workspace_id = ?`,
    ).bind(scheduleId, nowIso(), nowIso(), workspaceId).run();
  }
  const subscriptionId = typeof object.subscription === "string"
    ? object.subscription
    : stringValue(objectValue(object.subscription).id);
  if (subscriptionId && eventType !== "subscription_schedule.created") {
    await reconcileSubscription(env, subscriptionId, workspaceId);
  }
  return workspaceId;
}

export async function handleStripeWebhook(c: Context<AppEnv>): Promise<Response> {
  const secret = optionalBinding(c.env, "STRIPE_WEBHOOK_SECRET");
  if (!secret) throw new ApiError(503, "billing_not_configured", "Stripe webhooks are not configured.");
  const signature = c.req.header("stripe-signature");
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (!signature) throw new ApiError(400, "stripe_signature_missing", "Stripe signature is required.");
  if (contentLength > MAX_STRIPE_WEBHOOK_BYTES) throw new ApiError(400, "stripe_payload_too_large", "Stripe payload is too large.");
  const payload = await c.req.text();
  if (new TextEncoder().encode(payload).byteLength > MAX_STRIPE_WEBHOOK_BYTES) throw new ApiError(400, "stripe_payload_too_large", "Stripe payload is too large.");
  if (!(await verifyStripeSignature(payload, signature, secret))) {
    throw new ApiError(400, "stripe_signature_invalid", "Stripe signature is invalid.");
  }
  const event = jsonParse<Record<string, unknown>>(payload, {});
  const eventId = stringValue(event.id);
  const eventType = stringValue(event.type);
  const eventLivemode = typeof event.livemode === "boolean" ? event.livemode : null;
  const eventObject = objectValue(objectValue(event.data).object);
  if (!eventId || !eventType || eventLivemode === null) {
    throw new ApiError(400, "stripe_event_invalid", "Stripe event is invalid.");
  }
  try {
    assertStripeLivemode(c.env, eventLivemode);
  } catch (error) {
    if (error instanceof ApiError && error.code === "stripe_environment_mismatch") {
      throw new ApiError(400, error.code, error.message);
    }
    throw error;
  }
  const inserted = await c.env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO billing_events (
      id, provider, event_type, stripe_livemode, payload_json, received_at, processing_started_at
    ) VALUES (?, 'stripe', ?, ?, ?, ?, ?)`,
  ).bind(eventId, eventType, eventLivemode ? 1 : 0, payload, nowIso(), nowIso()).run();
  if (inserted.meta.changes === 0) {
    const existing = await c.env.CONTROL_DB.prepare(
      "SELECT processed_at FROM billing_events WHERE id = ?",
    ).bind(eventId).first<{ processed_at: string | null }>();
    if (existing?.processed_at) return c.json({ received: true, duplicate: true });
    const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const claimed = await c.env.CONTROL_DB.prepare(
      `UPDATE billing_events SET processing_started_at = ?
       WHERE id = ? AND processed_at IS NULL
         AND (processing_started_at IS NULL OR processing_started_at < ?)`,
    ).bind(nowIso(), eventId, stale).run();
    if (claimed.meta.changes === 0) return c.json({ received: true, processing: true });
  }
  try {
    let workspaceId: string | null = null;
    if (eventType === "checkout.session.expired" || eventType === "checkout.session.async_payment_failed") {
      workspaceId = stringValue(objectValue(eventObject.metadata).workspace_id) ?? stringValue(eventObject.client_reference_id);
      const checkoutAttemptId = stringValue(objectValue(eventObject.metadata).checkout_attempt_id);
      const checkoutSessionId = stringValue(eventObject.id);
      const terminalStatus = eventType === "checkout.session.expired" ? "expired" : "failed";
      await c.env.CONTROL_DB.prepare(
        `UPDATE billing_checkout_sessions SET status = ?, failure_code = ?, completed_at = ?, updated_at = ?
         WHERE (id = ? OR stripe_session_id = ?) AND status IN ('creating', 'open')`,
      ).bind(terminalStatus, eventType, nowIso(), nowIso(), checkoutAttemptId, checkoutSessionId).run();
    } else if (eventType === "checkout.session.completed" || eventType === "checkout.session.async_payment_succeeded") {
      const subscriptionId = stringValue(eventObject.subscription);
      const expectedWorkspaceId = stringValue(objectValue(eventObject.metadata).workspace_id) ?? stringValue(eventObject.client_reference_id);
      if (subscriptionId) workspaceId = await reconcileSubscription(c.env, subscriptionId, expectedWorkspaceId ?? undefined);
      const checkoutAttemptId = stringValue(objectValue(eventObject.metadata).checkout_attempt_id);
      const checkoutSessionId = stringValue(eventObject.id);
      await c.env.CONTROL_DB.prepare(
        `UPDATE billing_checkout_sessions SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE (id = ? OR stripe_session_id = ?) AND status IN ('creating', 'open')`,
      ).bind(nowIso(), nowIso(), checkoutAttemptId, checkoutSessionId).run();
    } else if (eventType === "customer.subscription.deleted") {
      workspaceId = await reconcileDeletedSubscription(c.env, eventObject);
    } else if (eventType.startsWith("customer.subscription.")) {
      const subscriptionId = stringValue(eventObject.id);
      if (subscriptionId) workspaceId = await reconcileSubscription(c.env, subscriptionId);
    } else if (eventType.startsWith("subscription_schedule.")) {
      workspaceId = await reconcileScheduleEvent(c.env, eventType, eventObject);
    } else if (eventType.startsWith("invoice.")) {
      const subscriptionId = eventSubscriptionId(eventObject);
      if (subscriptionId) workspaceId = await reconcileSubscription(c.env, subscriptionId);
    }
    await c.env.CONTROL_DB.prepare(
      "UPDATE billing_events SET workspace_id = ?, processed_at = ?, processing_error = NULL WHERE id = ?",
    ).bind(workspaceId, nowIso(), eventId).run();
    return c.json({ received: true });
  } catch (error) {
    await c.env.CONTROL_DB.prepare(
      "UPDATE billing_events SET processing_started_at = NULL, processing_error = ? WHERE id = ?",
    ).bind(error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000), eventId).run();
    throw error;
  }
}

async function releasePendingChange(env: Env, change: PlanChangeRow, reason: "cancelled" | "superseded"): Promise<void> {
  assertAccountStripeEnvironment(env, await account(env, change.workspace_id));
  const scheduleId = change.stripe_subscription_schedule_id;
  if (!scheduleId) throw new ApiError(409, "billing_schedule_missing", "The pending downgrade needs operator reconciliation.");
  const transition = await env.CONTROL_DB.prepare(
    `UPDATE billing_plan_changes SET status = 'releasing', updated_at = ?
     WHERE id = ? AND status IN ('creating', 'updating', 'scheduled')`,
  ).bind(nowIso(), change.id).run();
  if (transition.meta.changes === 0 && change.status !== "releasing") {
    throw new ApiError(409, "plan_change_conflict", "The pending plan change is already being modified.");
  }
  await releaseStripeSchedule(env, scheduleId, change.id);
  const now = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(reason, now, now, change.id),
    env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET stripe_subscription_schedule_id = NULL, updated_at = ?
       WHERE workspace_id = ? AND stripe_subscription_schedule_id = ?`,
    ).bind(now, change.workspace_id, scheduleId),
  ]);
  await syncUsageEntitlement(env, change.workspace_id);
}

async function ensureDowngradeSchedule(
  env: Env,
  change: Pick<PlanChangeRow, "id" | "workspace_id" | "from_plan_key" | "to_plan_key" | "stripe_subscription_schedule_id">,
  snapshot: SubscriptionSnapshot,
): Promise<string> {
  if (snapshot.planKey !== change.from_plan_key) {
    throw new ApiError(409, "plan_change_stale", "The subscription plan changed before the downgrade could be scheduled.");
  }
  let scheduleId = snapshot.scheduleId ?? change.stripe_subscription_schedule_id;
  if (snapshot.scheduleId && change.stripe_subscription_schedule_id && snapshot.scheduleId !== change.stripe_subscription_schedule_id) {
    throw new ApiError(409, "foreign_subscription_schedule", "The Stripe subscription is attached to an unexpected schedule.");
  }
  let schedule: Record<string, unknown>;
  if (scheduleId) {
    schedule = await stripeRequest(env, `/subscription_schedules/${encodeURIComponent(scheduleId)}`);
    const scheduleChangeId = stringValue(objectValue(schedule.metadata).belki_plan_change_id);
    if (scheduleChangeId !== change.id) {
      throw new ApiError(409, "foreign_subscription_schedule", "The attached schedule is not owned by this Belki plan change.");
    }
  } else {
    schedule = await stripeRequest<Record<string, unknown>>(env, "/subscription_schedules", {
      method: "POST",
      idempotencyKey: `belki:${change.id}:schedule`,
      params: new URLSearchParams({
        from_subscription: snapshot.id,
        "metadata[workspace_id]": change.workspace_id,
        "metadata[belki_plan_change_id]": change.id,
        "metadata[target_plan_key]": change.to_plan_key,
      }),
    });
    scheduleId = stringValue(schedule.id);
  }
  if (!scheduleId) throw new ApiError(502, "stripe_error", "Stripe did not return a schedule ID.");
  const linkedAt = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'updating', stripe_subscription_schedule_id = ?,
        updated_at = ? WHERE id = ? AND status IN ('creating', 'updating')`,
    ).bind(scheduleId, linkedAt, change.id),
    env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET stripe_subscription_schedule_id = ?,
        billing_sync_error = NULL, updated_at = ? WHERE workspace_id = ?`,
    ).bind(scheduleId, linkedAt, change.workspace_id),
  ]);
  const currentPhase = objectValue(arrayValue(schedule.phases)[0]);
  const phaseStart = numberValue(currentPhase.start_date) ?? snapshot.currentPeriodStartUnix;
  const phaseEnd = numberValue(currentPhase.end_date) ?? snapshot.currentPeriodEndUnix;
  const params = new URLSearchParams({
    end_behavior: "release",
    proration_behavior: "none",
    "metadata[workspace_id]": change.workspace_id,
    "metadata[belki_plan_change_id]": change.id,
    "metadata[target_plan_key]": change.to_plan_key,
    "phases[0][items][0][price]": snapshot.priceId,
    "phases[0][items][0][quantity]": "1",
    "phases[0][start_date]": String(phaseStart),
    "phases[0][end_date]": String(phaseEnd),
    "phases[0][proration_behavior]": "none",
    "phases[0][automatic_tax][enabled]": "true",
    "phases[0][metadata][workspace_id]": change.workspace_id,
    "phases[0][metadata][plan_key]": snapshot.planKey,
    "phases[1][items][0][price]": priceId(env, change.to_plan_key),
    "phases[1][items][0][quantity]": "1",
    "phases[1][iterations]": "1",
    "phases[1][proration_behavior]": "none",
    "phases[1][automatic_tax][enabled]": "true",
    "phases[1][metadata][workspace_id]": change.workspace_id,
    "phases[1][metadata][plan_key]": change.to_plan_key,
    "phases[1][metadata][belki_plan_change_id]": change.id,
  });
  await stripeRequest(env, `/subscription_schedules/${encodeURIComponent(scheduleId)}`, {
    method: "POST",
    params,
    idempotencyKey: `belki:${change.id}:configure`,
  });
  const scheduledAt = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'scheduled', stripe_subscription_schedule_id = ?,
        updated_at = ? WHERE id = ? AND status IN ('creating', 'updating', 'scheduled')`,
    ).bind(scheduleId, scheduledAt, change.id),
    env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET stripe_subscription_schedule_id = ?, updated_at = ? WHERE workspace_id = ?`,
    ).bind(scheduleId, scheduledAt, change.workspace_id),
  ]);
  await syncUsageEntitlement(env, change.workspace_id);
  return scheduleId;
}

async function createDowngrade(
  env: Env,
  workspaceId: string,
  userId: string,
  snapshot: SubscriptionSnapshot,
  target: ManagedPlanKey,
): Promise<PlanChangeRow> {
  if (snapshot.currentPeriodEndUnix * 1000 - Date.now() <= RENEWAL_CHANGE_CUTOFF_MS) {
    throw new ApiError(409, "renewal_in_progress", "The billing period is renewing. Retry the downgrade shortly.");
  }
  if (snapshot.scheduleId) {
    throw new ApiError(409, "foreign_subscription_schedule", "This subscription already has a schedule. Ask an operator to reconcile it.");
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  const transition = await planTransitionPreview(
    env,
    workspaceId,
    target,
    snapshot.currentPeriodEnd,
  );
  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO billing_plan_changes (
        id, workspace_id, requested_by_user_id, kind, status, from_plan_key, to_plan_key,
        stripe_subscription_id, stripe_subscription_item_id, effective_at,
        transition_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'downgrade', 'creating', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, workspaceId, userId, snapshot.planKey, target, snapshot.id, snapshot.itemId,
      snapshot.currentPeriodEnd, JSON.stringify(transition), now, now,
    ).run();
  } catch {
    throw new ApiError(409, "plan_change_conflict", "Another plan change is already in progress.");
  }
  let scheduleId: string | null = null;
  try {
    scheduleId = await ensureDowngradeSchedule(env, {
      id,
      workspace_id: workspaceId,
      from_plan_key: snapshot.planKey,
      to_plan_key: target,
      stripe_subscription_schedule_id: null,
    }, snapshot);
    await writeAudit(env.CONTROL_DB, {
      workspaceId,
      userId,
      action: "billing.downgrade_scheduled",
      resourceType: "billing_plan_change",
      resourceId: id,
      metadata: {
        fromPlanKey: snapshot.planKey,
        toPlanKey: target,
        effectiveAt: snapshot.currentPeriodEnd,
        archivedProjectCount: transition.archivedProjects.length,
        pausedPromptCount: transition.pausedPromptCount,
        sourceChangeCount: transition.sourceChanges.length,
      },
    });
    return (await activePlanChange(env, workspaceId)) as PlanChangeRow;
  } catch (error) {
    if (!scheduleId) {
      const linked = await env.CONTROL_DB.prepare(
        "SELECT stripe_subscription_schedule_id FROM billing_plan_changes WHERE id = ?",
      ).bind(id).first<{ stripe_subscription_schedule_id: string | null }>();
      scheduleId = linked?.stripe_subscription_schedule_id ?? null;
    }
    let releaseFailed = false;
    if (scheduleId) {
      try {
        await releaseStripeSchedule(env, scheduleId, id);
      } catch {
        releaseFailed = true;
      }
    }
    const failedAt = nowIso();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE billing_plan_changes SET status = ?, failure_code = ?, failure_message = ?,
          stripe_subscription_schedule_id = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        releaseFailed ? "releasing" : "failed",
        releaseFailed ? "schedule_cleanup_failed" : error instanceof ApiError ? error.code : "schedule_create_failed",
        error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        scheduleId, releaseFailed ? null : failedAt, failedAt, id,
      ),
      env.CONTROL_DB.prepare(
        `UPDATE billing_accounts SET stripe_subscription_schedule_id = ?, updated_at = ? WHERE workspace_id = ?`,
      ).bind(releaseFailed ? scheduleId : null, failedAt, workspaceId),
    ]);
    if (releaseFailed) await setSyncError(env, workspaceId, "schedule_cleanup_failed");
    else await syncUsageEntitlement(env, workspaceId);
    throw error;
  }
}

async function createUpgradeSession(
  env: Env,
  workspaceId: string,
  userId: string,
  snapshot: SubscriptionSnapshot,
  target: ManagedPlanKey,
  origin: string,
): Promise<{ url: string; changeId: string }> {
  if (snapshot.scheduleId) {
    throw new ApiError(409, "foreign_subscription_schedule", "Release or reconcile the attached schedule before upgrading.");
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  await env.CONTROL_DB.prepare(
    `INSERT INTO billing_plan_changes (
      id, workspace_id, requested_by_user_id, kind, status, from_plan_key, to_plan_key,
      stripe_subscription_id, stripe_subscription_item_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'upgrade', 'pending_customer', ?, ?, ?, ?, ?, ?)`,
  ).bind(id, workspaceId, userId, snapshot.planKey, target, snapshot.id, snapshot.itemId, now, now).run();
  try {
    const params = new URLSearchParams({
      customer: snapshot.customerId,
      configuration: actionPortalConfiguration(env),
      return_url: `${origin}/billing`,
      "flow_data[type]": "subscription_update_confirm",
      "flow_data[subscription_update_confirm][subscription]": snapshot.id,
      "flow_data[subscription_update_confirm][items][0][id]": snapshot.itemId,
      "flow_data[subscription_update_confirm][items][0][price]": priceId(env, target),
      "flow_data[subscription_update_confirm][items][0][quantity]": "1",
      "flow_data[after_completion][type]": "redirect",
      "flow_data[after_completion][redirect][return_url]": `${origin}/billing?plan_change=processing&expected_plan=${target}`,
    });
    const session = await stripeRequest<Record<string, unknown>>(env, "/billing_portal/sessions", {
      method: "POST",
      params,
      idempotencyKey: `belki:${id}:upgrade-portal`,
    });
    const url = stringValue(session.url);
    const portalSessionId = stringValue(session.id);
    if (!url) throw new ApiError(502, "stripe_error", "Stripe did not return a billing URL.");
    await env.CONTROL_DB.prepare(
      "UPDATE billing_plan_changes SET stripe_portal_session_id = ?, updated_at = ? WHERE id = ?",
    ).bind(portalSessionId, nowIso(), id).run();
    await writeAudit(env.CONTROL_DB, {
      workspaceId,
      userId,
      action: "billing.upgrade_started",
      resourceType: "billing_plan_change",
      resourceId: id,
      metadata: { fromPlanKey: snapshot.planKey, toPlanKey: target },
    });
    return { url, changeId: id };
  } catch (error) {
    await env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'failed', failure_code = ?, failure_message = ?,
        completed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      error instanceof ApiError ? error.code : "portal_session_failed",
      error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      nowIso(), nowIso(), id,
    ).run();
    throw error;
  }
}

export async function reconcileBillingPlanChanges(env: Env): Promise<number> {
  const now = new Date();
  const stale = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const due = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const expiredUpgrade = new Date(now.getTime() - UPGRADE_CONFIRMATION_TTL_MS).toISOString();
  const expired = await env.CONTROL_DB.prepare(
    `UPDATE billing_plan_changes SET status = 'expired', completed_at = ?, updated_at = ?
     WHERE status = 'pending_customer' AND created_at < ?`,
  ).bind(now.toISOString(), now.toISOString(), expiredUpgrade).run();
  const expiredCheckout = await env.CONTROL_DB.prepare(
    `UPDATE billing_checkout_sessions SET status = 'expired', completed_at = ?, updated_at = ?
     WHERE (status = 'open' AND expires_at <= ?)
        OR (status = 'creating' AND updated_at < ?)`,
  ).bind(now.toISOString(), now.toISOString(), now.toISOString(), stale).run();
  const rows = await env.CONTROL_DB.prepare(
    `SELECT * FROM billing_plan_changes
     WHERE (status IN ('creating', 'updating', 'releasing') AND updated_at < ?)
        OR (status = 'scheduled' AND effective_at <= ?)
     ORDER BY COALESCE(effective_at, updated_at) LIMIT 25`,
  ).bind(stale, due).all<PlanChangeRow>();
  let reconciled = Number(expired.meta.changes ?? 0) + Number(expiredCheckout.meta.changes ?? 0);
  for (const row of rows.results) {
    try {
      assertAccountStripeEnvironment(env, await account(env, row.workspace_id));
      const object = await stripeSubscription(env, row.stripe_subscription_id);
      const snapshot = subscriptionSnapshot(env, object);
      if (row.status === "releasing") {
        const scheduleId = snapshot.scheduleId ?? row.stripe_subscription_schedule_id;
        if (scheduleId) await releaseStripeSchedule(env, scheduleId, row.id);
        const completedAt = nowIso();
        await env.CONTROL_DB.batch([
          env.CONTROL_DB.prepare(
            `UPDATE billing_plan_changes SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?`,
          ).bind(completedAt, completedAt, row.id),
          env.CONTROL_DB.prepare(
            `UPDATE billing_accounts SET stripe_subscription_schedule_id = NULL,
              billing_sync_error = NULL, updated_at = ? WHERE workspace_id = ?`,
          ).bind(completedAt, row.workspace_id),
        ]);
        await syncUsageEntitlement(env, row.workspace_id);
      } else if (row.kind === "downgrade" && (row.status === "creating" || row.status === "updating")) {
        await ensureDowngradeSchedule(env, row, snapshot);
      } else {
        await reconcileSubscriptionObject(env, object, row.workspace_id);
      }
      reconciled += 1;
    } catch (error) {
      await setSyncError(env, row.workspace_id, error instanceof ApiError ? error.code : "plan_change_reconcile_failed");
      console.error(JSON.stringify({
        level: "error",
        message: "billing_plan_change_reconcile_failed",
        workspaceId: row.workspace_id,
        changeId: row.id,
        error: error instanceof ApiError ? error.code : String(error),
      }));
    }
  }
  return reconciled;
}

export async function reconcileWorkspaceBilling(env: Env, workspaceId: string): Promise<{
  workspaceId: string;
  planKey: PlanKey;
  subscriptionStatus: SubscriptionStatus;
  syncedAt: string | null;
}> {
  const current = await account(env, workspaceId);
  if (current.payment_mode !== "stripe_direct" || !current.stripe_subscription_id) {
    throw new ApiError(409, "stripe_subscription_missing", "This workspace has no Stripe Direct subscription to reconcile.");
  }
  assertAccountStripeEnvironment(env, current);
  await reconcileSubscription(env, current.stripe_subscription_id, workspaceId);
  const reconciled = await account(env, workspaceId);
  return {
    workspaceId,
    planKey: reconciled.plan_key,
    subscriptionStatus: reconciled.status,
    syncedAt: reconciled.billing_synced_at,
  };
}

export async function cancelWorkspaceBillingPlanChange(env: Env, workspaceId: string): Promise<boolean> {
  const change = await activePlanChange(env, workspaceId);
  if (!change) return false;
  await releasePendingChange(env, change, "cancelled");
  return true;
}

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.get("/billing/summary", async (c) => {
  const principal = c.get("principal");
  const [billing, usage, pending] = await Promise.all([
    account(c.env, principal.workspaceId),
    getUsageSummary(c.env, principal.workspaceId),
    activePlanChange(c.env, principal.workspaceId),
  ]);
  const managedCurrent = managedPlan(billing.plan_key);
  const stripeEnvironmentMatches = accountMatchesStripeEnvironment(c.env, billing);
  const storedTransition = pending
    ? jsonParse<PlanTransitionPreview | null>(pending.transition_json ?? "null", null)
    : null;
  const transition = pending?.kind === "downgrade" && pending.effective_at
    ? await planTransitionPreview(
        c.env,
        principal.workspaceId,
        pending.to_plan_key,
        pending.effective_at,
        storedTransition?.retainedProjectIds ?? [],
      )
    : storedTransition;
  return c.json({
    data: {
      planKey: billing.plan_key,
      subscriptionStatus: billing.status,
      paymentMode: billing.payment_mode,
      stripeEnvironment: billing.stripe_livemode === null ? null : billing.stripe_livemode === 1 ? "live" : "test",
      configuredStripeEnvironment: billing.payment_mode === "disabled" ? null : stripeEnvironment(c.env),
      planChangesEnabled: planChangesEnabled(c.env) && stripeEnvironmentMatches && billing.payment_mode === "stripe_direct" && billing.status === "active" && Boolean(optionalBinding(c.env, "STRIPE_BILLING_ACTION_PORTAL_CONFIGURATION_ID")),
      planChangeDisabledReason: billing.billing_sync_error ?? (billing.payment_mode === "stripe_managed"
        ? "Managed Payments plan changes are not production-supported."
        : !stripeEnvironmentMatches
          ? "this workspace belongs to a different Stripe test/live environment"
        : !planChangesEnabled(c.env)
          ? "plan changes are disabled by the deployment feature flag"
          : !optionalBinding(c.env, "STRIPE_BILLING_ACTION_PORTAL_CONFIGURATION_ID")
            ? "the Stripe action portal is not configured"
            : billing.status !== "active"
              ? "the subscription must be active"
              : null),
      cycleStartedAt: billing.cycle_started_at,
      cycleEndsAt: billing.cycle_ends_at,
      cancelAtPeriodEnd: billing.cancel_at_period_end === 1,
      readOnlyUntil: billing.read_only_until,
      currentProjectLimit: billing.project_limit,
      currentPromptLimit: billing.prompt_limit,
      currentSourceLimit: billing.source_limit,
      availableTrackingSources: availableSources(c.env),
      usage,
      pendingPlanChange: pending ? {
        id: pending.id,
        kind: pending.kind,
        status: pending.status,
        fromPlanKey: pending.from_plan_key,
        toPlanKey: pending.to_plan_key,
        effectiveAt: pending.effective_at,
        transition,
      } : null,
      plans: PLAN_KEYS.map((key) => ({
        key,
        priceEur: BILLING_PLANS[key].priceEur,
        monthlyUnits: BILLING_PLANS[key].monthlyUnits,
        projectLimit: BILLING_PLANS[key].projectLimit,
        promptLimit: BILLING_PLANS[key].promptLimit,
        sourceLimit: BILLING_PLANS[key].sourceLimit,
        changeKind: !managedCurrent ? "checkout" : key === managedCurrent
          ? "current"
          : BILLING_PLANS[key].rank > BILLING_PLANS[managedCurrent].rank ? "upgrade" : "downgrade",
      })),
    },
  });
});

billingRoutes.get(
  "/billing/plan-change-preview",
  zValidator("query", BillingPlanChangePreviewSchema),
  async (c) => {
    const principal = requireRole(c, "owner");
    const { planKey: target } = c.req.valid("query");
    const billing = await account(c.env, principal.workspaceId);
    if (billing.payment_mode !== "stripe_direct" || !billing.stripe_subscription_id) {
      throw new ApiError(409, "subscription_missing", "An active Stripe Direct subscription is required.");
    }
    assertAccountStripeEnvironment(c.env, billing);
    const snapshot = subscriptionSnapshot(
      c.env,
      await stripeSubscription(c.env, billing.stripe_subscription_id),
    );
    assertSupportedPlanChange(snapshot);
    if (BILLING_PLANS[target].rank >= BILLING_PLANS[snapshot.planKey].rank) {
      throw new ApiError(409, "downgrade_required", "A transition preview is available only for a lower plan.");
    }
    const transition = await planTransitionPreview(
      c.env,
      principal.workspaceId,
      target,
      snapshot.currentPeriodEnd,
    );
    return c.json({ data: transition });
  },
);

billingRoutes.post("/billing/checkout", zValidator("json", BillingCheckoutSchema), async (c) => {
  const principal = requireRole(c, "owner");
  const { planKey } = c.req.valid("json");
  const billing = await account(c.env, principal.workspaceId);
  if (billing.payment_mode !== "stripe_direct") {
    throw new ApiError(409, "stripe_direct_required", "Managed cloud billing requires Stripe Direct for this release.");
  }
  assertAccountStripeEnvironment(c.env, billing);
  if (billing.stripe_subscription_id) {
    throw new ApiError(409, "subscription_exists", "Use Belki plan controls for an existing subscription.");
  }
  const activeCheckout = await c.env.CONTROL_DB.prepare(
    `SELECT id, plan_key, status, stripe_session_id, checkout_url, expires_at
     FROM billing_checkout_sessions
     WHERE workspace_id = ? AND status IN ('creating', 'open')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(principal.workspaceId).first<{
    id: string;
    plan_key: ManagedPlanKey;
    status: string;
    stripe_session_id: string | null;
    checkout_url: string | null;
    expires_at: string | null;
  }>();
  if (
    activeCheckout?.plan_key === planKey && activeCheckout.status === "open" &&
    activeCheckout.checkout_url && activeCheckout.expires_at && Date.parse(activeCheckout.expires_at) > Date.now()
  ) {
    return c.json({ data: { url: activeCheckout.checkout_url } });
  }
  if (activeCheckout) {
    if (activeCheckout.status === "creating" || !activeCheckout.stripe_session_id) {
      throw new ApiError(409, "checkout_in_progress", "Another Checkout session is already being created. Retry in a moment.");
    }
    if (!activeCheckout.expires_at || Date.parse(activeCheckout.expires_at) > Date.now()) {
      try {
        await stripeRequest(c.env, `/checkout/sessions/${encodeURIComponent(activeCheckout.stripe_session_id)}/expire`, {
          method: "POST",
          idempotencyKey: `belki:${activeCheckout.id}:expire`,
        });
      } catch {
        throw new ApiError(409, "checkout_in_progress", "The previous Checkout session could not be replaced. Return from Stripe or retry shortly.");
      }
    }
    await c.env.CONTROL_DB.prepare(
      `UPDATE billing_checkout_sessions SET status = 'expired', completed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), nowIso(), activeCheckout.id).run();
  }
  const attemptId = crypto.randomUUID();
  const createdAt = nowIso();
  try {
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO billing_checkout_sessions (id, workspace_id, plan_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'creating', ?, ?)`,
    ).bind(attemptId, principal.workspaceId, planKey, createdAt, createdAt).run();
  } catch {
    throw new ApiError(409, "checkout_in_progress", "Another Checkout session is already being created. Retry in a moment.");
  }
  const origin = await billingPublicAppOrigin(c.env, principal.workspaceId);
  const params = new URLSearchParams({
    "line_items[0][price]": priceId(c.env, planKey),
    "line_items[0][quantity]": "1",
    mode: "subscription",
    success_url: `${origin}/billing?checkout=success`,
    cancel_url: `${origin}/billing?checkout=cancelled`,
    client_reference_id: principal.workspaceId,
    customer_email: principal.email,
    "automatic_tax[enabled]": "true",
    billing_address_collection: "required",
    "tax_id_collection[enabled]": "true",
    "metadata[workspace_id]": principal.workspaceId,
    "metadata[plan_key]": planKey,
    "metadata[checkout_attempt_id]": attemptId,
    "subscription_data[metadata][workspace_id]": principal.workspaceId,
    "subscription_data[metadata][plan_key]": planKey,
  });
  try {
    const session = await stripeRequest<Record<string, unknown>>(c.env, "/checkout/sessions", {
      method: "POST",
      params,
      idempotencyKey: `belki:${attemptId}:checkout`,
    });
    const url = stringValue(session.url);
    const stripeSessionId = stringValue(session.id);
    const expiresAtUnix = numberValue(session.expires_at);
    if (!url || !stripeSessionId || expiresAtUnix === null) {
      throw new ApiError(502, "stripe_error", "Stripe did not return a complete Checkout session.");
    }
    await c.env.CONTROL_DB.prepare(
      `UPDATE billing_checkout_sessions SET status = 'open', stripe_session_id = ?,
        checkout_url = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(stripeSessionId, url, unixIso(expiresAtUnix), nowIso(), attemptId).run();
    return c.json({ data: { url } });
  } catch (error) {
    await c.env.CONTROL_DB.prepare(
      `UPDATE billing_checkout_sessions SET status = 'failed', failure_code = ?,
        completed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(error instanceof ApiError ? error.code : "checkout_create_failed", nowIso(), nowIso(), attemptId).run();
    throw error;
  }
});

billingRoutes.post("/billing/plan-change", zValidator("json", BillingPlanChangeSchema), async (c) => {
  const principal = requireRole(c, "owner");
  const { planKey: target, replacePending } = c.req.valid("json");
  if (!planChangesEnabled(c.env)) throw new ApiError(503, "plan_changes_disabled", "Plan changes are temporarily disabled.");
  const billing = await account(c.env, principal.workspaceId);
  if (billing.payment_mode !== "stripe_direct") {
    throw new ApiError(409, "stripe_direct_required", "Plan changes are supported only with Stripe Direct.");
  }
  assertAccountStripeEnvironment(c.env, billing);
  if (!billing.stripe_subscription_id) throw new ApiError(409, "subscription_missing", "Complete Checkout before changing plans.");
  const initialSnapshot = subscriptionSnapshot(c.env, await stripeSubscription(c.env, billing.stripe_subscription_id));
  assertSupportedPlanChange(initialSnapshot);
  if (initialSnapshot.planKey === target) throw new ApiError(409, "plan_unchanged", "This is already the current plan.");
  const upgrading = BILLING_PLANS[target].rank > BILLING_PLANS[initialSnapshot.planKey].rank;
  priceId(c.env, target);
  if (upgrading) actionPortalConfiguration(c.env);
  const existing = await activePlanChange(c.env, principal.workspaceId);
  if (existing) {
    if (!replacePending) {
      throw new ApiError(409, "pending_plan_change", "Confirm that this request replaces the scheduled downgrade.", {
        pendingPlanKey: existing.to_plan_key,
        effectiveAt: existing.effective_at,
      });
    }
    await releasePendingChange(c.env, existing, "superseded");
  }
  const snapshot = existing
    ? subscriptionSnapshot(c.env, await stripeSubscription(c.env, billing.stripe_subscription_id))
    : initialSnapshot;
  assertSupportedPlanChange(snapshot);
  if (snapshot.planKey === target) throw new ApiError(409, "plan_unchanged", "This is already the current plan.");
  if (BILLING_PLANS[target].rank > BILLING_PLANS[snapshot.planKey].rank) {
    const result = await createUpgradeSession(
      c.env,
      principal.workspaceId,
      principal.userId,
      snapshot,
      target,
      await billingPublicAppOrigin(c.env, principal.workspaceId),
    );
    return c.json({ data: { action: "redirect" as const, ...result } });
  }
  const change = await createDowngrade(c.env, principal.workspaceId, principal.userId, snapshot, target);
  return c.json({ data: {
    action: "scheduled" as const,
    changeId: change.id,
    planKey: change.to_plan_key,
    effectiveAt: change.effective_at,
  } });
});

billingRoutes.delete("/billing/plan-change", async (c) => {
  const principal = requireRole(c, "owner");
  const change = await activePlanChange(c.env, principal.workspaceId);
  if (!change) throw new ApiError(404, "pending_plan_change_missing", "No scheduled downgrade exists.");
  await releasePendingChange(c.env, change, "cancelled");
  await writeAudit(c.env.CONTROL_DB, {
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    action: "billing.downgrade_cancelled",
    resourceType: "billing_plan_change",
    resourceId: change.id,
  });
  return c.json({ data: { cancelled: true } });
});

billingRoutes.post("/billing/management-session", async (c) => {
  const principal = requireRole(c, "owner");
  const billing = await account(c.env, principal.workspaceId);
  assertAccountStripeEnvironment(c.env, billing);
  if (!billing.stripe_customer_id) throw new ApiError(409, "billing_customer_missing", "Complete Checkout before managing billing.");
  const origin = await billingPublicAppOrigin(c.env, principal.workspaceId);
  const session = await stripeRequest<Record<string, unknown>>(c.env, "/billing_portal/sessions", {
    method: "POST",
    params: new URLSearchParams({ customer: billing.stripe_customer_id, return_url: `${origin}/billing` }),
  });
  const url = stringValue(session.url);
  if (!url) throw new ApiError(502, "stripe_error", "Stripe did not return a billing URL.");
  return c.json({ data: { url } });
});

billingRoutes.post("/billing/cancellation-session", zValidator("json", BillingCancellationSchema), async (c) => {
  const principal = requireRole(c, "owner");
  const { replacePending } = c.req.valid("json");
  const billing = await account(c.env, principal.workspaceId);
  if (billing.payment_mode !== "stripe_direct" || !billing.stripe_customer_id || !billing.stripe_subscription_id) {
    throw new ApiError(409, "subscription_missing", "An active Stripe Direct subscription is required.");
  }
  assertAccountStripeEnvironment(c.env, billing);
  actionPortalConfiguration(c.env);
  const pending = await activePlanChange(c.env, principal.workspaceId);
  if (pending && !replacePending) throw new ApiError(409, "pending_plan_change", "Confirm that cancellation replaces the scheduled downgrade.");
  if (pending) await releasePendingChange(c.env, pending, "superseded");
  const origin = await billingPublicAppOrigin(c.env, principal.workspaceId);
  const session = await stripeRequest<Record<string, unknown>>(c.env, "/billing_portal/sessions", {
    method: "POST",
    params: new URLSearchParams({
      customer: billing.stripe_customer_id,
      configuration: actionPortalConfiguration(c.env),
      return_url: `${origin}/billing`,
      "flow_data[type]": "subscription_cancel",
      "flow_data[subscription_cancel][subscription]": billing.stripe_subscription_id,
      "flow_data[after_completion][type]": "redirect",
      "flow_data[after_completion][redirect][return_url]": `${origin}/billing?cancellation=processing`,
    }),
  });
  const url = stringValue(session.url);
  if (!url) throw new ApiError(502, "stripe_error", "Stripe did not return a cancellation URL.");
  return c.json({ data: { url } });
});

billingRoutes.post("/billing/reactivate", async (c) => {
  const principal = requireRole(c, "owner");
  const billing = await account(c.env, principal.workspaceId);
  if (billing.payment_mode !== "stripe_direct" || !billing.stripe_subscription_id) {
    throw new ApiError(409, "subscription_missing", "A Stripe Direct subscription is required.");
  }
  assertAccountStripeEnvironment(c.env, billing);
  if (await activePlanChange(c.env, principal.workspaceId)) {
    throw new ApiError(409, "pending_plan_change", "Cancel the pending downgrade before reactivating.");
  }
  const subscription = await stripeRequest<Record<string, unknown>>(
    c.env,
    `/subscriptions/${encodeURIComponent(billing.stripe_subscription_id)}`,
    {
      method: "POST",
      params: new URLSearchParams({ cancel_at_period_end: "false" }),
      idempotencyKey: `belki:${principal.workspaceId}:reactivate`,
    },
  );
  await reconcileSubscriptionObject(c.env, subscription, principal.workspaceId);
  await writeAudit(c.env.CONTROL_DB, {
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    action: "billing.subscription_reactivated",
    resourceType: "workspace",
    resourceId: principal.workspaceId,
  });
  return c.json({ data: { reactivated: true } });
});
