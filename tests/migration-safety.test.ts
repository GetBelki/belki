import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("control database migrations", () => {
  it("adds capture providers and provenance without rebuilding job or snapshot tables", () => {
    const controlSql = readFileSync(
      resolve("migrations/control/0029_capture_providers.sql"),
      "utf8",
    );
    const snapshotSql = readFileSync(
      resolve("migrations/snapshot/0007_capture_providers.sql"),
      "utf8",
    );

    expect(controlSql).toMatch(/CREATE TABLE capture_provider_accounts/i);
    expect(controlSql).toMatch(/CREATE TABLE capture_provider_credentials/i);
    expect(controlSql).toMatch(/CREATE TABLE capture_provider_routes/i);
    expect(controlSql).toMatch(/CREATE TABLE capture_provider_attempts/i);
    expect(controlSql).toMatch(/capture_provider_attempts_activity_idx/i);
    expect(controlSql).toMatch(/ADD COLUMN capture_provider/i);
    expect(controlSql).toMatch(
      /project_tracking_sources WHERE source = 'gemini' AND enabled = 1/i,
    );
    expect(snapshotSql).toMatch(/ADD COLUMN capture_provider_attempt_id/i);
    expect(`${controlSql}\n${snapshotSql}`).not.toMatch(/DROP TABLE/i);
    expect(`${controlSql}\n${snapshotSql}`).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("adds modular payment accounts, encrypted credentials, and provider-neutral links additively", () => {
    const sql = readFileSync(
      resolve("migrations/control/0030_payment_providers.sql"),
      "utf8",
    );

    expect(sql).toMatch(/CREATE TABLE payment_provider_accounts/i);
    expect(sql).toMatch(/CREATE TABLE payment_provider_credentials/i);
    expect(sql).toMatch(/CREATE TABLE payment_provider_plan_catalog/i);
    expect(sql).toMatch(/CREATE TABLE payment_configuration/i);
    expect(sql).toMatch(/mode IN \('undecided', 'self_hosted', 'managed'\)/i);
    expect(sql).toMatch(/THEN 'managed' ELSE 'undecided'/i);
    expect(sql).toMatch(/CREATE TABLE workspace_billing_subscriptions/i);
    expect(sql).toMatch(/ADD COLUMN payment_provider_account_id/i);
    expect(sql).toMatch(/ADD COLUMN external_subscription_id/i);
    expect(sql).toMatch(/billing_events_provider_external_idx/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("adds installation-defined billing plans without rebuilding legacy billing tables", () => {
    const sql = readFileSync(
      resolve("migrations/control/0031_dynamic_billing_plans.sql"),
      "utf8",
    );

    expect(sql).toMatch(/CREATE TABLE billing_plans/i);
    expect(sql).toMatch(/CREATE TABLE payment_provider_plan_mappings/i);
    expect(sql).toMatch(/ADD COLUMN billing_plan_id/i);
    expect(sql).toMatch(/ADD COLUMN from_billing_plan_id/i);
    expect(sql).toMatch(/ADD COLUMN to_billing_plan_id/i);
    expect(sql).toMatch(/ADD COLUMN allowed_sources_json/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("keeps the pre-launch payment reset explicit, live-guarded, and billing-only", () => {
    const resetSql = readFileSync(
      resolve("scripts/reset-test-payments.sql"),
      "utf8",
    );
    const resetRunner = readFileSync(
      resolve("scripts/reset-test-payments.mjs"),
      "utf8",
    );
    const guidedDeploy = readFileSync(
      resolve("scripts/deploy-guided.sh"),
      "utf8",
    );

    expect(resetSql).toMatch(/DELETE FROM payment_provider_accounts WHERE environment = 'test'/i);
    expect(resetSql).toMatch(/DELETE FROM workspace_billing_subscriptions WHERE environment = 'test'/i);
    expect(resetSql).toMatch(/plan_key = 'self_hosted'/i);
    expect(resetSql).toMatch(/mode = 'undecided'/i);
    expect(resetSql).not.toMatch(
      /DELETE FROM\s+(?:workspaces|projects|tracked_queries|snapshot_index|capture_provider_accounts|billing_plans|usage_events|users)/i,
    );
    expect(resetRunner).toMatch(/DISCARD-TEST-PAYMENTS/);
    expect(resetRunner).toMatch(/live_provider_accounts/);
    expect(resetRunner).toMatch(/ambiguous_payment_records/);
    expect(resetRunner).toMatch(/if \(!audit\.safe\) process\.exit\(2\)/);
    expect(resetRunner).toMatch(/executeFile\(cleanupPath\)/);
    expect(resetRunner).not.toMatch(/executeJson\(\{ file: cleanupPath \}\)/);
    expect(guidedDeploy).toMatch(/--reset-test-payments/);
    expect(guidedDeploy).toMatch(/d1 time-travel info CONTROL_DB --json/);
    expect(guidedDeploy.indexOf("run pnpm db:migrate:remote")).toBeLessThan(
      guidedDeploy.indexOf("run node scripts/reset-test-payments.mjs"),
    );
    expect(guidedDeploy.indexOf("run node scripts/reset-test-payments.mjs")).toBeLessThan(
      guidedDeploy.indexOf('log "Publishing Worker"'),
    );
  });

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

  it("adds versioned aggregate brand position metrics without rebuilding analytics facts", () => {
    const sql = readFileSync(
      resolve("migrations/control/0024_brand_position_metrics.sql"),
      "utf8",
    );

    expect(sql).toMatch(/ADD COLUMN brand_metrics_revision/i);
    expect(sql).toMatch(/CREATE TABLE analytics_brand_snapshot_metrics/i);
    expect(sql).toMatch(/CREATE TABLE analytics_daily_brand_metrics/i);
    expect(sql).toMatch(/CREATE TABLE analytics_daily_owned_brand_metrics/i);
    expect(sql).toMatch(/schema_version\s*=\s*9/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("versions entity extraction without disabling foreign-key enforcement", () => {
    const sql = readFileSync(
      resolve("migrations/control/0023_entity_extraction_v2.sql"),
      "utf8",
    );

    expect(sql).toMatch(/UNIQUE\s*\(snapshot_id,\s*extractor_version\)/i);
    expect(sql).toMatch(/UNIQUE\s*\(snapshot_id,\s*entity_id,\s*extractor_version\)/i);
    expect(sql).toMatch(/run_type IN \('live', 'backfill', 'evaluation'\)/i);
    expect(sql).toMatch(/evidence_tier IN \('strong', 'moderate', 'weak'\)/i);
    expect(sql).toMatch(
      /UPDATE projects SET active_entity_extractor_version = 'entities-v1'/i,
    );
    expect(sql).not.toMatch(/UPDATE snapshot_index SET detected_entities_count = 0/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("adds an indexed, resumable project-event projection without rebuilding audit data", () => {
    const sql = readFileSync(
      resolve("migrations/control/0026_project_events.sql"),
      "utf8",
    );

    expect(sql).toMatch(/CREATE TABLE project_events/i);
    expect(sql).toMatch(/UNIQUE\s*\(project_id,\s*dedupe_key\)/i);
    expect(sql).toMatch(
      /project_events\s*\(project_id,\s*event_date,\s*occurred_at,\s*id\)/i,
    );
    expect(sql).toMatch(/CREATE TABLE project_event_audit_backfill/i);
    expect(sql).toMatch(/CREATE TABLE project_event_backfill_projects/i);
    expect(sql).not.toMatch(/UPDATE audit_log/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("schedules a version 10 fan-out reclassification for education domains", () => {
    const sql = readFileSync(
      resolve("migrations/control/0027_education_fanout_signal.sql"),
      "utf8",
    );

    expect(sql).toMatch(/ADD COLUMN related_query_signal_counts_version/i);
    expect(sql).toMatch(/related_query_signal_counts_version\s+>=\s+1/i);
    expect(sql).toMatch(/schema_version\s*=\s*10/i);
    expect(sql).not.toMatch(
      /SET related_query_signal_counts_indexed_at\s*=\s*NULL/i,
    );
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });

  it("adds a resumable source-discovery index without replaying snapshot shards", () => {
    const sql = readFileSync(
      resolve("migrations/control/0028_source_discovery.sql"),
      "utf8",
    );

    expect(sql).toMatch(/CREATE TABLE analytics_citation_url_first_seen/i);
    expect(sql).toMatch(/CREATE TABLE analytics_citation_domain_first_seen/i);
    expect(sql).toMatch(/CREATE TABLE source_discovery_backfill/i);
    expect(sql).toMatch(/status IN \('pending', 'backfilling', 'ready'\)/i);
    expect(sql).not.toMatch(/UPDATE analytics_citation_occurrences/i);
    expect(sql).not.toMatch(/UPDATE analytics_snapshot_facts/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });
});
