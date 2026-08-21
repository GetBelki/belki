import { describe, expect, it } from "vitest";
import {
  ANALYTICS_READ_MODEL_SCHEMA_VERSION,
  RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION,
  analyticsBackfillEstimatedMinutes,
  analyticsReadModelSupports,
} from "../src/worker/lib/analytics-read-model";

describe("analytics read-model compatibility", () => {
  it("keeps version 4 related-query reports available after later upgrades", () => {
    const current = {
      status: "ready",
      schema_version: ANALYTICS_READ_MODEL_SCHEMA_VERSION,
    };

    expect(
      analyticsReadModelSupports(
        current,
        RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION,
      ),
    ).toBe(true);
  });

  it("uses version 7 for response-level fan-out signal counts", () => {
    expect(ANALYTICS_READ_MODEL_SCHEMA_VERSION).toBe(7);
  });

  it("requires the requested schema capability and a completed backfill", () => {
    expect(analyticsReadModelSupports({ status: "ready", schema_version: 4 }))
      .toBe(false);
    expect(analyticsReadModelSupports({ status: "backfilling", schema_version: 5 }))
      .toBe(false);
    expect(analyticsReadModelSupports(null)).toBe(false);
  });

  it("accepts later compatible schema versions", () => {
    expect(analyticsReadModelSupports({ status: "ready", schema_version: 7 }))
      .toBe(true);
  });

  it("estimates minute-cron backfill time from the batch size", () => {
    expect(analyticsBackfillEstimatedMinutes(0)).toBe(0);
    expect(analyticsBackfillEstimatedMinutes(1)).toBe(1);
    expect(analyticsBackfillEstimatedMinutes(50)).toBe(1);
    expect(analyticsBackfillEstimatedMinutes(51)).toBe(2);
    expect(analyticsBackfillEstimatedMinutes(686)).toBe(14);
  });
});
