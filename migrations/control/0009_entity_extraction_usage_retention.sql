PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS deleted_entity_extraction_usage_daily (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  charged_tasks INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, usage_date),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
