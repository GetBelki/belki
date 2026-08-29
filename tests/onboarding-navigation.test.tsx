import { describe, expect, it } from "vitest";
import type { Session } from "../src/app/lib/api";
import {
  needsProjectOnboarding,
  onboardingDestination,
  OPERATOR_PAYMENT_ONBOARDING_PATH,
  OPERATOR_PROVIDER_ONBOARDING_PATH,
  requiredOperatorOnboardingPath,
} from "../src/app/lib/onboarding-navigation";

function session(overrides: Partial<Session> = {}): Session {
  return {
    user: {
      id: "user-1",
      email: "owner@example.com",
      displayName: "Owner",
      role: "owner",
    },
    workspaceId: "workspace-1",
    workspace: {
      id: "workspace-1",
      name: "Workspace",
      publicBaseUrl: "https://tracker.example.com",
      status: "active",
      plan_key: "starter",
    },
    workspaces: [],
    projects: [],
    isPlatformOperator: false,
    capabilities: {
      emailDelivery: false,
      publicOriginManaged: false,
    },
    ...overrides,
  };
}

describe("project onboarding navigation", () => {
  it("sends an active projectless owner into onboarding", () => {
    expect(needsProjectOnboarding(session(), "/")).toBe(true);
    expect(needsProjectOnboarding(session(), "/settings")).toBe(true);
  });

  it("keeps payment, operator, and onboarding routes reachable", () => {
    expect(needsProjectOnboarding(session(), "/onboarding/project")).toBe(false);
    expect(needsProjectOnboarding(session(), "/onboarding/prompts")).toBe(false);
    expect(needsProjectOnboarding(session(), OPERATOR_PROVIDER_ONBOARDING_PATH)).toBe(false);
    expect(needsProjectOnboarding(session(), OPERATOR_PAYMENT_ONBOARDING_PATH)).toBe(false);
    expect(needsProjectOnboarding(session(), "/billing")).toBe(false);
    expect(needsProjectOnboarding(session({ isPlatformOperator: true }), "/operator")).toBe(false);
    expect(needsProjectOnboarding(
      session({ isPlatformOperator: true }),
      "/operator/insights/citations",
    )).toBe(false);
    expect(needsProjectOnboarding(
      session({ isPlatformOperator: true }),
      "/operator/insights/fan-out",
    )).toBe(false);
    expect(needsProjectOnboarding(session({
      workspace: {
        id: "workspace-1",
        name: "Workspace",
        publicBaseUrl: "https://tracker.example.com",
        status: "pending_payment",
        plan_key: "starter",
      },
    }), "/billing")).toBe(false);
  });

  it("does not force viewers or established workspaces through creation", () => {
    expect(needsProjectOnboarding(session({ user: { ...session().user, role: "viewer" } }), "/")).toBe(false);
    expect(needsProjectOnboarding(session({ projects: [{
      id: "project-1",
      name: "Project",
      primary_domain: null,
      html_capture_enabled: 0,
      query_count: 0,
      last_snapshot_at: null,
      ads_count: 0,
      products_count: 0,
    }] }), "/")).toBe(false);
  });

  it("chooses the correct continuation after checkout", () => {
    expect(onboardingDestination(0)).toBe("/onboarding/project");
    expect(onboardingDestination(1)).toBe("/onboarding/prompts");
  });

  it("places sensitive installation setup behind the Operator Access boundary", () => {
    expect(OPERATOR_PROVIDER_ONBOARDING_PATH).toBe("/operator/onboarding/provider");
    expect(OPERATOR_PAYMENT_ONBOARDING_PATH).toBe("/operator/onboarding/payments");
    expect(requiredOperatorOnboardingPath({
      isPlatformOperator: true,
      pathname: "/",
      paymentSetupRequired: true,
      providerSetupRequired: false,
    })).toBe(OPERATOR_PAYMENT_ONBOARDING_PATH);
    expect(requiredOperatorOnboardingPath({
      isPlatformOperator: true,
      pathname: OPERATOR_PAYMENT_ONBOARDING_PATH,
      paymentSetupRequired: true,
      providerSetupRequired: false,
    })).toBeNull();
  });
});
