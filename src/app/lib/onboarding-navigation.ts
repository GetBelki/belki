import type { Session } from "./api";

export const OPERATOR_PROVIDER_ONBOARDING_PATH = "/operator/onboarding/provider";
export const OPERATOR_PAYMENT_ONBOARDING_PATH = "/operator/onboarding/payments";

const PROJECTLESS_ROUTES = new Set([
  "/onboarding/project",
  "/onboarding/prompts",
  OPERATOR_PROVIDER_ONBOARDING_PATH,
  OPERATOR_PAYMENT_ONBOARDING_PATH,
  "/billing",
  "/operator",
]);

export function requiredOperatorOnboardingPath({
  isPlatformOperator,
  pathname,
  paymentSetupRequired,
  providerSetupRequired,
}: {
  isPlatformOperator: boolean;
  pathname: string;
  paymentSetupRequired: boolean;
  providerSetupRequired: boolean;
}): string | null {
  if (!isPlatformOperator) return null;
  const requiredPath = providerSetupRequired
    ? OPERATOR_PROVIDER_ONBOARDING_PATH
    : paymentSetupRequired
      ? OPERATOR_PAYMENT_ONBOARDING_PATH
      : null;
  return requiredPath && pathname !== requiredPath ? requiredPath : null;
}

export function needsProjectOnboarding(
  session: Session,
  pathname: string,
): boolean {
  if (session.workspace.status === "pending_payment") return false;
  if (session.user.role === "viewer") return false;
  if (session.projects.length > 0) return false;
  if (pathname.startsWith("/operator/")) return false;
  return !PROJECTLESS_ROUTES.has(pathname);
}

export function onboardingDestination(projectCount: number): string {
  return projectCount > 0 ? "/onboarding/prompts" : "/onboarding/project";
}
