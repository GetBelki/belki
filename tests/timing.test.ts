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
});
