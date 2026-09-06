CREATE TABLE traffic_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  last_event_at INTEGER
);
CREATE TABLE traffic_sessions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  hostname TEXT NOT NULL,
  entry_path TEXT NOT NULL,
  country TEXT NOT NULL,
  device TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  activity_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX traffic_sessions_date ON traffic_sessions(project_id, started_at, source);
CREATE INDEX traffic_sessions_retention ON traffic_sessions(started_at);
CREATE TABLE traffic_pages (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  path TEXT NOT NULL,
  visible_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, session_id, id),
  FOREIGN KEY (project_id, session_id) REFERENCES traffic_sessions(project_id, id) ON DELETE CASCADE
);
CREATE TABLE traffic_conversions (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  goal_name TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id, goal_id),
  FOREIGN KEY (project_id, session_id) REFERENCES traffic_sessions(project_id, id) ON DELETE CASCADE
);
CREATE TABLE traffic_events (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id, id),
  FOREIGN KEY (project_id, session_id) REFERENCES traffic_sessions(project_id, id) ON DELETE CASCADE
);
