ALTER TABLE analytics_snapshot_facts
  ADD COLUMN ads_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE analytics_snapshot_facts
  ADD COLUMN ads_indexed_at TEXT;

CREATE TABLE ad_assets (
  source_url TEXT PRIMARY KEY,
  asset_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('creative', 'favicon')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'failed')),
  content_type TEXT,
  size_bytes INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE analytics_ad_occurrences (
  ad_row_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  snapshot_item_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tracked_query_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  advertiser_identity TEXT NOT NULL,
  advertiser_key TEXT NOT NULL,
  advertiser_name TEXT,
  advertiser_raw_url TEXT,
  advertiser_canonical_url TEXT,
  advertiser_hostname TEXT,
  advertiser_domain TEXT,
  title TEXT,
  snippet TEXT,
  raw_url TEXT,
  canonical_url TEXT,
  destination_hostname TEXT,
  destination_domain TEXT,
  image_source_url TEXT,
  favicon_source_url TEXT,
  creative_identity TEXT NOT NULL,
  creative_key TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'untracked'
    CHECK (relationship IN ('owned', 'competitor', 'untracked')),
  matched_tracked_brand_id TEXT,
  rank_group INTEGER,
  rank_absolute INTEGER,
  FOREIGN KEY (snapshot_id) REFERENCES analytics_snapshot_facts(snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
);

CREATE INDEX idx_analytics_ads_project_time
  ON analytics_ad_occurrences(project_id, captured_at DESC, ad_row_id);

CREATE INDEX idx_analytics_ads_project_advertiser_time
  ON analytics_ad_occurrences(
    project_id, advertiser_identity, captured_at DESC, ad_row_id
  );

CREATE INDEX idx_analytics_ads_project_creative_time
  ON analytics_ad_occurrences(
    project_id, creative_identity, captured_at DESC, ad_row_id
  );

CREATE INDEX idx_analytics_ads_query_time
  ON analytics_ad_occurrences(tracked_query_id, captured_at DESC, ad_row_id);

UPDATE analytics_read_model_projects
SET status = 'pending', schema_version = 2,
  backfill_shard_id = NULL, backfill_captured_at = NULL,
  backfill_snapshot_id = NULL, error_message = NULL,
  updated_at = datetime('now');
