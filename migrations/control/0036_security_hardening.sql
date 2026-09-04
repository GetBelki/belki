CREATE TABLE provider_callback_claims (
  scope TEXT NOT NULL,
  job_id TEXT NOT NULL,
  external_task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('receiving', 'accepted')),
  r2_key TEXT,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, job_id),
  UNIQUE (scope, external_task_id)
);

CREATE INDEX provider_callback_claims_updated_idx
  ON provider_callback_claims(status, updated_at);

-- Processed payment payloads are not needed for idempotency. Keep the event
-- identity and processing metadata while minimizing retained personal data.
UPDATE billing_events SET payload_json = '{}'
WHERE processed_at IS NOT NULL;
