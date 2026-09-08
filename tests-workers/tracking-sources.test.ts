import { describe, expect, it } from "vitest";
import { CAPTURE_PROVIDER_SOURCES } from "../src/shared/capture-providers";
import { DEFAULT_BILLING_PLANS } from "../src/shared/billing-plans";
import { TRACKING_SOURCES } from "../src/shared/tracking-sources";
import {
  availableSources,
  planSourceEntitlement,
  scheduledForTrackingSource,
  workspaceSourceEntitlement,
} from "../src/worker/lib/tracking-sources";

function providerEnv(
  enabledSources: readonly string[],
  billing?: {
    planKey: string;
    sourceLimit: number;
    allowedSources: readonly string[];
  },
): Env {
  return {
    DATAFORSEO_LOGIN: "operator@example.com",
    DATAFORSEO_PASSWORD: "secret",
    CONTROL_DB: {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          first() {
            if (sql.includes("FROM billing_accounts")) {
              return billing ? {
                plan_key: "custom",
                billing_plan_id: billing.planKey,
                source_limit: billing.sourceLimit,
                allowed_sources_json: JSON.stringify(billing.allowedSources),
              } : null;
            }
            return null;
          },
          all() {
            if (sql.includes("FROM capture_provider_accounts")) {
              return {
                results: [{
                  id: "legacy:dataforseo:environment",
                  provider: "dataforseo",
                  label: "DataForSEO (environment)",
                  status: "active",
                  credential_source: "environment",
                  active_credential_version: null,
                  is_default: 1,
                  priority: 10,
                  last_test_status: null,
                  last_tested_at: null,
                  last_test_message: null,
                  created_at: "2026-08-28T00:00:00.000Z",
                  updated_at: "2026-08-28T00:00:00.000Z",
                }],
              };
            }
            return {
              results: TRACKING_SOURCES.map((source) => ({
                tracking_source: source,
                enabled: enabledSources.includes(source) ? 1 : 0,
                provider_account_id: null,
                updated_at: "2026-08-28T00:00:00.000Z",
              })),
            };
          },
        };
        return statement;
      },
    },
  } as unknown as Env;
}

describe("tracking source entitlements", () => {
  it("keeps optional platforms behind operator-controlled provider routes", async () => {
    await expect(availableSources(providerEnv(["chatgpt"]))).resolves.toEqual(["chatgpt"]);
    await expect(availableSources(providerEnv(["chatgpt", "gemini"])))
      .resolves.toEqual(["chatgpt", "gemini"]);
    await expect(availableSources(providerEnv(TRACKING_SOURCES))).resolves.toEqual(CAPTURE_PROVIDER_SOURCES.dataforseo);
  });

  it("matches the public prompt, project, and source limits", () => {
    expect(DEFAULT_BILLING_PLANS.find((plan) => plan.id === "starter")).toMatchObject({
      promptLimit: 25,
      projectLimit: 1,
      sourceLimit: 1,
    });
    expect(DEFAULT_BILLING_PLANS.find((plan) => plan.id === "studio")).toMatchObject({
      promptLimit: 75,
      projectLimit: 5,
      sourceLimit: 2,
    });
    expect(DEFAULT_BILLING_PLANS.find((plan) => plan.id === "agency")).toMatchObject({
      promptLimit: 250,
      projectLimit: 30,
      sourceLimit: 4,
    });
    expect(planSourceEntitlement("starter")).toEqual({
      allowedSources: ["chatgpt"],
      sourceLimit: 1,
    });
    expect(planSourceEntitlement("studio")).toEqual({
      allowedSources: [...CAPTURE_PROVIDER_SOURCES.dataforseo],
      sourceLimit: 2,
    });
  });

  it("keeps legacy schedule uniqueness while separating source jobs", () => {
    const scheduledFor = "2026-08-17T12:00:00.000Z";
    expect(scheduledForTrackingSource(scheduledFor, "chatgpt")).toBe(scheduledFor);
    expect(scheduledForTrackingSource(scheduledFor, "gemini"))
      .toBe("2026-08-17T12:00:00.001Z");
    expect(scheduledForTrackingSource(scheduledFor, "google_ai_mode"))
      .toBe("2026-08-17T12:00:00.002Z");
    expect(scheduledForTrackingSource(scheduledFor, "google_ai_overview"))
      .toBe("2026-08-17T12:00:00.003Z");
  });

  it("enforces allowed sources stored by an installer-defined plan", async () => {
    await expect(workspaceSourceEntitlement(providerEnv(
      ["chatgpt", "gemini", "google_ai_mode"],
      {
        planKey: "latam_growth",
        sourceLimit: 2,
        allowedSources: ["gemini", "google_ai_mode"],
      },
    ), "workspace-example")).resolves.toEqual({
      planKey: "latam_growth",
      sourceLimit: 2,
      allowedSources: ["gemini", "google_ai_mode"],
    });
  });
});
