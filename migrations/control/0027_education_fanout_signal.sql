-- Keep the existing indexed timestamp intact so the pre-deploy Worker can
-- continue serving data. Only the new Worker can advance this version to 2.
ALTER TABLE analytics_snapshot_facts
  ADD COLUMN related_query_signal_counts_version INTEGER NOT NULL DEFAULT 1
  CHECK (related_query_signal_counts_version >= 1);

UPDATE analytics_read_model_projects
SET status = 'pending', schema_version = 10,
  backfill_shard_id = NULL, backfill_captured_at = NULL,
  backfill_snapshot_id = NULL, error_message = NULL,
  updated_at = datetime('now');
