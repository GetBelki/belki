ALTER TABLE analytics_snapshot_facts
  ADD COLUMN related_site_query_present INTEGER NOT NULL DEFAULT 0
    CHECK (related_site_query_present IN (0, 1));

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN related_review_query_present INTEGER NOT NULL DEFAULT 0
    CHECK (related_review_query_present IN (0, 1));

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN related_query_years_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN related_query_insights_indexed_at TEXT;

CREATE INDEX analytics_snapshot_metric_source_idx
  ON analytics_snapshot_facts(metric_date, tracking_source, snapshot_id);

UPDATE analytics_read_model_projects
SET status = 'pending', schema_version = 6,
  backfill_shard_id = NULL, backfill_captured_at = NULL,
  backfill_snapshot_id = NULL, error_message = NULL,
  updated_at = datetime('now');
