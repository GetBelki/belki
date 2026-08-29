import type { TrackingSource } from "./tracking-sources";

export const MAX_BILLING_PLANS = 8;

export interface BillingPlanDefinition {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  featured: boolean;
  monthlyUnits: number;
  projectLimit: number;
  promptLimit: number;
  sourceLimit: number;
  allowedSources: TrackingSource[];
}

export const DEFAULT_BILLING_PLANS: readonly BillingPlanDefinition[] = [
  {
    id: "starter",
    name: "Starter",
    description: "A single brand getting started",
    sortOrder: 0,
    featured: false,
    monthlyUnits: 4_000,
    projectLimit: 1,
    promptLimit: 25,
    sourceLimit: 1,
    allowedSources: ["chatgpt"],
  },
  {
    id: "studio",
    name: "Studio",
    description: "Growing teams and consultants",
    sortOrder: 1,
    featured: true,
    monthlyUnits: 20_000,
    projectLimit: 5,
    promptLimit: 75,
    sourceLimit: 2,
    allowedSources: ["chatgpt", "gemini", "google_ai_mode", "google_ai_overview"],
  },
  {
    id: "agency",
    name: "Agency",
    description: "Agencies and multi-brand teams",
    sortOrder: 2,
    featured: false,
    monthlyUnits: 125_000,
    projectLimit: 30,
    promptLimit: 250,
    sourceLimit: 4,
    allowedSources: ["chatgpt", "gemini", "google_ai_mode", "google_ai_overview"],
  },
] as const;

export function legacyWorkspacePlanKey(planId: string): "starter" | "studio" | "agency" | "custom" {
  return planId === "starter" || planId === "studio" || planId === "agency"
    ? planId
    : "custom";
}

export function legacyTransactionalPlanKey(planId: string): "starter" | "studio" | "agency" {
  return planId === "starter" || planId === "studio" || planId === "agency"
    ? planId
    : "starter";
}
