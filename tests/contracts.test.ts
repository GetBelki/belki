import { describe, expect, it } from "vitest";
import {
  BulkQueryInputSchema,
  EntityExtractionSettingsSchema,
  PromptPurgeInputSchema,
  ProjectBillingAlertsSchema,
  ProjectFeatureSettingsSchema,
  ProjectInputSchema,
  ProjectUpdateSchema,
  QueryInputSchema,
  SetupSchema,
  SignupCodeRedeemSchema,
  BillingCheckoutSchema,
  BillingCancellationSchema,
  BillingPlanChangeSchema,
  WorkspaceUpdateSchema,
} from "../src/shared/contracts";

describe("API contracts", () => {
  it("requires a strong installation password", () => {
    const result = SetupSchema.safeParse({
      bootstrapToken: "a".repeat(32),
      workspaceName: "Example",
      displayName: "Owner",
      email: "owner@example.com",
      password: "too-short",
    });
    expect(result.success).toBe(false);
  });

  it("validates invite-only workspace signup and public billing plans", () => {
    expect(SignupCodeRedeemSchema.parse({
      code: "a".repeat(32),
      email: "  OWNER@example.com ",
      workspaceName: " Agency ",
      displayName: " Owner ",
      password: "a-secure-password",
    })).toMatchObject({
      email: "OWNER@example.com",
      workspaceName: "Agency",
      timezone: "UTC",
    });
    expect(BillingCheckoutSchema.parse({ planKey: "studio" })).toEqual({ planKey: "studio" });
    expect(BillingCheckoutSchema.safeParse({ planKey: "custom" }).success).toBe(false);
    expect(BillingPlanChangeSchema.parse({ planKey: "agency" })).toEqual({
      planKey: "agency",
      replacePending: false,
    });
    expect(BillingPlanChangeSchema.parse({ planKey: "starter", replacePending: true })).toEqual({
      planKey: "starter",
      replacePending: true,
    });
    expect(BillingPlanChangeSchema.safeParse({ planKey: "self_hosted" }).success).toBe(false);
    expect(BillingCancellationSchema.parse({})).toEqual({ replacePending: false });
  });

  it("trims workspace names and rejects blank names", () => {
    expect(WorkspaceUpdateSchema.parse({ name: "  Acme team  " })).toEqual({
      name: "Acme team",
    });
    expect(WorkspaceUpdateSchema.safeParse({ name: " " }).success).toBe(false);
  });

  it("rejects malformed schedules", () => {
    const result = QueryInputSchema.safeParse({
      queryText: "best analytics platform",
      locationCode: 2840,
      languageCode: "en",
      schedule: { cadence: "weekly", weekday: 8, time: "25:00", timezone: "UTC" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts up to 50 prompts with shared bulk settings", () => {
    const result = BulkQueryInputSchema.parse({
      queryTexts: ["best analytics platform", "best reporting platform"],
      locationCode: 2840,
      languageCode: "en",
      schedule: { cadence: "daily", time: "09:00", timezone: "UTC" },
    });
    expect(result.queryTexts).toHaveLength(2);
    expect(result.forceWebSearch).toBe(true);
    expect(result.tags).toEqual([]);
  });

  it("rejects bulk prompt uploads above the limit", () => {
    const result = BulkQueryInputSchema.safeParse({
      queryTexts: Array.from({ length: 51 }, (_, index) => `Prompt ${index + 1}`),
      locationCode: 2840,
      languageCode: "en",
      schedule: { cadence: "daily", time: "09:00", timezone: "UTC" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts up to 50 unique prompt ids for permanent purge", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    expect(
      PromptPurgeInputSchema.parse({ queryIds: [first, second, first] }),
    ).toEqual({ queryIds: [first, second] });
  });

  it("rejects empty, malformed, and oversized prompt purge requests", () => {
    expect(PromptPurgeInputSchema.safeParse({ queryIds: [] }).success).toBe(false);
    expect(
      PromptPurgeInputSchema.safeParse({ queryIds: ["not-a-uuid"] }).success,
    ).toBe(false);
    expect(
      PromptPurgeInputSchema.safeParse({
        queryIds: Array.from(
          { length: 51 },
          (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("accepts bulk prompts with individual tags", () => {
    const result = BulkQueryInputSchema.parse({
      items: [
        { queryText: "Is Acme trusted?", tags: ["Trust"] },
        { queryText: "Is Acme safe?", tags: ["Safety"] },
      ],
      tags: ["Reputation"],
      locationCode: 2840,
      languageCode: "en",
      schedule: { cadence: "daily", time: "09:00", timezone: "UTC" },
    });
    expect(result.items?.[0]?.tags).toEqual(["Trust"]);
    expect(result.queryTexts).toBeUndefined();
  });

  it("requires exactly one bulk prompt input shape", () => {
    const base = {
      locationCode: 2840,
      languageCode: "en",
      schedule: { cadence: "daily", time: "09:00", timezone: "UTC" },
    };
    expect(BulkQueryInputSchema.safeParse(base).success).toBe(false);
    expect(
      BulkQueryInputSchema.safeParse({
        ...base,
        queryTexts: ["Prompt one"],
        items: [{ queryText: "Prompt two", tags: [] }],
      }).success,
    ).toBe(false);
  });

  it("applies safe project defaults", () => {
    const result = ProjectInputSchema.parse({
      name: "Acme",
      primaryDomain: "acme.example",
      ownedBrandName: "Acme",
    });
    expect(result).toMatchObject({
      ownedBrandAliases: [],
      competitorBrands: [],
      htmlCaptureEnabled: false,
    });
  });

  it("accepts enabling HTML retention on an existing project", () => {
    expect(
      ProjectUpdateSchema.parse({ htmlCaptureEnabled: true }),
    ).toEqual({ htmlCaptureEnabled: true });
  });

  it("accepts independent entity extraction and auto-track settings", () => {
    expect(EntityExtractionSettingsSchema.parse({
      enabled: true,
      autoTrackEnabled: false,
      monthlyWarningUsd: 5,
    })).toEqual({ enabled: true, autoTrackEnabled: false, monthlyWarningUsd: 5 });
    expect(EntityExtractionSettingsSchema.safeParse({}).success).toBe(false);
  });

  it("accepts project-scoped feature switches and rejects empty updates", () => {
    expect(ProjectFeatureSettingsSchema.parse({
      productEnrichmentEnabled: true,
      entityExtractionEnabled: true,
      entityAutoTrackEnabled: false,
    })).toEqual({
      productEnrichmentEnabled: true,
      entityExtractionEnabled: true,
      entityAutoTrackEnabled: false,
    });
    expect(ProjectFeatureSettingsSchema.safeParse({}).success).toBe(false);
  });

  it("validates project billing alerts independently by workload", () => {
    expect(ProjectBillingAlertsSchema.parse({
      productEnrichmentWarningUsd: 10,
      entityExtractionWarningUsd: 5,
    })).toEqual({
      productEnrichmentWarningUsd: 10,
      entityExtractionWarningUsd: 5,
    });
    expect(ProjectBillingAlertsSchema.safeParse({ productEnrichmentWarningUsd: -1 }).success).toBe(false);
  });

  it("normalizes and de-duplicates prompt tags without changing their display case", () => {
    const result = QueryInputSchema.parse({
      queryText: "best analytics platform",
      locationCode: 2840,
      languageCode: "en",
      schedule: { cadence: "daily", time: "09:00", timezone: "UTC" },
      tags: ["  Awareness  ", "Product   research", "awareness"],
    });
    expect(result.tags).toEqual(["Awareness", "Product research"]);
  });

  it("enforces prompt tag count and length limits", () => {
    const base = {
      queryText: "best analytics platform",
      locationCode: 2840,
      languageCode: "en",
      schedule: { cadence: "daily", time: "09:00", timezone: "UTC" },
    };
    expect(
      QueryInputSchema.safeParse({
        ...base,
        tags: Array.from({ length: 11 }, (_, index) => `Tag ${index}`),
      }).success,
    ).toBe(false);
    expect(
      QueryInputSchema.safeParse({
        ...base,
        tags: ["x".repeat(41)],
      }).success,
    ).toBe(false);
  });
});
