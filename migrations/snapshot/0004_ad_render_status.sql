ALTER TABLE snapshot_ads
  ADD COLUMN is_rendered INTEGER NOT NULL DEFAULT 1
    CHECK (is_rendered IN (0, 1));
