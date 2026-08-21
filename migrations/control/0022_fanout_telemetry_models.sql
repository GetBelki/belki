ALTER TABLE analytics_snapshot_facts
  ADD COLUMN provider_model TEXT;

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN fan_out_telemetry_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (fan_out_telemetry_status IN ('reported', 'unavailable', 'unknown'));

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN fan_out_telemetry_indexed_at TEXT;

CREATE INDEX analytics_snapshot_facts_fanout_model_idx
  ON analytics_snapshot_facts(
    metric_date, tracking_source, provider_model, fan_out_telemetry_status,
    snapshot_id
  );

UPDATE analytics_read_model_projects
SET status = 'pending', schema_version = 8,
  backfill_shard_id = NULL, backfill_captured_at = NULL,
  backfill_snapshot_id = NULL, error_message = NULL,
  updated_at = datetime('now');
