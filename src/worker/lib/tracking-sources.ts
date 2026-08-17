import type { PlanKey, TrackingSource } from "../../shared/contracts";
import { DEFAULT_TRACKING_SOURCES, TRACKING_SOURCES } from "../../shared/tracking-sources";
import { ApiError } from "./http";

export interface SourceEntitlement {
  allowedSources: TrackingSource[];
  sourceLimit: number;
}

function flag(env: Env, name: string): boolean {
  return Reflect.get(env, name) === "true";
}

export function sourceAvailable(env: Env, source: TrackingSource): boolean {
  if (source === "chatgpt") return true;
  if (source === "gemini") return flag(env, "TRACKING_SOURCE_GEMINI_ENABLED");
  if (source === "google_ai_mode") return flag(env, "TRACKING_SOURCE_GOOGLE_AI_MODE_ENABLED");
  return flag(env, "TRACKING_SOURCE_GOOGLE_AI_OVERVIEW_ENABLED");
}

export function availableSources(env: Env): TrackingSource[] {
  return TRACKING_SOURCES.filter((source) => sourceAvailable(env, source));
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
  if (planKey === "starter") return { allowedSources: ["chatgpt"], sourceLimit: 1 };
  if (planKey === "studio") return { allowedSources: [...TRACKING_SOURCES], sourceLimit: 2 };
  return { allowedSources: [...TRACKING_SOURCES], sourceLimit: 4 };
}

export async function workspaceSourceEntitlement(
  env: Env,
  workspaceId: string,
): Promise<SourceEntitlement & { planKey: PlanKey }> {
  const row = await env.CONTROL_DB.prepare(
    "SELECT plan_key, source_limit FROM billing_accounts WHERE workspace_id = ?",
  ).bind(workspaceId).first<{ plan_key: PlanKey; source_limit: number }>();
  if (!row) throw new ApiError(500, "entitlement_not_configured", "Workspace source access is not configured.");
  const configured = planSourceEntitlement(row.plan_key);
  return {
    planKey: row.plan_key,
    allowedSources: configured.allowedSources.filter((source) => sourceAvailable(env, source)),
    sourceLimit: Math.min(Number(row.source_limit), configured.sourceLimit),
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
