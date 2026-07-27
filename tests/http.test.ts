import { describe, expect, it } from "vitest";
import { exclusiveDateEnd, jsonParse } from "../src/worker/lib/http";

describe("HTTP utilities", () => {
  it("builds an exclusive UTC date bound", () => {
    expect(exclusiveDateEnd("2026-12-31")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("falls back for malformed JSON", () => {
    expect(jsonParse("{", [])).toEqual([]);
  });
});
