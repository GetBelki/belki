CREATE INDEX IF NOT EXISTS idx_snapshots_project_time_seek
  ON snapshots(project_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_query_time_seek
  ON snapshots(tracked_query_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sources_domain_snapshot
  ON snapshot_sources(registrable_domain, snapshot_id, canonical_url);

CREATE INDEX IF NOT EXISTS idx_products_snapshot_ordinal
  ON snapshot_products(snapshot_id, ordinal, id);
