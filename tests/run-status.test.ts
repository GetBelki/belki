import { describe, expect, it } from "vitest";
import {
  isRunInProgress,
  runStatusLabel,
} from "../src/app/lib/run-status";

describe("run status presentation", () => {
  it.each([
    "queued",
    "submitting",
    "submission_unknown",
    "submitted",
    "awaiting_result",
    "normalizing",
  ] as const)("keeps polling while a run is %s", (status) => {
    expect(isRunInProgress(status)).toBe(true);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "stops polling after a run is %s",
    (status) => {
      expect(isRunInProgress(status)).toBe(false);
    },
  );

  it("shows the provider wait and normalization stages", () => {
    expect(runStatusLabel("awaiting_result")).toBe("Waiting for result…");
    expect(runStatusLabel("normalizing")).toBe("Saving result…");
    expect(runStatusLabel("completed")).toBe("Run now");
  });
});
