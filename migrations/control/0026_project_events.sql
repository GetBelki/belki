PRAGMA foreign_keys = ON;

CREATE TABLE project_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'prompt_set_changed',
    'tracking_sources_changed',
    'model_detected'
  )),
  tracking_source TEXT CHECK (
    tracking_source IS NULL OR tracking_source IN (
      'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
    )
  ),
  event_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  origin TEXT NOT NULL DEFAULT 'system'
    CHECK (origin IN ('system', 'user')),
  actor_user_id TEXT,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, dedupe_key),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_project_events_project_date
  ON project_events(project_id, event_date, occurred_at, id);

CREATE INDEX idx_project_events_project_source_date
  ON project_events(project_id, tracking_source, event_date, event_type);

-- Supports the single forward-only audit scan used to seed historical events.
CREATE INDEX idx_audit_created_id_action
  ON audit_log(created_at, id, action);

CREATE TABLE project_event_audit_backfill (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  cursor_created_at TEXT,
  cursor_id TEXT,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  error_message TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO project_event_audit_backfill (
  singleton_id, completed, updated_at
) VALUES (1, 0, datetime('now'));

CREATE TABLE project_event_backfill_projects (
  project_id TEXT PRIMARY KEY,
  known_tracking_sources_json TEXT NOT NULL DEFAULT '["chatgpt"]',
  model_cursor_captured_at TEXT,
  model_cursor_snapshot_id TEXT,
  model_completed INTEGER NOT NULL DEFAULT 0 CHECK (model_completed IN (0, 1)),
  error_message TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO project_event_backfill_projects (
  project_id, known_tracking_sources_json, updated_at
)
SELECT id, '["chatgpt"]', datetime('now')
FROM projects
WHERE deleted_at IS NULL;

CREATE INDEX idx_project_event_backfill_pending
  ON project_event_backfill_projects(model_completed, updated_at, project_id);
