CREATE TABLE capture_provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (
    provider IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs')
  ),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  credential_source TEXT NOT NULL DEFAULT 'database' CHECK (
    credential_source IN ('environment', 'database')
  ),
  active_credential_version INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  priority INTEGER NOT NULL,
  last_test_status TEXT CHECK (last_test_status IN ('passed', 'failed')),
  last_tested_at TEXT,
  last_test_message TEXT,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX capture_provider_accounts_one_default_idx
  ON capture_provider_accounts(is_default) WHERE is_default = 1;
CREATE INDEX capture_provider_accounts_routing_idx
  ON capture_provider_accounts(status, priority, created_at);

INSERT INTO capture_provider_accounts (
  id, provider, label, status, credential_source, is_default, priority,
  created_at, updated_at
) VALUES (
  'dataforseo:platform:v1', 'dataforseo', 'Platform DataForSEO account',
  'active', 'environment', 1, 10,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE capture_provider_credentials (
  provider_account_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  algorithm TEXT NOT NULL CHECK (algorithm = 'aes-256-gcm-hkdf-sha256'),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (provider_account_id, version),
  FOREIGN KEY (provider_account_id) REFERENCES capture_provider_accounts(id)
    ON DELETE CASCADE
);

CREATE TABLE capture_provider_routes (
  tracking_source TEXT PRIMARY KEY CHECK (
    tracking_source IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview')
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  provider_account_id TEXT,
  updated_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_account_id) REFERENCES capture_provider_accounts(id)
    ON DELETE SET NULL
);

INSERT INTO capture_provider_routes (
  tracking_source, enabled, provider_account_id, created_at, updated_at
) VALUES
  ('chatgpt', 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (
    'gemini',
    CASE WHEN EXISTS (
      SELECT 1 FROM project_tracking_sources WHERE source = 'gemini' AND enabled = 1
    ) THEN 1 ELSE 0 END,
    NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'google_ai_mode',
    CASE WHEN EXISTS (
      SELECT 1 FROM project_tracking_sources WHERE source = 'google_ai_mode' AND enabled = 1
    ) THEN 1 ELSE 0 END,
    NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'google_ai_overview',
    CASE WHEN EXISTS (
      SELECT 1 FROM project_tracking_sources WHERE source = 'google_ai_overview' AND enabled = 1
    ) THEN 1 ELSE 0 END,
    NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

CREATE TABLE capture_provider_attempts (
  id TEXT PRIMARY KEY,
  crawl_job_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (
    provider IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs')
  ),
  role TEXT NOT NULL CHECK (role IN ('primary', 'fallback', 'shadow')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'submitting', 'accepted', 'awaiting_result', 'normalizing', 'completed', 'failed', 'ambiguous')
  ),
  adapter_version TEXT NOT NULL,
  credential_version INTEGER,
  external_task_id TEXT,
  request_cost_usd REAL,
  raw_r2_key TEXT,
  error_code TEXT,
  error_message TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (crawl_job_id, attempt_number),
  FOREIGN KEY (crawl_job_id) REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_account_id) REFERENCES capture_provider_accounts(id)
);

CREATE UNIQUE INDEX capture_provider_attempts_external_task_idx
  ON capture_provider_attempts(provider_account_id, external_task_id)
  WHERE external_task_id IS NOT NULL;
CREATE INDEX capture_provider_attempts_job_status_idx
  ON capture_provider_attempts(crawl_job_id, status, attempt_number);
CREATE INDEX capture_provider_attempts_provider_status_idx
  ON capture_provider_attempts(provider, status, created_at);
CREATE INDEX capture_provider_attempts_activity_idx
  ON capture_provider_attempts(created_at, provider_account_id, status);

ALTER TABLE crawl_jobs ADD COLUMN capture_provider TEXT NOT NULL DEFAULT 'dataforseo'
  CHECK (capture_provider IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs'));
ALTER TABLE crawl_jobs ADD COLUMN capture_provider_attempt_id TEXT;
ALTER TABLE crawl_jobs ADD COLUMN capture_adapter_version TEXT;

UPDATE crawl_jobs SET
  capture_provider_attempt_id = 'legacy:' || id,
  capture_adapter_version = 'dataforseo-v1'
WHERE capture_provider_attempt_id IS NULL;

INSERT INTO capture_provider_attempts (
  id, crawl_job_id, provider_account_id, provider, role, attempt_number,
  status, adapter_version, credential_version, external_task_id,
  request_cost_usd, raw_r2_key, error_code, error_message,
  submitted_at, completed_at, created_at, updated_at
)
SELECT
  'legacy:' || job.id, job.id, 'dataforseo:platform:v1', 'dataforseo', 'primary', 1,
  CASE job.status
    WHEN 'queued' THEN 'queued'
    WHEN 'submitting' THEN 'submitting'
    WHEN 'submission_unknown' THEN 'ambiguous'
    WHEN 'submitted' THEN 'awaiting_result'
    WHEN 'awaiting_result' THEN 'awaiting_result'
    WHEN 'normalizing' THEN 'normalizing'
    WHEN 'completed' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'failed'
    ELSE 'ambiguous'
  END,
  'dataforseo-v1', NULL, job.dataforseo_task_id,
  job.request_cost_usd, job.raw_r2_key, job.error_code, job.error_message,
  job.submitted_at, job.completed_at, job.created_at, job.updated_at
FROM crawl_jobs job;

ALTER TABLE snapshot_index ADD COLUMN capture_provider TEXT NOT NULL DEFAULT 'dataforseo'
  CHECK (capture_provider IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs'));
ALTER TABLE snapshot_index ADD COLUMN capture_provider_attempt_id TEXT;
ALTER TABLE snapshot_index ADD COLUMN capture_adapter_version TEXT;

UPDATE snapshot_index SET
  capture_provider_attempt_id = 'legacy:' || crawl_job_id,
  capture_adapter_version = 'dataforseo-v1'
WHERE capture_provider_attempt_id IS NULL;

CREATE INDEX snapshot_index_capture_provider_idx
  ON snapshot_index(capture_provider, captured_at DESC, id DESC);
