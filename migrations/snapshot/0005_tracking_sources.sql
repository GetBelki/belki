ALTER TABLE snapshots ADD COLUMN tracking_source TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'));
ALTER TABLE snapshots ADD COLUMN surface_present INTEGER NOT NULL DEFAULT 1
  CHECK (surface_present IN (0, 1));

CREATE INDEX snapshots_project_source_time_idx
  ON snapshots(project_id, tracking_source, captured_at DESC);
