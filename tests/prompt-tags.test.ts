import { describe, expect, it } from "vitest";
import {
  PROMPT_TAG_COLOR_COUNT,
  normalizePromptTagName,
  promptTagColorIndex,
  uniquePromptTagNames,
} from "../src/shared/prompt-tags";

describe("prompt tags", () => {
  it("normalizes surrounding and repeated whitespace", () => {
    expect(normalizePromptTagName("  Funnel   stage  ")).toBe("Funnel stage");
  });

  it("reuses names case-insensitively while preserving the first display value", () => {
    expect(
      uniquePromptTagNames(["Awareness", " awareness ", "Product", "PRODUCT"]),
    ).toEqual(["Awareness", "Product"]);
  });

  it("assigns a stable pastel color slot", () => {
    const first = promptTagColorIndex("Comparison");
    expect(promptTagColorIndex(" comparison ")).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(PROMPT_TAG_COLOR_COUNT);
  });
});
