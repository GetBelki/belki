CREATE TABLE traffic_installation_tests (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  result_json TEXT
);
CREATE INDEX traffic_installation_tests_expiry ON traffic_installation_tests(expires_at);
