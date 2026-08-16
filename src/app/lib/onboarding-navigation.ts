import type { Session } from "./api";

const PROJECTLESS_ROUTES = new Set([
  "/onboarding/project",
  "/onboarding/prompts",
  "/billing",
  "/operator",
]);

export function needsProjectOnboarding(
  session: Session,
  pathname: string,
): boolean {
  if (session.workspace.status === "pending_payment") return false;
  if (session.user.role === "viewer") return false;
  if (session.projects.length > 0) return false;
  return !PROJECTLESS_ROUTES.has(pathname);
}

export function onboardingDestination(projectCount: number): string {
  return projectCount > 0 ? "/onboarding/prompts" : "/onboarding/project";
}
