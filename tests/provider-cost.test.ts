import { describe, expect, it } from "vitest";
import { resolveProviderCost } from "../src/shared/provider-cost";

describe("provider cost", () => {
  it("prefers the charged submission cost over a zero result-fetch cost", () => {
    expect(resolveProviderCost(0.0024, 0)).toBe(0.0024);
  });

  it("falls back to a positive result cost when no submission cost exists", () => {
    expect(resolveProviderCost(null, 0.004)).toBe(0.004);
  });

  it("preserves a genuine zero and ignores invalid values", () => {
    expect(resolveProviderCost(Number.NaN, -1, 0)).toBe(0);
    expect(resolveProviderCost(null, undefined)).toBeNull();
  });
});
