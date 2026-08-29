ALTER TABLE snapshots ADD COLUMN capture_provider TEXT NOT NULL DEFAULT 'dataforseo'
  CHECK (capture_provider IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs'));
ALTER TABLE snapshots ADD COLUMN capture_provider_attempt_id TEXT;
ALTER TABLE snapshots ADD COLUMN capture_adapter_version TEXT;

UPDATE snapshots SET
  capture_provider_attempt_id = 'legacy:' || crawl_job_id,
  capture_adapter_version = 'dataforseo-v1'
WHERE capture_provider_attempt_id IS NULL;

CREATE INDEX snapshots_capture_provider_idx
  ON snapshots(project_id, capture_provider, captured_at DESC);
