ALTER TABLE analytics_snapshot_facts
  ADD COLUMN rendered_ads_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN ad_render_status_indexed_at TEXT;

ALTER TABLE analytics_ad_occurrences
  ADD COLUMN is_rendered INTEGER NOT NULL DEFAULT 1
    CHECK (is_rendered IN (0, 1));

UPDATE analytics_read_model_projects
SET status = 'pending', schema_version = 5,
  backfill_shard_id = NULL, backfill_captured_at = NULL,
  backfill_snapshot_id = NULL, error_message = NULL,
  updated_at = datetime('now');
