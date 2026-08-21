ALTER TABLE analytics_snapshot_facts
  ADD COLUMN related_query_signal_counts_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN related_query_signal_counts_indexed_at TEXT;

UPDATE analytics_read_model_projects
SET status = 'pending', schema_version = 7,
  backfill_shard_id = NULL, backfill_captured_at = NULL,
  backfill_snapshot_id = NULL, error_message = NULL,
  updated_at = datetime('now');
