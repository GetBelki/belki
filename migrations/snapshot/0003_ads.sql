CREATE TABLE snapshot_ads (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  snapshot_item_id TEXT NOT NULL UNIQUE,
  ordinal INTEGER NOT NULL,
  rank_group INTEGER,
  rank_absolute INTEGER,
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
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_item_id) REFERENCES snapshot_items(id) ON DELETE CASCADE
);

CREATE INDEX idx_snapshot_ads_snapshot
  ON snapshot_ads(snapshot_id, ordinal);

CREATE INDEX idx_snapshot_ads_advertiser
  ON snapshot_ads(snapshot_id, advertiser_identity);
