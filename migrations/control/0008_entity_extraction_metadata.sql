PRAGMA foreign_keys = ON;

ALTER TABLE snapshot_index
  ADD COLUMN detected_entities_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE entity_extraction_jobs
  ADD COLUMN pricing_version TEXT NOT NULL DEFAULT '2026-08-11';
