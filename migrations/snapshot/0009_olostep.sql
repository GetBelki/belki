-- Extend provider/platform checks without rebuilding parent tables.
-- Replace checked non-key columns in place; rebuild only leaf tables.
-- Explicit column lists preserve data even when column order changes.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER "snapshots_fanout_telemetry_infer_unknown";


-- snapshots

DROP INDEX "idx_snapshots_project_time";

DROP INDEX "idx_snapshots_query_time";

DROP INDEX "idx_snapshots_project_time_seek";

DROP INDEX "idx_snapshots_query_time_seek";

DROP INDEX "snapshots_project_source_time_idx";

DROP INDEX "snapshots_fanout_telemetry_idx";

DROP INDEX "snapshots_capture_provider_idx";

ALTER TABLE snapshots ADD COLUMN tracking_source_olostep TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source_olostep IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'));

UPDATE snapshots SET tracking_source_olostep = tracking_source;

ALTER TABLE snapshots DROP COLUMN tracking_source;

ALTER TABLE snapshots RENAME COLUMN tracking_source_olostep TO tracking_source;

ALTER TABLE snapshots ADD COLUMN capture_provider_olostep TEXT NOT NULL DEFAULT 'dataforseo'
  CHECK (capture_provider_olostep IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs', 'olostep'));

UPDATE snapshots SET capture_provider_olostep = capture_provider;

ALTER TABLE snapshots DROP COLUMN capture_provider;

ALTER TABLE snapshots RENAME COLUMN capture_provider_olostep TO capture_provider;

CREATE INDEX idx_snapshots_project_time ON snapshots(project_id, captured_at DESC);

CREATE INDEX idx_snapshots_query_time ON snapshots(tracked_query_id, captured_at DESC);

CREATE INDEX idx_snapshots_project_time_seek
  ON snapshots(project_id, captured_at DESC, id DESC);

CREATE INDEX idx_snapshots_query_time_seek
  ON snapshots(tracked_query_id, captured_at DESC, id DESC);

CREATE INDEX snapshots_project_source_time_idx
  ON snapshots(project_id, tracking_source, captured_at DESC);

CREATE INDEX snapshots_fanout_telemetry_idx
  ON snapshots(fan_out_telemetry_status, model, captured_at DESC);

CREATE INDEX snapshots_capture_provider_idx
  ON snapshots(project_id, capture_provider, captured_at DESC);

CREATE TRIGGER snapshots_fanout_telemetry_infer_unknown
AFTER INSERT ON snapshots
WHEN NEW.fan_out_telemetry_status = 'unknown'
BEGIN
  UPDATE snapshots
  SET fan_out_telemetry_status = CASE
    WHEN json_array_length(NEW.fan_out_queries_json) > 0 OR NEW.model IS NOT NULL
      THEN 'reported'
    ELSE 'unavailable'
  END
  WHERE id = NEW.id;
END;

PRAGMA defer_foreign_keys = OFF;
