ALTER TABLE projects
  ADD COLUMN brand_metrics_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN brand_metrics_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE analytics_brand_snapshot_metrics (
  snapshot_id TEXT NOT NULL,
  brand_metrics_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
  )),
  metric_date TEXT NOT NULL,
  brands_json TEXT NOT NULL DEFAULT '[]',
  owned_mentioned INTEGER NOT NULL DEFAULT 0 CHECK (owned_mentioned IN (0, 1)),
  owned_position REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, brand_metrics_revision),
  FOREIGN KEY (snapshot_id) REFERENCES snapshot_index(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX analytics_brand_snapshot_project_revision_date_idx
  ON analytics_brand_snapshot_metrics(
    project_id, brand_metrics_revision, tracking_source, metric_date, snapshot_id
  );

CREATE TABLE analytics_daily_brand_metrics (
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
  )),
  metric_date TEXT NOT NULL,
  brand_metrics_revision INTEGER NOT NULL,
  tracked_brand_id TEXT NOT NULL,
  mentioned_response_count INTEGER NOT NULL DEFAULT 0,
  position_sum REAL NOT NULL DEFAULT 0,
  position_sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    project_id, tracking_source, metric_date,
    brand_metrics_revision, tracked_brand_id
  ),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_brand_id) REFERENCES tracked_brands(id) ON DELETE CASCADE
);

CREATE INDEX analytics_daily_brand_project_revision_source_date_idx
  ON analytics_daily_brand_metrics(
    project_id, brand_metrics_revision, tracking_source,
    metric_date, tracked_brand_id
  );

CREATE TABLE analytics_daily_owned_brand_metrics (
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
  )),
  metric_date TEXT NOT NULL,
  brand_metrics_revision INTEGER NOT NULL,
  mentioned_response_count INTEGER NOT NULL DEFAULT 0,
  position_sum REAL NOT NULL DEFAULT 0,
  position_sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    project_id, tracking_source, metric_date, brand_metrics_revision
  ),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX analytics_daily_owned_brand_project_revision_source_date_idx
  ON analytics_daily_owned_brand_metrics(
    project_id, brand_metrics_revision, tracking_source, metric_date
  );

UPDATE analytics_read_model_projects
SET status = 'pending', schema_version = 9,
  backfill_shard_id = NULL, backfill_captured_at = NULL,
  backfill_snapshot_id = NULL, error_message = NULL,
  updated_at = datetime('now');
