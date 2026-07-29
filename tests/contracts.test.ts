import { describe, expect, it } from "vitest";
import {
  BulkQueryInputSchema,
  ProjectInputSchema,
  ProjectUpdateSchema,
  QueryInputSchema,
  SetupSchema,
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
});
