import { describe, expect, it, vi } from "vitest";
import { RequestTiming } from "../src/worker/lib/timing";

describe("request timing", () => {
  it("records measured operations and serializes a Server-Timing header", async () => {
    const timing = new RequestTiming();

    await timing.measure("control db", async () => {
      await Promise.resolve();
    });

    const header = timing.toServerTiming();
    expect(header).toMatch(/control_db;dur=\d+\.\d/);
    expect(header).toMatch(/total;dur=\d+\.\d/);
  });

  it("sanitizes metric names and descriptions", () => {
    const timing = new RequestTiming();
    timing.add("Project Access!!", 12.345, 'workspace "lookup"\n');

    expect(timing.toServerTiming()).toContain(
      'project_access;dur=12.3;desc="workspace  lookup"',
    );
  });

  it("aggregates repeated operation names", () => {
    const timing = new RequestTiming();
    timing.add("analytics_read_model", 10.1);
    timing.add("analytics_read_model", 4.2);

    expect(timing.toServerTiming()).toContain("analytics_read_model;dur=14.3");
    expect(timing.toLogRecord()).toMatchObject({
      analytics_read_model: 14.3,
    });
  });

  it("records failed operations", async () => {
    const timing = new RequestTiming();
    const operation = vi.fn(() => {
      throw new Error("failed");
    });

    await expect(timing.measure("failed_step", operation)).rejects.toThrow("failed");
    expect(timing.toLogRecord()).toHaveProperty("failed_step");
  });

  it("aggregates D1 execution metadata from batches", async () => {
    const timing = new RequestTiming();
    await timing.measureD1("navigation_db", () => Promise.resolve([
      {
        meta: {
          duration: 3.2,
          rows_read: 12,
          rows_written: 0,
          served_by_region: "WEUR",
          served_by_colo: "FRA",
          served_by_primary: false,
          total_attempts: 1,
        },
      },
      {
        meta: {
          duration: 1.3,
          rows_read: 4,
          rows_written: 1,
          served_by_region: "WEUR",
          served_by_colo: "FRA",
          served_by_primary: true,
          total_attempts: 2,
        },
      },
    ]));

    expect(timing.toD1LogRecord()).toEqual({
      calls: 2,
      durationMs: 4.5,
      rowsRead: 16,
      rowsWritten: 1,
      primaryCalls: 1,
      retryAttempts: 1,
      regions: ["WEUR"],
      colos: ["FRA"],
    });
  });
});
