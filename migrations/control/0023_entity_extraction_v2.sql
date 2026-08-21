PRAGMA foreign_keys = ON;

ALTER TABLE projects
  ADD COLUMN active_entity_extractor_version TEXT NOT NULL DEFAULT 'entities-v2';

-- Existing projects keep serving v1 until their versioned v2 backfill is complete.
-- Projects created after this migration start directly on v2.
UPDATE projects SET active_entity_extractor_version = 'entities-v1';

ALTER TABLE entity_extraction_chunks RENAME TO entity_extraction_chunks_v1;
ALTER TABLE entity_extraction_jobs RENAME TO entity_extraction_jobs_v1;

CREATE TABLE entity_extraction_jobs (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  shard_id INTEGER NOT NULL CHECK (shard_id BETWEEN 0 AND 31),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')
  ),
  model TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  run_type TEXT NOT NULL DEFAULT 'live' CHECK (
    run_type IN ('live', 'backfill', 'evaluation')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  input_price_per_million_usd REAL NOT NULL,
  output_price_per_million_usd REAL NOT NULL,
  pricing_version TEXT NOT NULL DEFAULT '2026-08-11',
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (snapshot_id, extractor_version),
  FOREIGN KEY (snapshot_id) REFERENCES snapshot_index(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

INSERT INTO entity_extraction_jobs (
  id, snapshot_id, workspace_id, project_id, tracked_query_id, shard_id,
  status, model, extractor_version, run_type, attempts, input_tokens,
  output_tokens, estimated_cost_usd, input_price_per_million_usd,
  output_price_per_million_usd, pricing_version, error_message, created_at,
  started_at, completed_at, updated_at
)
SELECT
  id, snapshot_id, workspace_id, project_id, tracked_query_id, shard_id,
  status, model, extractor_version, 'live', attempts, input_tokens,
  output_tokens, estimated_cost_usd, input_price_per_million_usd,
  output_price_per_million_usd, pricing_version, error_message, created_at,
  started_at, completed_at, updated_at
FROM entity_extraction_jobs_v1;

CREATE TABLE entity_extraction_chunks (
  job_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'processing', 'completed', 'failed')
  ),
  result_json TEXT NOT NULL DEFAULT '{"entities":[]}',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, chunk_index),
  FOREIGN KEY (job_id) REFERENCES entity_extraction_jobs(id) ON DELETE CASCADE
);

INSERT INTO entity_extraction_chunks (
  job_id, chunk_index, input_hash, status, result_json, input_tokens,
  output_tokens, estimated_cost_usd, created_at, completed_at, updated_at
)
SELECT
  job_id, chunk_index, input_hash, status, result_json, input_tokens,
  output_tokens, estimated_cost_usd, created_at, completed_at, updated_at
FROM entity_extraction_chunks_v1;

DROP TABLE entity_extraction_chunks_v1;
DROP TABLE entity_extraction_jobs_v1;

CREATE INDEX idx_entity_jobs_status_time
  ON entity_extraction_jobs(extractor_version, status, updated_at);
CREATE INDEX idx_entity_jobs_workspace_time
  ON entity_extraction_jobs(workspace_id, run_type, created_at DESC);

ALTER TABLE entity_mentions RENAME TO entity_mentions_v1;

CREATE TABLE entity_mentions (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  surface_text TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  entity_type TEXT NOT NULL,
  relationship TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  evidence_tier TEXT NOT NULL DEFAULT 'weak' CHECK (
    evidence_tier IN ('strong', 'moderate', 'weak')
  ),
  relationship_reason TEXT NOT NULL DEFAULT 'legacy_classifier' CHECK (
    relationship_reason IN (
      'owned_brand', 'tracked_competitor', 'explicit_comparison',
      'alternative_or_substitute', 'explicit_rival',
      'same_recommendation_set', 'incidental_mention',
      'insufficient_context', 'legacy_classifier'
    )
  ),
  UNIQUE (snapshot_id, entity_id, extractor_version),
  FOREIGN KEY (snapshot_id) REFERENCES snapshot_index(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES project_entities(id) ON DELETE CASCADE
);

INSERT INTO entity_mentions (
  id, snapshot_id, workspace_id, project_id, tracked_query_id, entity_id,
  surface_text, occurrence_count, entity_type, relationship, confidence,
  evidence_json, sources_json, captured_at, created_at, extractor_version,
  evidence_tier, relationship_reason
)
SELECT
  id, snapshot_id, workspace_id, project_id, tracked_query_id, entity_id,
  surface_text, occurrence_count, entity_type, relationship, confidence,
  evidence_json, sources_json, captured_at, created_at, 'entities-v1',
  CASE
    WHEN confidence >= 0.9 THEN 'strong'
    WHEN confidence >= 0.7 THEN 'moderate'
    ELSE 'weak'
  END,
  'legacy_classifier'
FROM entity_mentions_v1;

DROP TABLE entity_mentions_v1;

CREATE INDEX idx_entity_mentions_project_time
  ON entity_mentions(project_id, extractor_version, captured_at DESC);
CREATE INDEX idx_entity_mentions_entity_time
  ON entity_mentions(entity_id, extractor_version, captured_at DESC);
CREATE INDEX idx_entity_mentions_query
  ON entity_mentions(tracked_query_id, extractor_version);
