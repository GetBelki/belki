import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("control database migrations", () => {
  it("adds tracking sources without rebuilding the crawl_jobs parent table", () => {
    const sql = readFileSync(
      resolve("migrations/control/0017_tracking_sources.sql"),
      "utf8",
    );

    expect(sql).toMatch(
      /ALTER TABLE crawl_jobs ADD COLUMN tracking_source/i,
    );
    expect(sql).not.toMatch(/DROP TABLE crawl_jobs/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });
});
