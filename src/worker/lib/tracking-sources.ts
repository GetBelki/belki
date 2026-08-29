import type { PlanKey, TrackingSource } from "../../shared/contracts";
import { DEFAULT_BILLING_PLANS } from "../../shared/billing-plans";
import { DEFAULT_TRACKING_SOURCES, TRACKING_SOURCES } from "../../shared/tracking-sources";
import { ApiError, jsonParse } from "./http";
import { captureProviderConfiguration } from "../providers/accounts";

export interface SourceEntitlement {
  allowedSources: TrackingSource[];
  sourceLimit: number;
}

export async function sourceAvailable(env: Env, source: TrackingSource): Promise<boolean> {
  return (await availableSources(env)).includes(source);
}

export async function availableSources(env: Env): Promise<TrackingSource[]> {
  const configuration = await captureProviderConfiguration(env);
  return configuration.routes
    .filter((route) => route.enabled && route.effectiveProviderAccountId !== null)
    .map((route) => route.trackingSource);
}

export function scheduledForTrackingSource(
  scheduledFor: string,
  source: TrackingSource,
): string {
  if (source === "chatgpt") return scheduledFor;
  const timestamp = Date.parse(scheduledFor);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid scheduled time: ${scheduledFor}`);
  }
  return new Date(timestamp + TRACKING_SOURCES.indexOf(source)).toISOString();
}

export function planSourceEntitlement(planKey: PlanKey): SourceEntitlement {
  const templatePlan = DEFAULT_BILLING_PLANS.find((plan) => plan.id === planKey);
  if (templatePlan) {
    return {
      allowedSources: [...templatePlan.allowedSources],
      sourceLimit: templatePlan.sourceLimit,
    };
  }
  return { allowedSources: [...TRACKING_SOURCES], sourceLimit: 4 };
}

export async function workspaceSourceEntitlement(
  env: Env,
  workspaceId: string,
): Promise<SourceEntitlement & { planKey: PlanKey }> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT plan_key, billing_plan_id, source_limit, allowed_sources_json
     FROM billing_accounts WHERE workspace_id = ?`,
  ).bind(workspaceId).first<{
    plan_key: PlanKey;
    billing_plan_id: string | null;
    source_limit: number;
    allowed_sources_json: string;
  }>();
  if (!row) throw new ApiError(500, "entitlement_not_configured", "Workspace source access is not configured.");
  const storedSources = jsonParse<TrackingSource[]>(row.allowed_sources_json, [])
    .filter((source) => TRACKING_SOURCES.includes(source));
  const configured = storedSources.length
    ? { allowedSources: storedSources, sourceLimit: Number(row.source_limit) }
    : planSourceEntitlement(row.plan_key);
  const available = await availableSources(env);
  return {
    planKey: row.billing_plan_id ?? row.plan_key,
    allowedSources: configured.allowedSources.filter((source) => available.includes(source)),
    sourceLimit: Math.min(Number(row.source_limit), configured.sourceLimit, configured.allowedSources.length),
  };
}

export async function projectTrackingSources(
  env: Env,
  projectId: string,
): Promise<TrackingSource[]> {
  const rows = await env.CONTROL_DB.prepare(
    `SELECT source FROM project_tracking_sources
     WHERE project_id = ? AND enabled = 1 ORDER BY CASE source
       WHEN 'chatgpt' THEN 0 WHEN 'gemini' THEN 1
       WHEN 'google_ai_mode' THEN 2 ELSE 3 END`,
  ).bind(projectId).all<{ source: TrackingSource }>();
  return rows.results.length ? rows.results.map((row) => row.source) : [...DEFAULT_TRACKING_SOURCES];
}

export async function assertTrackingSourcesAllowed(
  env: Env,
  workspaceId: string,
  sources: TrackingSource[],
): Promise<SourceEntitlement & { planKey: PlanKey }> {
  const unique = [...new Set(sources)];
  const entitlement = await workspaceSourceEntitlement(env, workspaceId);
  if (unique.length === 0) {
    throw new ApiError(422, "tracking_source_required", "Keep at least one tracking source enabled.");
  }
  if (unique.length > entitlement.sourceLimit) {
    throw new ApiError(402, "source_limit", `This plan supports ${entitlement.sourceLimit} tracking source${entitlement.sourceLimit === 1 ? "" : "s"} per project.`);
  }
  const unavailable = unique.find((source) => !entitlement.allowedSources.includes(source));
  if (unavailable) {
    throw new ApiError(402, "tracking_source_unavailable", "This tracking source is not available on the current plan or deployment.", { source: unavailable });
  }
  return entitlement;
}
