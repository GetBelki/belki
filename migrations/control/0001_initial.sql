PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_base_url TEXT NOT NULL,
  monthly_run_cap INTEGER NOT NULL DEFAULT 1000000,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE password_credentials (
  user_id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL DEFAULT 'pbkdf2-sha256',
  iterations INTEGER NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  primary_domain TEXT,
  html_capture_enabled INTEGER NOT NULL DEFAULT 0,
  raw_retention_days INTEGER NOT NULL DEFAULT 730,
  html_retention_days INTEGER NOT NULL DEFAULT 90,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE tracked_brands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owned', 'competitor')),
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  domains_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE shard_registry (
  shard_id INTEGER PRIMARY KEY CHECK (shard_id BETWEEN 0 AND 31),
  binding_name TEXT NOT NULL UNIQUE,
  assigned_queries INTEGER NOT NULL DEFAULT 0,
  completed_snapshots INTEGER NOT NULL DEFAULT 0,
  estimated_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining', 'full')),
  updated_at TEXT NOT NULL
);

CREATE TABLE tracked_queries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  location_code INTEGER NOT NULL,
  language_code TEXT NOT NULL,
  force_web_search INTEGER NOT NULL DEFAULT 1,
  schedule_cadence TEXT NOT NULL CHECK (schedule_cadence IN ('daily', 'weekly')),
  schedule_time TEXT NOT NULL,
  schedule_weekday INTEGER CHECK (schedule_weekday BETWEEN 0 AND 6),
  schedule_timezone TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  shard_id INTEGER NOT NULL CHECK (shard_id BETWEEN 0 AND 31),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (shard_id) REFERENCES shard_registry(shard_id)
);

CREATE TABLE crawl_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  shard_id INTEGER NOT NULL,
  run_type TEXT NOT NULL CHECK (run_type IN ('scheduled', 'manual', 'backfill')),
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('standard', 'standard_priority', 'live')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'submitting', 'submission_unknown', 'submitted',
      'awaiting_result', 'normalizing', 'completed', 'failed', 'cancelled'
    )
  ),
  scheduled_for TEXT NOT NULL,
  dataforseo_task_id TEXT UNIQUE,
  provider_tag TEXT NOT NULL UNIQUE,
  capture_html INTEGER NOT NULL DEFAULT 0,
  submit_attempts INTEGER NOT NULL DEFAULT 0,
  request_cost_usd REAL,
  task_status_code INTEGER,
  task_status_message TEXT,
  error_code TEXT,
  error_message TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tracked_query_id, scheduled_for, run_type),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE TABLE snapshot_index (
  id TEXT PRIMARY KEY,
  crawl_job_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  shard_id INTEGER NOT NULL,
  dataforseo_task_id TEXT NOT NULL UNIQUE,
  captured_at TEXT NOT NULL,
  model TEXT,
  check_url TEXT,
  answer_hash TEXT,
  cited_domains_count INTEGER NOT NULL DEFAULT 0,
  retrieved_domains_count INTEGER NOT NULL DEFAULT 0,
  brand_entities_count INTEGER NOT NULL DEFAULT 0,
  products_count INTEGER NOT NULL DEFAULT 0,
  has_product_block INTEGER NOT NULL DEFAULT 0,
  raw_r2_key TEXT NOT NULL,
  html_r2_key TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (crawl_job_id) REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE TABLE metric_contributions (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  completed_runs INTEGER NOT NULL,
  cited_runs INTEGER NOT NULL,
  brand_mentioned_runs INTEGER NOT NULL,
  product_runs INTEGER NOT NULL,
  total_citations INTEGER NOT NULL,
  domains_json TEXT NOT NULL,
  brands_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES snapshot_index(id) ON DELETE CASCADE
);

CREATE TABLE daily_project_metrics (
  project_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  completed_runs INTEGER NOT NULL DEFAULT 0,
  cited_runs INTEGER NOT NULL DEFAULT 0,
  brand_mentioned_runs INTEGER NOT NULL DEFAULT 0,
  product_runs INTEGER NOT NULL DEFAULT 0,
  total_citations INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, metric_date),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE daily_domain_metrics (
  project_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  domain TEXT NOT NULL,
  cited_snapshot_count INTEGER NOT NULL DEFAULT 0,
  citation_count INTEGER NOT NULL DEFAULT 0,
  retrieved_snapshot_count INTEGER NOT NULL DEFAULT 0,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  product_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, metric_date, domain),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE daily_brand_metrics (
  project_id TEXT NOT NULL,
  tracked_brand_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  mentioned_snapshot_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, tracked_brand_id, metric_date),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_brand_id) REFERENCES tracked_brands(id) ON DELETE CASCADE
);

CREATE TABLE locale_catalog (
  kind TEXT NOT NULL CHECK (kind IN ('location', 'language')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (kind, code)
);

CREATE TABLE alert_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'run_failed', 'own_citation_lost', 'brand_mention_lost',
      'competitor_citation_gained', 'product_block_changed', 'visibility_drop'
    )
  ),
  threshold REAL,
  tracked_brand_id TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  channels_json TEXT NOT NULL DEFAULT '["in_app"]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_brand_id) REFERENCES tracked_brands(id) ON DELETE CASCADE
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  alert_rule_id TEXT,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT,
  snapshot_id TEXT,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (alert_rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id) REFERENCES snapshot_index(id) ON DELETE CASCADE
);

CREATE TABLE webhook_destinations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error_message TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (destination_id, alert_id),
  FOREIGN KEY (destination_id) REFERENCES webhook_destinations(id) ON DELETE CASCADE,
  FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  project_id TEXT,
  format TEXT NOT NULL CHECK (format IN ('csv', 'ndjson')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'expired')),
  filters_json TEXT NOT NULL DEFAULT '{}',
  r2_key TEXT,
  row_count INTEGER,
  error_message TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE ingest_events (
  id TEXT PRIMARY KEY,
  crawl_job_id TEXT,
  dataforseo_task_id TEXT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  r2_key TEXT,
  error_message TEXT,
  received_at TEXT NOT NULL,
  FOREIGN KEY (crawl_job_id) REFERENCES crawl_jobs(id) ON DELETE SET NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_sessions_token_expiry ON sessions(token_hash, expires_at);
CREATE INDEX idx_auth_tokens_lookup ON auth_tokens(token_hash, purpose, expires_at);
CREATE INDEX idx_projects_workspace ON projects(workspace_id, deleted_at);
CREATE INDEX idx_brands_project ON tracked_brands(project_id, kind);
CREATE INDEX idx_queries_due ON tracked_queries(is_active, next_run_at, deleted_at);
CREATE INDEX idx_queries_project ON tracked_queries(project_id, is_active, deleted_at);
CREATE INDEX idx_jobs_status_time ON crawl_jobs(status, created_at);
CREATE INDEX idx_jobs_query_time ON crawl_jobs(tracked_query_id, scheduled_for DESC);
CREATE INDEX idx_snapshot_project_time ON snapshot_index(project_id, captured_at DESC);
CREATE INDEX idx_snapshot_query_time ON snapshot_index(tracked_query_id, captured_at DESC);
CREATE INDEX idx_daily_project_date ON daily_project_metrics(project_id, metric_date DESC);
CREATE INDEX idx_daily_domain_date ON daily_domain_metrics(project_id, metric_date DESC);
CREATE INDEX idx_alerts_project_time ON alerts(project_id, created_at DESC);
CREATE INDEX idx_exports_workspace_time ON exports(workspace_id, created_at DESC);

INSERT INTO shard_registry (shard_id, binding_name, updated_at)
WITH RECURSIVE shard_numbers(value) AS (
  SELECT 0
  UNION ALL
  SELECT value + 1 FROM shard_numbers WHERE value < 31
)
SELECT value, printf('SNAPSHOT_DB_%02d', value), CURRENT_TIMESTAMP
FROM shard_numbers;

INSERT INTO locale_catalog (kind, code, name, payload_json, refreshed_at) VALUES
  ('location', '2840', 'United States', '{"location_code":2840,"location_name":"United States"}', CURRENT_TIMESTAMP),
  ('language', 'en', 'English', '{"language_code":"en","language_name":"English"}', CURRENT_TIMESTAMP);
