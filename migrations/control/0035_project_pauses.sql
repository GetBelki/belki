ALTER TABLE projects ADD COLUMN paused_at TEXT;

CREATE TABLE project_pause_periods (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  paused_at TEXT NOT NULL,
  resumed_at TEXT,
  paused_by_user_id TEXT,
  resumed_by_user_id TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (paused_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (resumed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX project_pause_periods_open_idx
  ON project_pause_periods(project_id)
  WHERE resumed_at IS NULL;

CREATE INDEX project_pause_periods_project_time_idx
  ON project_pause_periods(project_id, paused_at, resumed_at);
