import { describe, expect, it } from "vitest";
import type { PlanKey } from "../src/shared/contracts";
import { planAllowsManualRuns } from "../src/shared/plan-access";

describe("plan access", () => {
  it("allows manual tracking for self-hosted workspaces", () => {
    expect(planAllowsManualRuns("self_hosted")).toBe(true);
  });

  it.each<PlanKey>(["starter", "studio", "agency", "custom"])(
    "keeps manual tracking unavailable for the %s plan",
    (planKey) => {
      expect(planAllowsManualRuns(planKey)).toBe(false);
    },
  );
});
