CREATE INDEX IF NOT EXISTS idx_snapshot_query_source_time_seek
  ON snapshot_index(tracked_query_id, tracking_source, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_query_source_created_seek
  ON crawl_jobs(tracked_query_id, tracking_source, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_snapshot_project_source_date_query
  ON analytics_snapshot_facts(
    project_id,
    tracking_source,
    metric_date,
    tracked_query_id
  );
