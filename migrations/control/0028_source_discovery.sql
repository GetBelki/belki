CREATE TABLE analytics_citation_url_first_seen (
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
  )),
  canonical_url TEXT NOT NULL,
  registrable_domain TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tracking_source, canonical_url)
);

CREATE INDEX analytics_citation_url_first_seen_date_idx
  ON analytics_citation_url_first_seen(
    tracking_source, first_seen_date, canonical_url
  );

CREATE TABLE analytics_citation_domain_first_seen (
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
  )),
  registrable_domain TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tracking_source, registrable_domain)
);

CREATE INDEX analytics_citation_domain_first_seen_date_idx
  ON analytics_citation_domain_first_seen(
    tracking_source, first_seen_date, registrable_domain
  );

CREATE TABLE source_discovery_backfill (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'backfilling', 'ready')
  ),
  cursor_date TEXT,
  through_date TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO source_discovery_backfill (
  singleton_id, status, cursor_date, through_date, error_message, updated_at
) VALUES (1, 'pending', NULL, NULL, NULL, datetime('now'));

-- These indexes keep period queries bounded to the selected response set. The
-- first-seen history itself is built from the control read model, so no shard
-- replay is required for this feature.
CREATE INDEX analytics_citation_snapshot_url_idx
  ON analytics_citation_occurrences(
    snapshot_id, canonical_url, registrable_domain, ordinal
  );

CREATE INDEX analytics_retrieval_snapshot_url_idx
  ON analytics_retrieval_occurrences(
    snapshot_id, canonical_url, registrable_domain, ordinal
  );
