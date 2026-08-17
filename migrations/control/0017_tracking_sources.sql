PRAGMA foreign_keys = OFF;

ALTER TABLE projects ADD COLUMN archived_at TEXT;

CREATE TABLE project_tracking_sources (
  project_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
  )),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, source),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO project_tracking_sources (project_id, source, enabled, created_at, updated_at)
SELECT id, 'chatgpt', 1, created_at, updated_at FROM projects;

ALTER TABLE billing_accounts ADD COLUMN prompt_limit INTEGER NOT NULL DEFAULT 1000000
  CHECK (prompt_limit >= 0);
ALTER TABLE billing_accounts ADD COLUMN source_limit INTEGER NOT NULL DEFAULT 4
  CHECK (source_limit BETWEEN 0 AND 4);

UPDATE billing_accounts SET
  prompt_limit = CASE plan_key
    WHEN 'starter' THEN 25
    WHEN 'studio' THEN 75
    WHEN 'agency' THEN 250
    ELSE 1000000
  END,
  source_limit = CASE plan_key
    WHEN 'starter' THEN 1
    WHEN 'studio' THEN 2
    ELSE 4
  END;

ALTER TABLE billing_plan_changes ADD COLUMN transition_json TEXT;

CREATE TABLE crawl_jobs_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  shard_id INTEGER NOT NULL,
  tracking_source TEXT NOT NULL DEFAULT 'chatgpt' CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
  )),
  run_type TEXT NOT NULL CHECK (run_type IN ('scheduled', 'manual', 'backfill')),
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('standard', 'standard_priority', 'live')),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'submitting', 'submission_unknown', 'submitted',
    'awaiting_result', 'normalizing', 'completed', 'failed', 'cancelled'
  )),
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
  raw_r2_key TEXT,
  html_r2_key TEXT,
  provider_account_id TEXT,
  usage_reservation_id TEXT,
  usage_units INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tracked_query_id, tracking_source, scheduled_for, run_type),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

INSERT INTO crawl_jobs_v2 (
  id, workspace_id, project_id, tracked_query_id, shard_id, tracking_source,
  run_type, delivery_method, status, scheduled_for, dataforseo_task_id,
  provider_tag, capture_html, submit_attempts, request_cost_usd,
  task_status_code, task_status_message, error_code, error_message,
  submitted_at, completed_at, created_at, updated_at, raw_r2_key, html_r2_key,
  provider_account_id, usage_reservation_id, usage_units
)
SELECT
  id, workspace_id, project_id, tracked_query_id, shard_id, 'chatgpt',
  run_type, delivery_method, status, scheduled_for, dataforseo_task_id,
  provider_tag, capture_html, submit_attempts, request_cost_usd,
  task_status_code, task_status_message, error_code, error_message,
  submitted_at, completed_at, created_at, updated_at, raw_r2_key, html_r2_key,
  provider_account_id, usage_reservation_id, usage_units
FROM crawl_jobs;

DROP TABLE crawl_jobs;
ALTER TABLE crawl_jobs_v2 RENAME TO crawl_jobs;
CREATE INDEX idx_jobs_status_time ON crawl_jobs(status, created_at);
CREATE INDEX idx_jobs_query_time ON crawl_jobs(tracked_query_id, scheduled_for DESC);
CREATE INDEX crawl_jobs_provider_account_idx ON crawl_jobs(provider_account_id, status);
CREATE INDEX crawl_jobs_source_status_idx ON crawl_jobs(tracking_source, status, created_at);

ALTER TABLE snapshot_index ADD COLUMN tracking_source TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'));
ALTER TABLE snapshot_index ADD COLUMN surface_present INTEGER NOT NULL DEFAULT 1
  CHECK (surface_present IN (0, 1));
CREATE INDEX snapshot_index_project_source_time_idx
  ON snapshot_index(project_id, tracking_source, captured_at DESC);

ALTER TABLE metric_contributions ADD COLUMN tracking_source TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'));
ALTER TABLE metric_contributions ADD COLUMN surface_present_runs INTEGER NOT NULL DEFAULT 1
  CHECK (surface_present_runs IN (0, 1));

ALTER TABLE alert_rules ADD COLUMN tracking_source TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'));

ALTER TABLE analytics_snapshot_facts ADD COLUMN tracking_source TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'));
ALTER TABLE analytics_snapshot_facts ADD COLUMN surface_present INTEGER NOT NULL DEFAULT 1
  CHECK (surface_present IN (0, 1));
CREATE INDEX analytics_snapshot_project_source_time_idx
  ON analytics_snapshot_facts(project_id, tracking_source, captured_at DESC, snapshot_id DESC);

CREATE TABLE daily_source_project_metrics (
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  completed_runs INTEGER NOT NULL DEFAULT 0,
  surface_present_runs INTEGER NOT NULL DEFAULT 0,
  cited_runs INTEGER NOT NULL DEFAULT 0,
  brand_mentioned_runs INTEGER NOT NULL DEFAULT 0,
  product_runs INTEGER NOT NULL DEFAULT 0,
  total_citations INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, tracking_source, metric_date),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO daily_source_project_metrics (
  project_id, tracking_source, metric_date, completed_runs, surface_present_runs,
  cited_runs, brand_mentioned_runs, product_runs, total_citations, updated_at
)
SELECT project_id, 'chatgpt', metric_date, completed_runs, completed_runs,
  cited_runs, brand_mentioned_runs, product_runs, total_citations, updated_at
FROM daily_project_metrics;

CREATE TABLE daily_source_domain_metrics (
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  domain TEXT NOT NULL,
  cited_snapshot_count INTEGER NOT NULL DEFAULT 0,
  citation_count INTEGER NOT NULL DEFAULT 0,
  retrieved_snapshot_count INTEGER NOT NULL DEFAULT 0,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  product_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, tracking_source, metric_date, domain),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO daily_source_domain_metrics
SELECT project_id, 'chatgpt', metric_date, domain, cited_snapshot_count,
  citation_count, retrieved_snapshot_count, retrieval_count, product_count, updated_at
FROM daily_domain_metrics;

CREATE TABLE daily_source_brand_metrics (
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL,
  tracked_brand_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  mentioned_snapshot_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, tracking_source, tracked_brand_id, metric_date),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_brand_id) REFERENCES tracked_brands(id) ON DELETE CASCADE
);

INSERT INTO daily_source_brand_metrics
SELECT project_id, 'chatgpt', tracked_brand_id, metric_date,
  mentioned_snapshot_count, updated_at
FROM daily_brand_metrics;

PRAGMA foreign_keys = ON;
