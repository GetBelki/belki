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

  it("adds operator insight facts additively and schedules a version 6 backfill", () => {
    const sql = readFileSync(
      resolve("migrations/control/0018_operator_insights.sql"),
      "utf8",
    );

    expect(sql).toMatch(/ADD COLUMN related_site_query_present/i);
    expect(sql).toMatch(/ADD COLUMN related_review_query_present/i);
    expect(sql).toMatch(/ADD COLUMN related_query_years_json/i);
    expect(sql).toMatch(/ADD COLUMN related_query_insights_indexed_at/i);
    expect(sql).toMatch(/schema_version\s*=\s*6/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("adds the product competition lookup index without rebuilding analytics data", () => {
    const sql = readFileSync(
      resolve("migrations/control/0019_product_competition_index.sql"),
      "utf8",
    );

    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/i);
    expect(sql).toMatch(
      /analytics_product_occurrences\s*\(\s*project_id,\s*snapshot_id,\s*ordinal,\s*product_row_id/is,
    );
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });
});
