CREATE INDEX IF NOT EXISTS idx_analytics_product_project_snapshot_ordinal
  ON analytics_product_occurrences(
    project_id,
    snapshot_id,
    ordinal,
    product_row_id
  );
