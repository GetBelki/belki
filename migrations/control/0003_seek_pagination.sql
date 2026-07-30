CREATE INDEX IF NOT EXISTS idx_queries_project_seek
  ON tracked_queries(project_id, deleted_at, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_project_time_seek
  ON snapshot_index(project_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_query_time_seek
  ON snapshot_index(tracked_query_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_query_created_seek
  ON crawl_jobs(tracked_query_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_metric_contributions_project_date_query
  ON metric_contributions(project_id, metric_date, tracked_query_id, snapshot_id);

CREATE INDEX IF NOT EXISTS idx_daily_domain_project_date_cover
  ON daily_domain_metrics(
    project_id,
    metric_date,
    domain,
    citation_count,
    cited_snapshot_count
  );
