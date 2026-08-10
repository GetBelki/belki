PRAGMA foreign_keys = ON;

ALTER TABLE workspaces
  ADD COLUMN product_enrichment_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE workspaces
  ADD COLUMN product_enrichment_warning_usd REAL NOT NULL DEFAULT 10;

CREATE TABLE product_enrichment_preferences (
  project_id TEXT NOT NULL,
  product_identity TEXT NOT NULL,
  automatic_refresh_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, product_identity),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE product_enrichment_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  product_identity TEXT NOT NULL,
  product_key TEXT NOT NULL,
  location_code INTEGER NOT NULL,
  language_code TEXT NOT NULL,
  google_product_id TEXT,
  data_docid TEXT,
  gid TEXT,
  last_seen_at TEXT,
  last_opened_at TEXT,
  next_refresh_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (
    status IN (
      'idle', 'queued', 'submitting', 'awaiting_result', 'normalizing',
      'available', 'failed', 'unsupported', 'paused'
    )
  ),
  current_job_id TEXT,
  latest_snapshot_id TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, product_identity, location_code, language_code),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE product_enrichment_jobs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  active_slot TEXT UNIQUE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  product_identity TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('observation', 'view', 'manual', 'recovery')),
  priority INTEGER NOT NULL CHECK (priority IN (1, 2)),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'submitting', 'submission_unknown', 'awaiting_result',
      'normalizing', 'completed', 'failed', 'cancelled'
    )
  ),
  provider_tag TEXT NOT NULL UNIQUE,
  provider_task_id TEXT UNIQUE,
  request_cost_usd REAL,
  task_status_code INTEGER,
  task_status_message TEXT,
  raw_r2_key TEXT,
  submit_attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (target_id) REFERENCES product_enrichment_targets(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE product_market_snapshots (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  target_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  provider_product_id TEXT,
  data_docid TEXT,
  gid TEXT,
  se_domain TEXT,
  check_url TEXT,
  product_url TEXT,
  title TEXT,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  images_json TEXT NOT NULL DEFAULT '[]',
  features_json TEXT NOT NULL DEFAULT '[]',
  specifications_json TEXT NOT NULL DEFAULT '[]',
  variations_json TEXT NOT NULL DEFAULT '[]',
  rating_value REAL,
  rating_votes_count INTEGER,
  rating_max REAL,
  seller_reviews_count INTEGER,
  seller_count INTEGER NOT NULL DEFAULT 0,
  in_stock_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES product_enrichment_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES product_enrichment_targets(id) ON DELETE CASCADE
);

CREATE TABLE product_market_offers (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  seller_name TEXT,
  seller_url TEXT,
  seller_domain TEXT,
  seller_rating_value REAL,
  seller_rating_votes_count INTEGER,
  seller_rating_max REAL,
  seller_reviews_count INTEGER,
  price_current REAL,
  price_regular REAL,
  price_max REAL,
  currency TEXT,
  is_price_range INTEGER NOT NULL DEFAULT 0,
  displayed_price TEXT,
  delivery_message TEXT,
  delivery_json TEXT,
  availability TEXT,
  is_owned INTEGER NOT NULL DEFAULT 0,
  UNIQUE (snapshot_id, ordinal),
  FOREIGN KEY (snapshot_id) REFERENCES product_market_snapshots(id) ON DELETE CASCADE
);

CREATE INDEX idx_enrichment_target_activity
  ON product_enrichment_targets(status, next_refresh_at, last_seen_at);
CREATE INDEX idx_enrichment_target_product
  ON product_enrichment_targets(project_id, product_identity, last_success_at DESC);
CREATE INDEX idx_enrichment_job_workspace_time
  ON product_enrichment_jobs(workspace_id, created_at DESC);
CREATE INDEX idx_enrichment_job_project_time
  ON product_enrichment_jobs(project_id, created_at DESC);
CREATE INDEX idx_enrichment_job_status
  ON product_enrichment_jobs(status, updated_at);
CREATE INDEX idx_market_snapshot_target_time
  ON product_market_snapshots(target_id, captured_at DESC);
CREATE INDEX idx_market_offer_snapshot_price
  ON product_market_offers(snapshot_id, currency, price_current);
