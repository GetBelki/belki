PRAGMA foreign_keys = ON;

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  crawl_job_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  dataforseo_task_id TEXT NOT NULL UNIQUE,
  keyword TEXT NOT NULL,
  location_code INTEGER NOT NULL,
  language_code TEXT NOT NULL,
  model TEXT,
  check_url TEXT,
  captured_at TEXT NOT NULL,
  answer_markdown TEXT,
  answer_hash TEXT,
  se_results_count INTEGER,
  items_count INTEGER,
  item_types_json TEXT NOT NULL DEFAULT '[]',
  fan_out_queries_json TEXT NOT NULL DEFAULT '[]',
  raw_r2_key TEXT NOT NULL,
  html_r2_key TEXT,
  provider_cost_usd REAL,
  provider_status_code INTEGER,
  provider_status_message TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE snapshot_sources (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT,
  snippet TEXT,
  source_name TEXT,
  raw_domain TEXT,
  hostname TEXT,
  registrable_domain TEXT,
  raw_url TEXT,
  canonical_url TEXT,
  thumbnail TEXT,
  publication_date TEXT,
  markdown TEXT,
  UNIQUE (snapshot_id, ordinal),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);

CREATE TABLE snapshot_search_results (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  breadcrumb TEXT,
  raw_domain TEXT,
  hostname TEXT,
  registrable_domain TEXT,
  raw_url TEXT,
  canonical_url TEXT,
  UNIQUE (snapshot_id, ordinal),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);

CREATE TABLE snapshot_brand_entities (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  category TEXT,
  markdown TEXT,
  matched_tracked_brand_id TEXT,
  UNIQUE (snapshot_id, ordinal),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);

CREATE TABLE brand_entity_urls (
  id TEXT PRIMARY KEY,
  brand_entity_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  raw_url TEXT,
  canonical_url TEXT,
  hostname TEXT,
  registrable_domain TEXT,
  UNIQUE (brand_entity_id, ordinal),
  FOREIGN KEY (brand_entity_id) REFERENCES snapshot_brand_entities(id) ON DELETE CASCADE
);

CREATE TABLE snapshot_items (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  type TEXT NOT NULL,
  rank_group INTEGER,
  rank_absolute INTEGER,
  markdown TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (snapshot_id, ordinal),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);

CREATE TABLE snapshot_products (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  snapshot_item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  rank_absolute INTEGER,
  provider_product_id TEXT,
  merchants TEXT,
  id_to_token_map TEXT,
  title TEXT,
  price REAL,
  currency TEXT,
  tag TEXT,
  raw_url TEXT,
  canonical_url TEXT,
  hostname TEXT,
  registrable_domain TEXT,
  rating_value REAL,
  rating_votes_count INTEGER,
  rating_max INTEGER,
  images_json TEXT NOT NULL DEFAULT '[]',
  product_ids_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (snapshot_item_id, ordinal),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_item_id) REFERENCES snapshot_items(id) ON DELETE CASCADE
);

CREATE TABLE snapshot_domains (
  snapshot_id TEXT NOT NULL,
  registrable_domain TEXT NOT NULL,
  hostname TEXT,
  cited_count INTEGER NOT NULL DEFAULT 0,
  retrieved_count INTEGER NOT NULL DEFAULT 0,
  brand_url_count INTEGER NOT NULL DEFAULT 0,
  product_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, registrable_domain),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);

CREATE TABLE metric_outbox (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);

CREATE INDEX idx_snapshots_project_time ON snapshots(project_id, captured_at DESC);
CREATE INDEX idx_snapshots_query_time ON snapshots(tracked_query_id, captured_at DESC);
CREATE INDEX idx_sources_snapshot_domain ON snapshot_sources(snapshot_id, registrable_domain);
CREATE INDEX idx_sources_canonical_url ON snapshot_sources(snapshot_id, canonical_url);
CREATE INDEX idx_search_snapshot_domain ON snapshot_search_results(snapshot_id, registrable_domain);
CREATE INDEX idx_brand_snapshot_match ON snapshot_brand_entities(snapshot_id, matched_tracked_brand_id);
CREATE INDEX idx_products_snapshot_domain ON snapshot_products(snapshot_id, registrable_domain);
CREATE INDEX idx_domains_domain ON snapshot_domains(registrable_domain, snapshot_id);
CREATE INDEX idx_outbox_pending ON metric_outbox(delivered_at, created_at);
