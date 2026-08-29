import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import {
  BillingCancellationSchema,
  BillingCheckoutSchema,
  BillingPlanChangeSchema,
  BillingPlanChangePreviewSchema,
  type ManagedPaymentPlanKey,
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
  getUsageSummary,
  releaseUsage,
  syncUsageEntitlement,
} from "../lib/usage";
import { availableSources } from "../lib/tracking-sources";
import {
  legacyTransactionalPlanKey,
  legacyWorkspacePlanKey,
} from "../../shared/billing-plans";
import { workspacePublicAppOrigin } from "../lib/public-origin";
import {
  resolveDefaultPaymentProviderAccount,
  resolvePaymentProviderAccount,
  resolvePaymentProviderByWebhookEndpoint,
  resolvePaymentProviderForWorkspace,
} from "../payments/accounts";
import { PAYMENT_PROVIDER_ADAPTERS, paymentProviderAdapter } from "../payments/registry";
import type {
  PaymentProviderPlan,
  ResolvedPaymentProviderAccount,
} from "../payments/types";

const RENEWAL_CHANGE_CUTOFF_MS = 5 * 60 * 1000;
const UPGRADE_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAYMENT_WEBHOOK_BYTES = 1024 * 1024;
type ManagedPlanKey = ManagedPaymentPlanKey;

interface BillingAccountRow {
  workspace_id: string;
  payment_provider_account_id: string | null;
  external_customer_id: string | null;
  external_subscription_id: string | null;
  payment_mode: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  stripe_subscription_schedule_id: string | null;
  stripe_livemode: number | null;
  plan_key: PlanKey;
  billing_plan_id: ManagedPlanKey | null;
  status: SubscriptionStatus;
  monthly_units: number;
  project_limit: number;
  prompt_limit: number;
  source_limit: number;
  allowed_sources_json: string;
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
  from_billing_plan_id: ManagedPlanKey | null;
  to_billing_plan_id: ManagedPlanKey | null;
  stripe_subscription_id: string;
  stripe_subscription_item_id: string | null;
  stripe_portal_session_id: string | null;
  stripe_subscription_schedule_id: string | null;
  payment_provider_account_id: string | null;
  external_subscription_id: string | null;
  external_item_id: string | null;
  external_action_id: string | null;
  external_schedule_id: string | null;
  adapter_version: string | null;
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
  itemId: string | null;
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
  taxHandlingReady: boolean;
  providerState: Record<string, unknown>;
  object: Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 86_400_000).toISOString();
}

function billingPlanId(billing: BillingAccountRow): ManagedPlanKey | null {
  if (billing.billing_plan_id) return billing.billing_plan_id;
  return billing.plan_key === "self_hosted" || billing.plan_key === "custom"
    ? null
    : billing.plan_key;
}

function paymentPlan(
  payment: ResolvedPaymentProviderAccount,
  planKey: ManagedPlanKey,
): PaymentProviderPlan {
  const plan = payment.catalogue[planKey];
  if (!plan) {
    throw new ApiError(503, "billing_not_configured", `The ${planKey} plan is not configured for ${payment.label}.`);
  }
  return plan;
}

function planChangeFrom(change: PlanChangeRow): ManagedPlanKey {
  return change.from_billing_plan_id ?? change.from_plan_key;
}

function planChangeTo(change: PlanChangeRow): ManagedPlanKey {
  return change.to_billing_plan_id ?? change.to_plan_key;
}

function planChangesEnabled(env: Env): boolean {
  return String(env.BILLING_PLAN_CHANGES_ENABLED) === "true";
}

async function planTransitionPreview(
  env: Env,
  workspaceId: string,
  target: PaymentProviderPlan,
  effectiveAt: string,
  preferredProjectIds: string[] = [],
): Promise<PlanTransitionPreview> {
  const entitlement = target;
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
      .filter((source) => target.allowedSources.includes(source))
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
    targetPlanKey: target.id,
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
  target: PaymentProviderPlan,
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
  const entitlement = target;
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

function assertAccountPaymentEnvironment(
  payment: ResolvedPaymentProviderAccount,
  billing: BillingAccountRow,
): void {
  if (
    billing.stripe_livemode !== null &&
    Boolean(billing.stripe_livemode) !== (payment.environment === "live")
  ) {
    throw new ApiError(
      409,
      "payment_environment_mismatch",
      `This workspace belongs to the ${billing.stripe_livemode ? "live" : "test"} environment, but ${payment.label} is configured for ${payment.environment}.`,
    );
  }
}

function accountMatchesPaymentEnvironment(
  payment: ResolvedPaymentProviderAccount,
  billing: BillingAccountRow,
): boolean {
  return billing.stripe_livemode === null ||
    Boolean(billing.stripe_livemode) === (payment.environment === "live");
}

async function account(env: Env, workspaceId: string): Promise<BillingAccountRow> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT billing.workspace_id, link.provider_account_id AS payment_provider_account_id,
      link.external_customer_id, link.external_subscription_id,
      billing.payment_mode, billing.stripe_customer_id, billing.stripe_subscription_id,
      billing.stripe_subscription_item_id, billing.stripe_subscription_schedule_id,
      billing.plan_key, billing.billing_plan_id, billing.status, billing.stripe_livemode,
      billing.monthly_units, billing.project_limit, billing.prompt_limit, billing.source_limit,
      billing.allowed_sources_json,
      billing.cycle_started_at, billing.cycle_ends_at,
      billing.cancel_at_period_end, billing.read_only_until,
      billing.billing_synced_at, billing.billing_sync_error
     FROM billing_accounts billing
     LEFT JOIN workspace_billing_subscriptions link ON link.workspace_id = billing.workspace_id
     WHERE billing.workspace_id = ?`,
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

async function accountBySubscription(
  env: Env,
  payment: ResolvedPaymentProviderAccount,
  subscriptionId: string,
): Promise<BillingAccountRow | null> {
  return env.CONTROL_DB.prepare(
    `SELECT billing.workspace_id, link.provider_account_id AS payment_provider_account_id,
      link.external_customer_id, link.external_subscription_id,
      billing.payment_mode, billing.stripe_customer_id, billing.stripe_subscription_id,
      billing.stripe_subscription_item_id, billing.stripe_subscription_schedule_id,
      billing.plan_key, billing.billing_plan_id, billing.status, billing.stripe_livemode,
      billing.monthly_units, billing.project_limit, billing.prompt_limit, billing.source_limit,
      billing.allowed_sources_json,
      billing.cycle_started_at, billing.cycle_ends_at,
      billing.cancel_at_period_end, billing.read_only_until,
      billing.billing_synced_at, billing.billing_sync_error
     FROM billing_accounts billing
     LEFT JOIN workspace_billing_subscriptions link ON link.workspace_id = billing.workspace_id
     WHERE (link.provider_account_id = ? AND link.external_subscription_id = ?)
       OR (link.workspace_id IS NULL AND billing.stripe_subscription_id = ?)
     LIMIT 1`,
  ).bind(payment.accountId, subscriptionId, subscriptionId).first<BillingAccountRow>();
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
       AND COALESCE(to_billing_plan_id, to_plan_key) = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(workspaceId, target).first<PlanChangeRow>();
}

async function setSyncError(env: Env, workspaceId: string, error: string | null): Promise<void> {
  await env.CONTROL_DB.prepare(
    "UPDATE billing_accounts SET billing_sync_error = ?, updated_at = ? WHERE workspace_id = ?",
  ).bind(error, nowIso(), workspaceId).run();
}

async function providerSubscription(
  payment: ResolvedPaymentProviderAccount,
  subscriptionId: string,
): Promise<Record<string, unknown>> {
  return paymentProviderAdapter(payment.provider).retrieveSubscription(payment, subscriptionId);
}

function subscriptionSnapshot(
  payment: ResolvedPaymentProviderAccount,
  object: Record<string, unknown>,
): SubscriptionSnapshot {
  const snapshot = paymentProviderAdapter(payment.provider).normalizeSubscription(payment, object);
  return {
    id: snapshot.externalSubscriptionId,
    customerId: snapshot.externalCustomerId,
    itemId: snapshot.externalItemId,
    priceId: snapshot.externalPlanReference,
    planKey: snapshot.planKey,
    quantity: snapshot.quantity,
    status: snapshot.status,
    rawStatus: snapshot.rawStatus,
    currentPeriodStart: snapshot.currentPeriodStart,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    currentPeriodStartUnix: snapshot.currentPeriodStartUnix,
    currentPeriodEndUnix: snapshot.currentPeriodEndUnix,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    scheduleId: snapshot.externalScheduledChangeId,
    hasTrial: snapshot.hasTrial,
    hasDiscount: snapshot.hasDiscount,
    taxHandlingReady: snapshot.taxHandlingReady,
    providerState: snapshot.providerState,
    object: snapshot.object,
  };
}

function assertSupportedPlanChange(snapshot: SubscriptionSnapshot): void {
  if (snapshot.rawStatus !== "active") {
    throw new ApiError(409, "subscription_not_active", "Plan changes require an active paid subscription.");
  }
  if (snapshot.quantity !== 1 || snapshot.hasTrial || snapshot.hasDiscount || !snapshot.taxHandlingReady) {
    throw new ApiError(409, "unsupported_subscription", "Plan changes support one monthly plan at quantity 1 with provider tax handling and without trials or discounts.");
  }
  if (snapshot.cancelAtPeriodEnd) {
    throw new ApiError(409, "subscription_cancelling", "Reactivate the subscription before changing plans.");
  }
}

async function releaseScheduledPlanChange(
  payment: ResolvedPaymentProviderAccount,
  externalSubscriptionId: string,
  scheduleId: string,
  changeId: string,
): Promise<void> {
  await paymentProviderAdapter(payment.provider).releaseScheduledPlanChange(
    payment,
    externalSubscriptionId,
    scheduleId,
    `belki:${changeId}:release`,
  );
}

async function reconcileSubscriptionObject(
  env: Env,
  payment: ResolvedPaymentProviderAccount,
  object: Record<string, unknown>,
  expectedWorkspaceId?: string,
): Promise<string> {
  let snapshot: SubscriptionSnapshot;
  try {
    snapshot = subscriptionSnapshot(payment, object);
  } catch (error) {
    const subscriptionId = stringValue(object.id);
    const metadataWorkspaceId = stringValue(objectValue(object.metadata).workspace_id);
    const linked = subscriptionId ? await accountBySubscription(env, payment, subscriptionId) : null;
    const workspaceId = expectedWorkspaceId ?? linked?.workspace_id ?? metadataWorkspaceId;
    if (workspaceId) await setSyncError(env, workspaceId, error instanceof ApiError ? error.code : "payment_reconcile_failed");
    throw error;
  }
  const metadataWorkspaceId = stringValue(objectValue(object.metadata).workspace_id);
  const current = expectedWorkspaceId
    ? await account(env, expectedWorkspaceId)
    : await accountBySubscription(env, payment, snapshot.id) ?? (metadataWorkspaceId ? await account(env, metadataWorkspaceId) : null);
  if (!current) throw new ApiError(409, "billing_workspace_missing", "The payment subscription is not linked to a workspace.");
  assertAccountPaymentEnvironment(payment, current);
  if (current.payment_provider_account_id && current.payment_provider_account_id !== payment.accountId) {
    throw new ApiError(409, "billing_provider_mismatch", "The payment subscription belongs to another provider account.");
  }
  const currentSubscriptionId = current.external_subscription_id ?? current.stripe_subscription_id;
  const currentCustomerId = current.external_customer_id ?? current.stripe_customer_id;
  if (currentSubscriptionId && currentSubscriptionId !== snapshot.id) {
    throw new ApiError(409, "billing_subscription_mismatch", "The payment subscription does not match this workspace.");
  }
  if (currentCustomerId && currentCustomerId !== snapshot.customerId) {
    throw new ApiError(409, "billing_customer_mismatch", "The payment customer does not match this workspace.");
  }
  const entitlement = paymentPlan(payment, snapshot.planKey);
  const now = new Date();
  const active = snapshot.status === "active" || snapshot.status === "trialing";
  const readOnly = snapshot.status === "unpaid" || snapshot.status === "cancelled";
  const workspaceStatus = active ? "active" : readOnly ? "read_only" : "pending_payment";
  const readOnlyUntil = readOnly ? addDays(now, 90) : null;
  const matchingDowngrade = await env.CONTROL_DB.prepare(
    `SELECT * FROM billing_plan_changes
     WHERE workspace_id = ? AND kind = 'downgrade'
       AND status IN ('creating', 'updating', 'scheduled', 'releasing')
       AND COALESCE(to_billing_plan_id, to_plan_key) = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(current.workspace_id, snapshot.planKey).first<PlanChangeRow>();
  const matchingUpgrade = await pendingUpgrade(env, current.workspace_id, snapshot.planKey);
  const completedAt = now.toISOString();
  const currentManagedPlanId = billingPlanId(current);
  const currentManagedPlan = currentManagedPlanId
    ? payment.catalogue[currentManagedPlanId]
    : null;
  const isDowngrade = currentManagedPlan != null &&
    entitlement.sortOrder < currentManagedPlan.sortOrder;
  const appliedTransition = isDowngrade || matchingDowngrade
    ? await applyPlanTransition(
        env,
        current.workspace_id,
        entitlement,
        snapshot.currentPeriodStart,
        matchingDowngrade?.transition_json ?? null,
      )
    : null;
  const statements = [
    env.CONTROL_DB.prepare(
      `INSERT INTO workspace_billing_subscriptions (
        workspace_id, provider_account_id, external_customer_id,
        external_subscription_id, environment, adapter_version,
        provider_state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        provider_account_id = excluded.provider_account_id,
        external_customer_id = excluded.external_customer_id,
        external_subscription_id = excluded.external_subscription_id,
        environment = excluded.environment,
        adapter_version = excluded.adapter_version,
        provider_state_json = excluded.provider_state_json,
        updated_at = excluded.updated_at`,
    ).bind(
      current.workspace_id,
      payment.accountId,
      snapshot.customerId,
      snapshot.id,
      payment.environment,
      payment.adapterVersion,
      JSON.stringify({
        ...snapshot.providerState,
        externalItemId: snapshot.itemId,
        externalScheduleId: snapshot.scheduleId,
      }),
      completedAt,
      completedAt,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET stripe_customer_id = ?, stripe_subscription_id = ?,
        stripe_subscription_item_id = ?, stripe_subscription_schedule_id = ?,
        plan_key = ?, billing_plan_id = ?, status = ?, monthly_units = ?, project_limit = ?,
        prompt_limit = ?, source_limit = ?, allowed_sources_json = ?,
        cycle_started_at = ?, cycle_ends_at = ?, cancel_at_period_end = ?,
        read_only_until = ?, billing_synced_at = ?, billing_sync_error = NULL, updated_at = ?
       WHERE workspace_id = ?`,
    ).bind(
      payment.provider === "stripe" ? snapshot.customerId : null,
      payment.provider === "stripe" ? snapshot.id : null,
      payment.provider === "stripe" ? snapshot.itemId : null,
      payment.provider === "stripe" ? snapshot.scheduleId : null,
      legacyWorkspacePlanKey(snapshot.planKey),
      snapshot.planKey,
      snapshot.status,
      entitlement.monthlyUnits,
      entitlement.projectLimit,
      entitlement.promptLimit,
      entitlement.sourceLimit,
      JSON.stringify(entitlement.allowedSources),
      snapshot.currentPeriodStart,
      snapshot.currentPeriodEnd,
      snapshot.cancelAtPeriodEnd ? 1 : 0,
      readOnlyUntil,
      completedAt,
      completedAt,
      current.workspace_id,
    ),
    env.CONTROL_DB.prepare(
      "UPDATE workspaces SET status = ?, plan_key = ?, billing_plan_id = ?, read_only_until = ?, updated_at = ? WHERE id = ?",
    ).bind(
      workspaceStatus,
      legacyWorkspacePlanKey(snapshot.planKey),
      snapshot.planKey,
      readOnlyUntil,
      completedAt,
      current.workspace_id,
    ),
  ];
  if (matchingDowngrade) {
    statements.push(env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'applied', completed_at = ?, updated_at = ?,
        stripe_subscription_item_id = ?, external_item_id = ?, transition_json = ? WHERE id = ?`,
    ).bind(
      completedAt,
      completedAt,
      snapshot.itemId,
      snapshot.itemId,
      JSON.stringify(appliedTransition),
      matchingDowngrade.id,
    ));
  }
  if (matchingUpgrade) {
    statements.push(env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'applied', completed_at = ?, updated_at = ?,
        stripe_subscription_item_id = ?, external_item_id = ? WHERE id = ?`,
    ).bind(completedAt, completedAt, snapshot.itemId, snapshot.itemId, matchingUpgrade.id));
    statements.push(env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'expired', completed_at = ?, updated_at = ?
       WHERE workspace_id = ? AND kind = 'upgrade' AND status = 'pending_customer' AND id != ?`,
    ).bind(completedAt, completedAt, current.workspace_id, matchingUpgrade.id));
  }
  await env.CONTROL_DB.batch(statements);
  await syncUsageEntitlement(env, current.workspace_id);
  const completedScheduleId = matchingDowngrade?.external_schedule_id ??
    matchingDowngrade?.stripe_subscription_schedule_id;
  if (completedScheduleId && matchingDowngrade && snapshot.planKey === planChangeTo(matchingDowngrade)) {
    await releaseScheduledPlanChange(payment, snapshot.id, completedScheduleId, matchingDowngrade.id);
    await env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET stripe_subscription_schedule_id = NULL, updated_at = ?
       WHERE workspace_id = ? AND stripe_subscription_schedule_id = ?`,
    ).bind(nowIso(), current.workspace_id, completedScheduleId).run();
  }
  return current.workspace_id;
}

async function reconcileSubscription(
  env: Env,
  payment: ResolvedPaymentProviderAccount,
  subscriptionId: string,
  workspaceId?: string,
): Promise<string> {
  try {
    return await reconcileSubscriptionObject(
      env,
      payment,
      await providerSubscription(payment, subscriptionId),
      workspaceId,
    );
  } catch (error) {
    if (workspaceId) await setSyncError(env, workspaceId, error instanceof ApiError ? error.code : "payment_reconcile_failed");
    throw error;
  }
}

async function reconcileDeletedSubscription(
  env: Env,
  payment: ResolvedPaymentProviderAccount,
  object: Record<string, unknown>,
  knownSubscriptionId?: string | null,
): Promise<string | null> {
  const subscriptionId = knownSubscriptionId ?? stringValue(object.id);
  if (!subscriptionId) return null;
  const current = await accountBySubscription(env, payment, subscriptionId);
  if (!current) return null;
  assertAccountPaymentEnvironment(payment, current);
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
  payment: ResolvedPaymentProviderAccount,
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
  assertAccountPaymentEnvironment(payment, await account(env, workspaceId));
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
         WHERE workspace_id = ? AND (external_schedule_id = ? OR stripe_subscription_schedule_id = ?)
           AND status IN ('creating', 'updating', 'scheduled', 'releasing', 'applied')`,
      ).bind(status, nowIso(), nowIso(), workspaceId, scheduleId, scheduleId),
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
    await reconcileSubscription(env, payment, subscriptionId, workspaceId);
  }
  return workspaceId;
}

async function processPaymentWebhook(
  c: Context<AppEnv>,
  payment: ResolvedPaymentProviderAccount,
): Promise<Response> {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_PAYMENT_WEBHOOK_BYTES) {
    throw new ApiError(400, "payment_payload_too_large", "The payment webhook payload is too large.");
  }
  const payload = await c.req.text();
  const event = await paymentProviderAdapter(payment.provider)
    .verifyAndParseWebhook(payment, payload, c.req.raw.headers);
  const receivedAt = nowIso();
  let eventStorageId = crypto.randomUUID();
  const inserted = await c.env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO billing_events (
      id, provider, event_type, stripe_livemode, payload_json, received_at,
      processing_started_at, payment_provider_account_id, external_event_id,
      payment_environment, credential_version, adapter_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    eventStorageId,
    payment.provider,
    event.eventType,
    payment.provider === "stripe" ? (event.environment === "live" ? 1 : 0) : null,
    payload,
    receivedAt,
    receivedAt,
    payment.accountId,
    event.externalEventId,
    event.environment,
    payment.credentialVersion,
    payment.adapterVersion,
  ).run();
  if (inserted.meta.changes === 0) {
    const existing = await c.env.CONTROL_DB.prepare(
      `SELECT id, processed_at FROM billing_events
       WHERE payment_provider_account_id = ? AND external_event_id = ?`,
    ).bind(payment.accountId, event.externalEventId)
      .first<{ id: string; processed_at: string | null }>();
    if (!existing) {
      throw new ApiError(409, "payment_event_conflict", "The payment event could not be claimed.");
    }
    eventStorageId = existing.id;
    if (existing.processed_at) return c.json({ received: true, duplicate: true });
    const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const claimed = await c.env.CONTROL_DB.prepare(
      `UPDATE billing_events SET processing_started_at = ?
       WHERE id = ? AND processed_at IS NULL
         AND (processing_started_at IS NULL OR processing_started_at < ?)`,
    ).bind(nowIso(), eventStorageId, stale).run();
    if (claimed.meta.changes === 0) return c.json({ received: true, processing: true });
  }
  try {
    let workspaceId = event.workspaceId;
    if (event.kind === "checkout_failed") {
      const terminalStatus = event.eventType.includes("expired") ? "expired" : "failed";
      await c.env.CONTROL_DB.prepare(
        `UPDATE billing_checkout_sessions SET status = ?, failure_code = ?, completed_at = ?, updated_at = ?
         WHERE (id = ? OR
           (payment_provider_account_id = ? AND external_session_id = ?) OR stripe_session_id = ?)
           AND status IN ('creating', 'open')`,
      ).bind(
        terminalStatus,
        event.eventType,
        nowIso(),
        nowIso(),
        event.checkoutAttemptId,
        payment.accountId,
        event.externalCheckoutId,
        event.externalCheckoutId,
      ).run();
    } else if (event.kind === "checkout_completed") {
      if (event.externalSubscriptionId) {
        workspaceId = await reconcileSubscription(
          c.env,
          payment,
          event.externalSubscriptionId,
          event.workspaceId ?? undefined,
        );
      }
      await c.env.CONTROL_DB.prepare(
        `UPDATE billing_checkout_sessions SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE (id = ? OR
           (payment_provider_account_id = ? AND external_session_id = ?) OR stripe_session_id = ?)
           AND status IN ('creating', 'open')`,
      ).bind(
        nowIso(),
        nowIso(),
        event.checkoutAttemptId,
        payment.accountId,
        event.externalCheckoutId,
        event.externalCheckoutId,
      ).run();
    } else if (event.kind === "subscription_deleted") {
      workspaceId = await reconcileDeletedSubscription(
        c.env,
        payment,
        event.object,
        event.externalSubscriptionId,
      );
    } else if (event.kind === "subscription_changed" || event.kind === "invoice_changed") {
      if (event.externalSubscriptionId) {
        workspaceId = await reconcileSubscription(c.env, payment, event.externalSubscriptionId);
      }
    } else if (event.kind === "scheduled_change_changed") {
      workspaceId = payment.provider === "stripe"
        ? await reconcileScheduleEvent(c.env, payment, event.eventType, event.object)
        : event.externalSubscriptionId
          ? await reconcileSubscription(c.env, payment, event.externalSubscriptionId)
          : workspaceId;
    }
    await c.env.CONTROL_DB.prepare(
      "UPDATE billing_events SET workspace_id = ?, processed_at = ?, processing_error = NULL WHERE id = ?",
    ).bind(workspaceId, nowIso(), eventStorageId).run();
    return c.json({ received: true });
  } catch (error) {
    await c.env.CONTROL_DB.prepare(
      "UPDATE billing_events SET processing_started_at = NULL, processing_error = ? WHERE id = ?",
    ).bind(
      error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      eventStorageId,
    ).run();
    throw error;
  }
}

export async function handlePaymentWebhook(c: Context<AppEnv>): Promise<Response> {
  const endpointKey = c.req.param("endpointKey");
  if (!endpointKey) {
    throw new ApiError(404, "payment_webhook_not_found", "Payment webhook endpoint not found.");
  }
  return processPaymentWebhook(
    c,
    await resolvePaymentProviderByWebhookEndpoint(c.env, endpointKey),
  );
}

export async function handleStripeWebhook(c: Context<AppEnv>): Promise<Response> {
  let payment: ResolvedPaymentProviderAccount;
  try {
    payment = await resolvePaymentProviderByWebhookEndpoint(c.env, "stripe-legacy-v1");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    payment = await resolveDefaultPaymentProviderAccount(c.env);
  }
  if (payment.provider !== "stripe") {
    throw new ApiError(404, "payment_webhook_not_found", "The legacy Stripe webhook is not active.");
  }
  return processPaymentWebhook(c, payment);
}

async function releasePendingChange(env: Env, change: PlanChangeRow, reason: "cancelled" | "superseded"): Promise<void> {
  const payment = change.payment_provider_account_id
    ? await resolvePaymentProviderAccount(env, change.payment_provider_account_id)
    : await resolvePaymentProviderForWorkspace(env, change.workspace_id);
  assertAccountPaymentEnvironment(payment, await account(env, change.workspace_id));
  const scheduleId = change.external_schedule_id ?? change.stripe_subscription_schedule_id;
  if (!scheduleId) throw new ApiError(409, "billing_schedule_missing", "The pending downgrade needs operator reconciliation.");
  const transition = await env.CONTROL_DB.prepare(
    `UPDATE billing_plan_changes SET status = 'releasing', updated_at = ?
     WHERE id = ? AND status IN ('creating', 'updating', 'scheduled')`,
  ).bind(nowIso(), change.id).run();
  if (transition.meta.changes === 0 && change.status !== "releasing") {
    throw new ApiError(409, "plan_change_conflict", "The pending plan change is already being modified.");
  }
  await releaseScheduledPlanChange(
    payment,
    change.external_subscription_id ?? change.stripe_subscription_id,
    scheduleId,
    change.id,
  );
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
  payment: ResolvedPaymentProviderAccount,
  change: Pick<
    PlanChangeRow,
    "id" | "workspace_id" | "from_plan_key" | "to_plan_key" |
    "from_billing_plan_id" | "to_billing_plan_id" |
    "stripe_subscription_schedule_id" | "external_schedule_id"
  >,
  snapshot: SubscriptionSnapshot,
): Promise<string> {
  const fromPlanKey = change.from_billing_plan_id ?? change.from_plan_key;
  const toPlanKey = change.to_billing_plan_id ?? change.to_plan_key;
  if (snapshot.planKey !== fromPlanKey) {
    throw new ApiError(409, "plan_change_stale", "The subscription plan changed before the downgrade could be scheduled.");
  }
  const storedScheduleId = change.external_schedule_id ?? change.stripe_subscription_schedule_id;
  const result = await paymentProviderAdapter(payment.provider).schedulePlanChange(payment, {
    changeId: change.id,
    workspaceId: change.workspace_id,
    targetPlanKey: toPlanKey,
    subscription: paymentProviderAdapter(payment.provider)
      .normalizeSubscription(payment, snapshot.object),
    existingExternalScheduleId: storedScheduleId,
  });
  const scheduleId = result.externalScheduleId;
  const scheduledAt = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET status = 'scheduled', stripe_subscription_schedule_id = ?,
        external_schedule_id = ?, payment_provider_account_id = ?, adapter_version = ?,
        provider_state_json = ?,
        updated_at = ? WHERE id = ? AND status IN ('creating', 'updating', 'scheduled')`,
    ).bind(
      payment.provider === "stripe" ? scheduleId : null,
      scheduleId,
      payment.accountId,
      payment.adapterVersion,
      JSON.stringify(result.providerState),
      scheduledAt,
      change.id,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE billing_accounts SET stripe_subscription_schedule_id = ?, updated_at = ? WHERE workspace_id = ?`,
    ).bind(payment.provider === "stripe" ? scheduleId : null, scheduledAt, change.workspace_id),
  ]);
  await syncUsageEntitlement(env, change.workspace_id);
  return scheduleId;
}

async function createDowngrade(
  env: Env,
  payment: ResolvedPaymentProviderAccount,
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
    paymentPlan(payment, target),
    snapshot.currentPeriodEnd,
  );
  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO billing_plan_changes (
        id, workspace_id, requested_by_user_id, kind, status, from_plan_key, to_plan_key,
        from_billing_plan_id, to_billing_plan_id,
        stripe_subscription_id, stripe_subscription_item_id, effective_at,
        transition_json, created_at, updated_at, payment_provider_account_id,
        external_subscription_id, external_item_id, adapter_version, provider_state_json
      ) VALUES (?, ?, ?, 'downgrade', 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).bind(
      id, workspaceId, userId,
      legacyTransactionalPlanKey(snapshot.planKey), legacyTransactionalPlanKey(target),
      snapshot.planKey, target, snapshot.id, snapshot.itemId,
      snapshot.currentPeriodEnd, JSON.stringify(transition), now, now,
      payment.accountId, snapshot.id, snapshot.itemId, payment.adapterVersion,
    ).run();
  } catch {
    throw new ApiError(409, "plan_change_conflict", "Another plan change is already in progress.");
  }
  let scheduleId: string | null = null;
  try {
    scheduleId = await ensureDowngradeSchedule(env, payment, {
      id,
      workspace_id: workspaceId,
      from_plan_key: snapshot.planKey,
      to_plan_key: target,
      from_billing_plan_id: snapshot.planKey,
      to_billing_plan_id: target,
      stripe_subscription_schedule_id: null,
      external_schedule_id: null,
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
      scheduleId = error instanceof ApiError
        ? stringValue(objectValue(error.details).externalScheduleId)
        : null;
    }
    if (!scheduleId) {
      const linked = await env.CONTROL_DB.prepare(
        `SELECT stripe_subscription_schedule_id, external_schedule_id
         FROM billing_plan_changes WHERE id = ?`,
      ).bind(id).first<{
        stripe_subscription_schedule_id: string | null;
        external_schedule_id: string | null;
      }>();
      scheduleId = linked?.external_schedule_id ?? linked?.stripe_subscription_schedule_id ?? null;
    }
    let releaseFailed = false;
    if (scheduleId) {
      try {
        await releaseScheduledPlanChange(payment, snapshot.id, scheduleId, id);
      } catch {
        releaseFailed = true;
      }
    }
    const failedAt = nowIso();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE billing_plan_changes SET status = ?, failure_code = ?, failure_message = ?,
          stripe_subscription_schedule_id = ?, external_schedule_id = ?,
          completed_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        releaseFailed ? "releasing" : "failed",
        releaseFailed ? "schedule_cleanup_failed" : error instanceof ApiError ? error.code : "schedule_create_failed",
        error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        payment.provider === "stripe" ? scheduleId : null,
        scheduleId,
        releaseFailed ? null : failedAt,
        failedAt,
        id,
      ),
      env.CONTROL_DB.prepare(
        `UPDATE billing_accounts SET stripe_subscription_schedule_id = ?, updated_at = ? WHERE workspace_id = ?`,
      ).bind(
        releaseFailed && payment.provider === "stripe" ? scheduleId : null,
        failedAt,
        workspaceId,
      ),
    ]);
    if (releaseFailed) await setSyncError(env, workspaceId, "schedule_cleanup_failed");
    else await syncUsageEntitlement(env, workspaceId);
    throw error;
  }
}

async function createUpgradeSession(
  env: Env,
  payment: ResolvedPaymentProviderAccount,
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
        from_billing_plan_id, to_billing_plan_id,
      stripe_subscription_id, stripe_subscription_item_id, created_at, updated_at,
      payment_provider_account_id, external_subscription_id, external_item_id,
      adapter_version, provider_state_json
    ) VALUES (?, ?, ?, 'upgrade', 'pending_customer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  ).bind(
    id, workspaceId, userId,
    legacyTransactionalPlanKey(snapshot.planKey), legacyTransactionalPlanKey(target),
    snapshot.planKey, target, snapshot.id, snapshot.itemId,
    now, now, payment.accountId, snapshot.id, snapshot.itemId, payment.adapterVersion,
  ).run();
  try {
    const session = await paymentProviderAdapter(payment.provider).createPlanChangeSession(payment, {
      actionId: id,
      workspaceId,
      externalCustomerId: snapshot.customerId,
      externalSubscriptionId: snapshot.id,
      externalItemId: snapshot.itemId,
      targetPlanKey: target,
      returnUrl: `${origin}/billing`,
      completionUrl: `${origin}/billing?plan_change=processing&expected_plan=${target}`,
    });
    await env.CONTROL_DB.prepare(
      `UPDATE billing_plan_changes SET stripe_portal_session_id = ?, external_action_id = ?,
        updated_at = ? WHERE id = ?`,
    ).bind(session.externalActionId, session.externalActionId, nowIso(), id).run();
    await writeAudit(env.CONTROL_DB, {
      workspaceId,
      userId,
      action: "billing.upgrade_started",
      resourceType: "billing_plan_change",
      resourceId: id,
      metadata: { fromPlanKey: snapshot.planKey, toPlanKey: target },
    });
    return { url: session.url, changeId: id };
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
      const payment = row.payment_provider_account_id
        ? await resolvePaymentProviderAccount(env, row.payment_provider_account_id)
        : await resolvePaymentProviderForWorkspace(env, row.workspace_id);
      assertAccountPaymentEnvironment(payment, await account(env, row.workspace_id));
      const subscriptionId = row.external_subscription_id ?? row.stripe_subscription_id;
      const object = await providerSubscription(payment, subscriptionId);
      const snapshot = subscriptionSnapshot(payment, object);
      if (row.status === "releasing") {
        const scheduleId = snapshot.scheduleId ?? row.external_schedule_id ??
          row.stripe_subscription_schedule_id;
        if (scheduleId) {
          await releaseScheduledPlanChange(payment, subscriptionId, scheduleId, row.id);
        }
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
        await ensureDowngradeSchedule(env, payment, row, snapshot);
      } else {
        await reconcileSubscriptionObject(env, payment, object, row.workspace_id);
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
  const externalSubscriptionId = current.external_subscription_id ?? current.stripe_subscription_id;
  if (current.payment_mode === "disabled" || !externalSubscriptionId) {
    throw new ApiError(409, "payment_subscription_missing", "This workspace has no payment subscription to reconcile.");
  }
  const payment = await resolvePaymentProviderForWorkspace(env, workspaceId);
  assertAccountPaymentEnvironment(payment, current);
  await reconcileSubscription(env, payment, externalSubscriptionId, workspaceId);
  const reconciled = await account(env, workspaceId);
  return {
    workspaceId,
    planKey: billingPlanId(reconciled) ?? reconciled.plan_key,
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
  const payment = billing.payment_mode === "disabled"
    ? null
    : await resolvePaymentProviderForWorkspace(c.env, principal.workspaceId);
  const managedCurrentId = billingPlanId(billing);
  const managedCurrent = managedCurrentId && payment
    ? payment.catalogue[managedCurrentId] ?? null
    : null;
  const environmentMatches = payment
    ? accountMatchesPaymentEnvironment(payment, billing)
    : true;
  const supportsPlanChanges = payment
    ? PAYMENT_PROVIDER_ADAPTERS[payment.provider].capabilities.planChanges
    : false;
  const storedTransition = pending
    ? jsonParse<PlanTransitionPreview | null>(pending.transition_json ?? "null", null)
    : null;
  const pendingTarget = pending && payment ? paymentPlan(payment, planChangeTo(pending)) : null;
  const transition = pending?.kind === "downgrade" && pending.effective_at && pendingTarget
    ? await planTransitionPreview(
        c.env,
        principal.workspaceId,
        pendingTarget,
        pending.effective_at,
        storedTransition?.retainedProjectIds ?? [],
      )
    : storedTransition;
  return c.json({
    data: {
      planKey: billingPlanId(billing) ?? billing.plan_key,
      subscriptionStatus: billing.status,
      paymentMode: billing.payment_mode,
      paymentProvider: payment?.provider ?? null,
      paymentProviderLabel: payment ? PAYMENT_PROVIDER_ADAPTERS[payment.provider].label : null,
      paymentProviderAccountLabel: payment?.label ?? null,
      paymentEnvironment: payment?.environment ?? null,
      stripeEnvironment: billing.stripe_livemode === null ? null : billing.stripe_livemode === 1 ? "live" : "test",
      configuredStripeEnvironment: payment?.provider === "stripe" ? payment.environment : null,
      planChangesEnabled: planChangesEnabled(c.env) && environmentMatches &&
        billing.payment_mode !== "disabled" && billing.status === "active" && supportsPlanChanges,
      planChangeDisabledReason: billing.billing_sync_error ?? (billing.payment_mode === "stripe_managed"
        ? "Managed Payments plan changes are not production-supported."
        : !environmentMatches
          ? "this workspace belongs to a different payment test/live environment"
        : !planChangesEnabled(c.env)
          ? "plan changes are disabled by the deployment feature flag"
          : !supportsPlanChanges
            ? "the selected payment provider does not support plan changes"
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
      availableTrackingSources: await availableSources(c.env),
      usage,
      pendingPlanChange: pending ? {
        id: pending.id,
        kind: pending.kind,
        status: pending.status,
        fromPlanKey: planChangeFrom(pending),
        toPlanKey: planChangeTo(pending),
        effectiveAt: pending.effective_at,
        transition,
      } : null,
      plans: payment ? Object.values(payment.catalogue)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
        .map((plan) => ({
        key: plan.id,
        name: plan.name,
        description: plan.description,
        featured: plan.featured,
        currency: plan.currency,
        amountMinor: plan.amountMinor,
        monthlyUnits: plan.monthlyUnits,
        projectLimit: plan.projectLimit,
        promptLimit: plan.promptLimit,
        sourceLimit: plan.sourceLimit,
        allowedSources: plan.allowedSources,
        changeKind: !managedCurrent ? "checkout" : plan.id === managedCurrent.id
          ? "current"
          : plan.sortOrder > managedCurrent.sortOrder ? "upgrade" : "downgrade",
      })) : [],
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
    const externalSubscriptionId = billing.external_subscription_id ?? billing.stripe_subscription_id;
    if (billing.payment_mode === "disabled" || !externalSubscriptionId) {
      throw new ApiError(409, "subscription_missing", "An active payment subscription is required.");
    }
    const payment = await resolvePaymentProviderForWorkspace(c.env, principal.workspaceId);
    assertAccountPaymentEnvironment(payment, billing);
    const snapshot = subscriptionSnapshot(
      payment,
      await providerSubscription(payment, externalSubscriptionId),
    );
    assertSupportedPlanChange(snapshot);
    const targetPlan = paymentPlan(payment, target);
    const currentPlan = paymentPlan(payment, snapshot.planKey);
    if (targetPlan.sortOrder >= currentPlan.sortOrder) {
      throw new ApiError(409, "downgrade_required", "A transition preview is available only for a lower plan.");
    }
    const transition = await planTransitionPreview(
      c.env,
      principal.workspaceId,
      targetPlan,
      snapshot.currentPeriodEnd,
    );
    return c.json({ data: transition });
  },
);

billingRoutes.post("/billing/checkout", zValidator("json", BillingCheckoutSchema), async (c) => {
  const principal = requireRole(c, "owner");
  const { planKey } = c.req.valid("json");
  const billing = await account(c.env, principal.workspaceId);
  if (billing.payment_mode === "disabled") {
    throw new ApiError(409, "managed_payment_required", "Managed cloud billing is not enabled for this workspace.");
  }
  const payment = await resolvePaymentProviderForWorkspace(c.env, principal.workspaceId);
  const adapter = paymentProviderAdapter(payment.provider);
  paymentPlan(payment, planKey);
  assertAccountPaymentEnvironment(payment, billing);
  if (billing.external_subscription_id || billing.stripe_subscription_id) {
    throw new ApiError(409, "subscription_exists", "Use Belki plan controls for an existing subscription.");
  }
  const activeCheckout = await c.env.CONTROL_DB.prepare(
    `SELECT id, COALESCE(billing_plan_id, plan_key) AS billing_plan_id,
      status, stripe_session_id, external_session_id,
      payment_provider_account_id, checkout_url, expires_at
     FROM billing_checkout_sessions
     WHERE workspace_id = ? AND status IN ('creating', 'open')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(principal.workspaceId).first<{
    id: string;
    billing_plan_id: ManagedPlanKey;
    status: string;
    stripe_session_id: string | null;
    external_session_id: string | null;
    payment_provider_account_id: string | null;
    checkout_url: string | null;
    expires_at: string | null;
  }>();
  if (
    activeCheckout?.billing_plan_id === planKey && activeCheckout.status === "open" &&
    (!activeCheckout.payment_provider_account_id || activeCheckout.payment_provider_account_id === payment.accountId) &&
    activeCheckout.checkout_url &&
    (!activeCheckout.expires_at || Date.parse(activeCheckout.expires_at) > Date.now())
  ) {
    return c.json({ data: { url: activeCheckout.checkout_url } });
  }
  if (activeCheckout) {
    const externalSessionId = activeCheckout.external_session_id ?? activeCheckout.stripe_session_id;
    if (activeCheckout.status === "creating" || !externalSessionId) {
      throw new ApiError(409, "checkout_in_progress", "Another Checkout session is already being created. Retry in a moment.");
    }
    const checkoutPayment = activeCheckout.payment_provider_account_id &&
      activeCheckout.payment_provider_account_id !== payment.accountId
      ? await resolvePaymentProviderAccount(c.env, activeCheckout.payment_provider_account_id)
      : payment;
    if (!activeCheckout.expires_at || Date.parse(activeCheckout.expires_at) > Date.now()) {
      try {
        const checkoutAdapter = paymentProviderAdapter(checkoutPayment.provider);
        if (!checkoutAdapter.expireCheckout) {
          throw new ApiError(
            409,
            "checkout_in_progress",
            "The current payment provider does not support replacing an open Checkout session. Continue with the existing Checkout or wait for its provider-side expiry.",
          );
        }
        await checkoutAdapter.expireCheckout(
          checkoutPayment,
          externalSessionId,
          `belki:${activeCheckout.id}:expire`,
        );
      } catch {
        throw new ApiError(409, "checkout_in_progress", "The previous Checkout session could not be replaced. Return from the payment provider or retry shortly.");
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
      `INSERT INTO billing_checkout_sessions (
        id, workspace_id, plan_key, billing_plan_id, status, payment_provider_account_id,
        adapter_version, provider_state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'creating', ?, ?, '{}', ?, ?)`,
    ).bind(
      attemptId,
      principal.workspaceId,
      legacyTransactionalPlanKey(planKey),
      planKey,
      payment.accountId,
      payment.adapterVersion,
      createdAt,
      createdAt,
    ).run();
  } catch {
    throw new ApiError(409, "checkout_in_progress", "Another Checkout session is already being created. Retry in a moment.");
  }
  const origin = await billingPublicAppOrigin(c.env, principal.workspaceId);
  try {
    const session = await adapter.createCheckout(payment, {
      attemptId,
      workspaceId: principal.workspaceId,
      planKey,
      customerEmail: principal.email,
      successUrl: `${origin}/billing?checkout=success`,
      cancelUrl: `${origin}/billing?checkout=cancelled`,
    });
    await c.env.CONTROL_DB.prepare(
      `UPDATE billing_checkout_sessions SET status = 'open', stripe_session_id = ?,
        external_session_id = ?, checkout_url = ?, expires_at = ?,
        provider_state_json = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      payment.provider === "stripe" ? session.externalSessionId : null,
      session.externalSessionId,
      session.url,
      session.expiresAt,
      JSON.stringify(session.providerState),
      nowIso(),
      attemptId,
    ).run();
    return c.json({ data: { url: session.url, provider: payment.provider } });
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
  if (billing.payment_mode === "disabled") {
    throw new ApiError(409, "managed_payment_required", "Plan changes require managed payments.");
  }
  const payment = await resolvePaymentProviderForWorkspace(c.env, principal.workspaceId);
  if (!PAYMENT_PROVIDER_ADAPTERS[payment.provider].capabilities.planChanges) {
    throw new ApiError(409, "payment_capability_unavailable", "The selected payment provider does not support plan changes.");
  }
  assertAccountPaymentEnvironment(payment, billing);
  const externalSubscriptionId = billing.external_subscription_id ?? billing.stripe_subscription_id;
  if (!externalSubscriptionId) throw new ApiError(409, "subscription_missing", "Complete Checkout before changing plans.");
  const initialSnapshot = subscriptionSnapshot(
    payment,
    await providerSubscription(payment, externalSubscriptionId),
  );
  assertSupportedPlanChange(initialSnapshot);
  if (initialSnapshot.planKey === target) throw new ApiError(409, "plan_unchanged", "This is already the current plan.");
  const targetPlan = paymentPlan(payment, target);
  const existing = await activePlanChange(c.env, principal.workspaceId);
  if (existing) {
    if (!replacePending) {
      throw new ApiError(409, "pending_plan_change", "Confirm that this request replaces the scheduled downgrade.", {
        pendingPlanKey: planChangeTo(existing),
        effectiveAt: existing.effective_at,
      });
    }
    await releasePendingChange(c.env, existing, "superseded");
  }
  const snapshot = existing
    ? subscriptionSnapshot(payment, await providerSubscription(payment, externalSubscriptionId))
    : initialSnapshot;
  assertSupportedPlanChange(snapshot);
  if (snapshot.planKey === target) throw new ApiError(409, "plan_unchanged", "This is already the current plan.");
  const currentPlan = paymentPlan(payment, snapshot.planKey);
  if (targetPlan.sortOrder > currentPlan.sortOrder) {
    const result = await createUpgradeSession(
      c.env,
      payment,
      principal.workspaceId,
      principal.userId,
      snapshot,
      target,
      await billingPublicAppOrigin(c.env, principal.workspaceId),
    );
    return c.json({ data: { action: "redirect" as const, ...result } });
  }
  const change = await createDowngrade(
    c.env,
    payment,
    principal.workspaceId,
    principal.userId,
    snapshot,
    target,
  );
  return c.json({ data: {
    action: "scheduled" as const,
    changeId: change.id,
    planKey: planChangeTo(change),
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
  const payment = await resolvePaymentProviderForWorkspace(c.env, principal.workspaceId);
  assertAccountPaymentEnvironment(payment, billing);
  const externalCustomerId = billing.external_customer_id ?? billing.stripe_customer_id;
  if (!externalCustomerId) throw new ApiError(409, "billing_customer_missing", "Complete Checkout before managing billing.");
  const origin = await billingPublicAppOrigin(c.env, principal.workspaceId);
  const session = await paymentProviderAdapter(payment.provider).createManagementSession(
    payment,
    externalCustomerId,
    `${origin}/billing`,
  );
  return c.json({ data: { url: session.url } });
});

billingRoutes.post("/billing/cancellation-session", zValidator("json", BillingCancellationSchema), async (c) => {
  const principal = requireRole(c, "owner");
  const { replacePending } = c.req.valid("json");
  const billing = await account(c.env, principal.workspaceId);
  const externalCustomerId = billing.external_customer_id ?? billing.stripe_customer_id;
  const externalSubscriptionId = billing.external_subscription_id ?? billing.stripe_subscription_id;
  if (billing.payment_mode === "disabled" || !externalCustomerId || !externalSubscriptionId) {
    throw new ApiError(409, "subscription_missing", "An active payment subscription is required.");
  }
  const payment = await resolvePaymentProviderForWorkspace(c.env, principal.workspaceId);
  assertAccountPaymentEnvironment(payment, billing);
  const pending = await activePlanChange(c.env, principal.workspaceId);
  if (pending && !replacePending) throw new ApiError(409, "pending_plan_change", "Confirm that cancellation replaces the scheduled downgrade.");
  if (pending) await releasePendingChange(c.env, pending, "superseded");
  const origin = await billingPublicAppOrigin(c.env, principal.workspaceId);
  const session = await paymentProviderAdapter(payment.provider).createCancellationSession(payment, {
    externalCustomerId,
    externalSubscriptionId,
    returnUrl: `${origin}/billing`,
    completionUrl: `${origin}/billing?cancellation=processing`,
  });
  return c.json({ data: { url: session.url } });
});

billingRoutes.post("/billing/reactivate", async (c) => {
  const principal = requireRole(c, "owner");
  const billing = await account(c.env, principal.workspaceId);
  const externalSubscriptionId = billing.external_subscription_id ?? billing.stripe_subscription_id;
  if (billing.payment_mode === "disabled" || !externalSubscriptionId) {
    throw new ApiError(409, "subscription_missing", "A payment subscription is required.");
  }
  const payment = await resolvePaymentProviderForWorkspace(c.env, principal.workspaceId);
  assertAccountPaymentEnvironment(payment, billing);
  if (await activePlanChange(c.env, principal.workspaceId)) {
    throw new ApiError(409, "pending_plan_change", "Cancel the pending downgrade before reactivating.");
  }
  const subscription = await paymentProviderAdapter(payment.provider).reactivateSubscription(
    payment,
    externalSubscriptionId,
    `belki:${principal.workspaceId}:reactivate`,
  );
  await reconcileSubscriptionObject(c.env, payment, subscription, principal.workspaceId);
  await writeAudit(c.env.CONTROL_DB, {
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    action: "billing.subscription_reactivated",
    resourceType: "workspace",
    resourceId: principal.workspaceId,
  });
  return c.json({ data: { reactivated: true } });
});
