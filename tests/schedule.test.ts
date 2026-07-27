import { describe, expect, it } from "vitest";
import { calculateNextRun, scheduleFromRow } from "../src/worker/lib/schedule";

describe("scheduling", () => {
  it("moves a daily run through a daylight-saving gap", () => {
    const next = calculateNextRun(
      { cadence: "daily", time: "02:30", timezone: "Europe/Berlin" },
      new Date("2026-03-28T22:30:00.000Z"),
    );
    expect(next).toBe("2026-03-29T01:30:00Z");
  });

  it("schedules weekly runs using Sunday as zero", () => {
    const next = calculateNextRun(
      { cadence: "weekly", weekday: 1, time: "09:00", timezone: "Europe/Berlin" },
      new Date("2026-07-26T12:00:00.000Z"),
    );
    expect(next).toBe("2026-07-27T07:00:00Z");
  });

  it("reconstructs a daily schedule from a database row", () => {
    expect(
      scheduleFromRow({
        schedule_cadence: "daily",
        schedule_time: "08:15",
        schedule_timezone: "UTC",
        schedule_weekday: null,
      }),
    ).toEqual({ cadence: "daily", time: "08:15", timezone: "UTC" });
  });
});
