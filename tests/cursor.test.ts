import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/worker/lib/cursor";

describe("opaque pagination cursors", () => {
  it("round-trips stable sort values without exposing them in the URL", () => {
    const cursor = encodeCursor("shopping", {
      appearances: 12,
      capturedAt: "2026-07-30T08:00:00.000Z",
      key: "fallback:Käse|shop.example",
    });

    expect(cursor).not.toContain("2026-07-30");
    expect(decodeCursor(cursor, "shopping")).toEqual({
      appearances: 12,
      capturedAt: "2026-07-30T08:00:00.000Z",
      key: "fallback:Käse|shop.example",
    });
  });

  it("rejects a cursor from another report", () => {
    const cursor = encodeCursor("prompts", { id: "prompt-1" });
    expect(() => decodeCursor(cursor, "snapshots")).toThrow(
      "pagination cursor is invalid",
    );
  });

  it("rejects malformed input", () => {
    expect(() => decodeCursor("definitely-not-a-cursor", "prompts")).toThrow(
      "pagination cursor is invalid",
    );
  });
});
