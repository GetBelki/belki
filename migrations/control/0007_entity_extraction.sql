PRAGMA foreign_keys = ON;

ALTER TABLE workspaces
  ADD COLUMN entity_extraction_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE workspaces
  ADD COLUMN entity_auto_track_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE workspaces
  ADD COLUMN entity_extraction_warning_usd REAL NOT NULL DEFAULT 5;

CREATE TABLE entity_extraction_jobs (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  shard_id INTEGER NOT NULL CHECK (shard_id BETWEEN 0 AND 31),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')
  ),
  model TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  input_price_per_million_usd REAL NOT NULL,
  output_price_per_million_usd REAL NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES snapshot_index(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

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

CREATE TABLE project_entities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('brand', 'company', 'organization', 'product', 'person', 'place', 'other')
  ),
  relationship TEXT NOT NULL DEFAULT 'unknown' CHECK (
    relationship IN ('owned', 'competitor', 'mentioned', 'unknown')
  ),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (
    status IN ('candidate', 'auto_tracked', 'tracked', 'ignored', 'merged')
  ),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  domains_json TEXT NOT NULL DEFAULT '[]',
  tracked_brand_id TEXT,
  merged_into_id TEXT,
  provider_corroborated INTEGER NOT NULL DEFAULT 0,
  domain_corroborated INTEGER NOT NULL DEFAULT 0,
  snapshot_count INTEGER NOT NULL DEFAULT 0,
  prompt_count INTEGER NOT NULL DEFAULT 0,
  competitor_snapshot_count INTEGER NOT NULL DEFAULT 0,
  competitor_prompt_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, normalized_name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_brand_id) REFERENCES tracked_brands(id) ON DELETE SET NULL,
  FOREIGN KEY (merged_into_id) REFERENCES project_entities(id) ON DELETE SET NULL
);

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
  UNIQUE (snapshot_id, entity_id),
  FOREIGN KEY (snapshot_id) REFERENCES snapshot_index(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES project_entities(id) ON DELETE CASCADE
);

CREATE INDEX idx_entity_jobs_status_time
  ON entity_extraction_jobs(status, updated_at);
CREATE INDEX idx_entity_jobs_workspace_time
  ON entity_extraction_jobs(workspace_id, created_at DESC);
CREATE INDEX idx_project_entities_project_status
  ON project_entities(project_id, status, last_seen_at DESC);
CREATE INDEX idx_project_entities_tracked_brand
  ON project_entities(tracked_brand_id);
CREATE INDEX idx_entity_mentions_project_time
  ON entity_mentions(project_id, captured_at DESC);
CREATE INDEX idx_entity_mentions_entity_time
  ON entity_mentions(entity_id, captured_at DESC);
CREATE INDEX idx_entity_mentions_query
  ON entity_mentions(tracked_query_id);
