import { describe, expect, it } from "vitest";
import {
  SOURCE_DISCOVERY_WINDOW_DAYS,
  SOURCE_DISCOVERY_WINDOWS_PER_RUN,
  sourceDiscoveryBackfillEstimatedMinutes,
} from "../src/worker/ingestion/source-discovery";

describe("source-discovery backfill", () => {
  it("processes retained history in large set-based windows", () => {
    expect(SOURCE_DISCOVERY_WINDOW_DAYS).toBe(31);
    expect(SOURCE_DISCOVERY_WINDOWS_PER_RUN).toBe(12);
  });

  it("estimates completion in a few minute-cron runs instead of per snapshot", () => {
    expect(sourceDiscoveryBackfillEstimatedMinutes(null, null)).toBe(0);
    expect(sourceDiscoveryBackfillEstimatedMinutes(
      "2026-08-28",
      "2026-08-28",
    )).toBe(1);
    expect(sourceDiscoveryBackfillEstimatedMinutes(
      "2025-08-22",
      "2026-08-28",
    )).toBe(1);
    expect(sourceDiscoveryBackfillEstimatedMinutes(
      "2024-08-28",
      "2026-08-28",
    )).toBe(2);
  });
});
