ALTER TABLE crawl_jobs ADD COLUMN raw_r2_key TEXT;
ALTER TABLE crawl_jobs ADD COLUMN html_r2_key TEXT;

UPDATE crawl_jobs
SET raw_r2_key = (
  SELECT snapshot.raw_r2_key
  FROM snapshot_index snapshot
  WHERE snapshot.crawl_job_id = crawl_jobs.id
),
html_r2_key = (
  SELECT snapshot.html_r2_key
  FROM snapshot_index snapshot
  WHERE snapshot.crawl_job_id = crawl_jobs.id
)
WHERE EXISTS (
  SELECT 1 FROM snapshot_index snapshot WHERE snapshot.crawl_job_id = crawl_jobs.id
);

CREATE TABLE prompt_purge_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL UNIQUE,
  shard_id INTEGER NOT NULL CHECK (shard_id BETWEEN 0 AND 31),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'processing', 'finalizing', 'completed', 'failed')),
  r2_keys_json TEXT NOT NULL DEFAULT '[]',
  affected_dates_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_prompt_purge_jobs_status
  ON prompt_purge_jobs(status, not_before, updated_at);

CREATE INDEX idx_prompt_purge_jobs_project
  ON prompt_purge_jobs(project_id, created_at DESC);

CREATE TABLE deleted_prompt_usage_daily (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  requested_runs INTEGER NOT NULL DEFAULT 0,
  charged_runs INTEGER NOT NULL DEFAULT 0,
  provider_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, usage_date),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_deleted_prompt_usage_workspace_date
  ON deleted_prompt_usage_daily(workspace_id, usage_date);
