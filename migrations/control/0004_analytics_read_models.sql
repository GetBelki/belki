CREATE TABLE analytics_read_model_projects (
  project_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'backfilling', 'ready', 'failed')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  backfill_shard_id INTEGER,
  backfill_captured_at TEXT,
  backfill_snapshot_id TEXT,
  last_ingested_at TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE analytics_snapshot_facts (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  shard_id INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  cited_domains_count INTEGER NOT NULL DEFAULT 0,
  retrieved_domains_count INTEGER NOT NULL DEFAULT 0,
  citation_count INTEGER NOT NULL DEFAULT 0,
  brand_mentioned_runs INTEGER NOT NULL DEFAULT 0,
  brand_mentions_count INTEGER NOT NULL DEFAULT 0,
  products_count INTEGER NOT NULL DEFAULT 0,
  provider_cost_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES snapshot_index(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE TABLE analytics_citation_occurrences (
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  registrable_domain TEXT NOT NULL,
  canonical_url TEXT,
  raw_url TEXT,
  title TEXT,
  source_name TEXT,
  PRIMARY KEY (snapshot_id, ordinal),
  FOREIGN KEY (snapshot_id) REFERENCES analytics_snapshot_facts(snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE TABLE analytics_product_occurrences (
  product_row_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  product_identity TEXT NOT NULL,
  product_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  rank_absolute INTEGER,
  provider_product_id TEXT,
  merchants TEXT,
  title TEXT,
  price REAL,
  currency TEXT,
  tag TEXT,
  raw_url TEXT,
  canonical_url TEXT,
  registrable_domain TEXT,
  rating_value REAL,
  rating_votes_count INTEGER,
  rating_max INTEGER,
  images_json TEXT NOT NULL DEFAULT '[]',
  product_ids_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (snapshot_id) REFERENCES analytics_snapshot_facts(snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE INDEX idx_analytics_snapshot_project_time
  ON analytics_snapshot_facts(project_id, captured_at DESC, snapshot_id DESC);

CREATE INDEX idx_analytics_snapshot_query_time
  ON analytics_snapshot_facts(tracked_query_id, captured_at DESC, snapshot_id DESC);

CREATE INDEX idx_analytics_citation_project_domain_time
  ON analytics_citation_occurrences(
    project_id,
    registrable_domain,
    captured_at DESC,
    snapshot_id
  );

CREATE INDEX idx_analytics_citation_project_time
  ON analytics_citation_occurrences(project_id, captured_at DESC, snapshot_id);

CREATE INDEX idx_analytics_product_project_time
  ON analytics_product_occurrences(project_id, captured_at DESC, product_row_id);

CREATE INDEX idx_analytics_product_project_identity_time
  ON analytics_product_occurrences(
    project_id,
    product_identity,
    captured_at DESC,
    product_row_id
  );

CREATE INDEX idx_analytics_product_query_time
  ON analytics_product_occurrences(tracked_query_id, captured_at DESC, product_row_id);
