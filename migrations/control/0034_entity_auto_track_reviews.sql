CREATE TABLE entity_auto_track_reviews (
  entity_id TEXT NOT NULL REFERENCES project_entities(id) ON DELETE CASCADE,
  extractor_version TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'rejected')),
  evidence_snapshot_count INTEGER NOT NULL DEFAULT 0,
  evidence_prompt_count INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, extractor_version)
);

CREATE INDEX idx_entity_auto_track_reviews_verdict
  ON entity_auto_track_reviews(verdict, reviewed_at);
