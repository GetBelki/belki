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

  it("adds fan-out signal counts additively and schedules a version 7 backfill", () => {
    const sql = readFileSync(
      resolve("migrations/control/0021_fanout_signal_metrics.sql"),
      "utf8",
    );

    expect(sql).toMatch(/ADD COLUMN related_query_signal_counts_json/i);
    expect(sql).toMatch(/ADD COLUMN related_query_signal_counts_indexed_at/i);
    expect(sql).toMatch(/schema_version\s*=\s*7/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("adds navigation read indexes without rebuilding application tables", () => {
    const sql = readFileSync(
      resolve("migrations/control/0020_navigation_read_indexes.sql"),
      "utf8",
    );

    expect(sql).toMatch(
      /snapshot_index\s*\(\s*tracked_query_id,\s*tracking_source,\s*captured_at DESC,\s*id DESC/is,
    );
    expect(sql).toMatch(
      /crawl_jobs\s*\(\s*tracked_query_id,\s*tracking_source,\s*created_at DESC,\s*id DESC/is,
    );
    expect(sql).toMatch(
      /analytics_snapshot_facts\s*\(\s*project_id,\s*tracking_source,\s*metric_date,\s*tracked_query_id/is,
    );
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("adds fan-out model and telemetry metadata additively for a version 8 backfill", () => {
    const controlSql = readFileSync(
      resolve("migrations/control/0022_fanout_telemetry_models.sql"),
      "utf8",
    );
    const snapshotSql = readFileSync(
      resolve("migrations/snapshot/0006_fanout_telemetry.sql"),
      "utf8",
    );

    expect(controlSql).toMatch(/ADD COLUMN provider_model/i);
    expect(controlSql).toMatch(/ADD COLUMN fan_out_telemetry_status/i);
    expect(controlSql).toMatch(/ADD COLUMN fan_out_telemetry_indexed_at/i);
    expect(controlSql).toMatch(/schema_version\s*=\s*8/i);
    expect(snapshotSql).toMatch(/ADD COLUMN fan_out_telemetry_status/i);
    expect(snapshotSql).toMatch(/json_array_length\(fan_out_queries_json\)/i);
    expect(snapshotSql).toMatch(/CREATE TRIGGER snapshots_fanout_telemetry_infer_unknown/i);
    expect(`${controlSql}\n${snapshotSql}`).not.toMatch(/DROP TABLE/i);
  });
});
