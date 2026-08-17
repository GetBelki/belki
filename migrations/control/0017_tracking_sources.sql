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

-- Keep this parent table in place. D1 migrations are transactional, so trying
-- to disable foreign keys before rebuilding it would not prevent cascades from
-- snapshot_index and ingest_events.
ALTER TABLE crawl_jobs ADD COLUMN tracking_source TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'));
CREATE UNIQUE INDEX crawl_jobs_source_schedule_idx
  ON crawl_jobs(tracked_query_id, tracking_source, scheduled_for, run_type);
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
