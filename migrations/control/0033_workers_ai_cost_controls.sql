PRAGMA foreign_keys = ON;

CREATE TABLE ai_inference_cache (
  cache_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  response_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE INDEX ai_inference_cache_last_used_idx
  ON ai_inference_cache(last_used_at);

CREATE TABLE ai_usage_events (
  id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  project_id TEXT,
  tracked_query_id TEXT,
  job_id TEXT,
  request_id TEXT,
  retry_attempt INTEGER NOT NULL CHECK (retry_attempt >= 1),
  cache_status TEXT NOT NULL CHECK (cache_status IN ('hit', 'miss', 'disabled')),
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  input_characters INTEGER NOT NULL DEFAULT 0 CHECK (input_characters >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  error_type TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE INDEX ai_usage_events_feature_time_idx
  ON ai_usage_events(feature, operation, created_at DESC);
CREATE INDEX ai_usage_events_model_time_idx
  ON ai_usage_events(model, created_at DESC);
CREATE INDEX ai_usage_events_project_time_idx
  ON ai_usage_events(project_id, created_at DESC);
