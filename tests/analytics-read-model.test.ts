import { describe, expect, it } from "vitest";
import {
  ANALYTICS_READ_MODEL_SCHEMA_VERSION,
  RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION,
  analyticsReadModelSupports,
} from "../src/worker/lib/analytics-read-model";

describe("analytics read-model compatibility", () => {
  it("keeps version 4 related-query reports available after version 5 upgrades", () => {
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

  it("requires the requested schema capability and a completed backfill", () => {
    expect(analyticsReadModelSupports({ status: "ready", schema_version: 4 }))
      .toBe(false);
    expect(analyticsReadModelSupports({ status: "backfilling", schema_version: 5 }))
      .toBe(false);
    expect(analyticsReadModelSupports(null)).toBe(false);
  });

  it("accepts later compatible schema versions", () => {
    expect(analyticsReadModelSupports({ status: "ready", schema_version: 6 }))
      .toBe(true);
  });
});
