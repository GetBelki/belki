ALTER TABLE analytics_snapshot_facts
  ADD COLUMN related_queries_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN related_queries_indexed_at TEXT;

CREATE TABLE analytics_related_query_occurrences (
  snapshot_id TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  query_text TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, normalized_query),
  FOREIGN KEY (snapshot_id) REFERENCES analytics_snapshot_facts(snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE TABLE analytics_retrieval_occurrences (
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  registrable_domain TEXT,
  canonical_url TEXT,
  raw_url TEXT,
  title TEXT,
  description TEXT,
  PRIMARY KEY (snapshot_id, ordinal),
  FOREIGN KEY (snapshot_id) REFERENCES analytics_snapshot_facts(snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE INDEX idx_analytics_related_query_project_query_time
  ON analytics_related_query_occurrences(
    project_id, normalized_query, captured_at DESC, snapshot_id
  );

CREATE INDEX idx_analytics_related_query_project_time
  ON analytics_related_query_occurrences(project_id, captured_at DESC, snapshot_id);

CREATE INDEX idx_analytics_related_query_prompt_time
  ON analytics_related_query_occurrences(
    tracked_query_id, captured_at DESC, snapshot_id
  );

CREATE INDEX idx_analytics_retrieval_project_time
  ON analytics_retrieval_occurrences(project_id, captured_at DESC, snapshot_id);

CREATE INDEX idx_analytics_retrieval_prompt_time
  ON analytics_retrieval_occurrences(
    tracked_query_id, captured_at DESC, snapshot_id
  );

UPDATE analytics_read_model_projects
SET status = 'pending', schema_version = 4,
  backfill_shard_id = NULL, backfill_captured_at = NULL,
  backfill_snapshot_id = NULL, error_message = NULL,
  updated_at = datetime('now');
