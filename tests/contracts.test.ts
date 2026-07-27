import { describe, expect, it } from "vitest";
import {
  ProjectInputSchema,
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
});
