PRAGMA foreign_keys = ON;

CREATE TABLE project_capture_provider_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
  )),
  capture_provider TEXT NOT NULL CHECK (capture_provider IN (
    'dataforseo', 'brightdata', 'cloro', 'oxylabs'
  )),
  event_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, tracking_source, capture_provider),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_project_capture_provider_events_project_date
  ON project_capture_provider_events(
    project_id, event_date, tracking_source, occurred_at, id
  );

-- Record the first observed use of each real capture provider. This separates
-- capture routing changes from actual model identities in chart annotations.
INSERT INTO project_capture_provider_events (
  id, project_id, tracking_source, capture_provider, event_date,
  occurred_at, created_at, updated_at
)
SELECT
  'capture-provider:' || job.project_id || ':' || job.tracking_source || ':' || attempt.provider,
  job.project_id,
  job.tracking_source,
  attempt.provider,
  substr(MIN(attempt.created_at), 1, 10),
  MIN(attempt.created_at),
  MIN(attempt.created_at),
  MAX(attempt.updated_at)
FROM capture_provider_attempts attempt
JOIN crawl_jobs job ON job.id = attempt.crawl_job_id
GROUP BY job.project_id, job.tracking_source, attempt.provider;

-- Platform placeholders were previously stored as models when a provider did
-- not report an underlying model. Remove those false model facts and events.
DELETE FROM project_events
WHERE event_type = 'model_detected'
  AND json_valid(payload_json)
  AND lower(trim(json_extract(payload_json, '$.model'))) IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google ai mode',
    'google_ai_overview', 'google ai overview', 'google ai overviews'
  );

UPDATE snapshot_index
SET model = NULL
WHERE lower(trim(model)) IN (
  'chatgpt', 'gemini', 'google_ai_mode', 'google ai mode',
  'google_ai_overview', 'google ai overview', 'google ai overviews'
);

UPDATE analytics_snapshot_facts
SET provider_model = NULL, updated_at = datetime('now')
WHERE lower(trim(provider_model)) IN (
  'chatgpt', 'gemini', 'google_ai_mode', 'google ai mode',
  'google_ai_overview', 'google ai overview', 'google ai overviews'
);
