-- Brand matching now rejects dash-joined compounds and ordinary phrase uses
-- of ambiguous common-word names. Rebuild cached brand metrics from source
-- answers under the new matcher instead of retaining false history.
UPDATE projects
SET brand_metrics_revision = brand_metrics_revision + 1,
  updated_at = datetime('now')
WHERE deleted_at IS NULL;

UPDATE analytics_read_model_projects
SET status = 'pending',
  backfill_shard_id = NULL,
  backfill_captured_at = NULL,
  backfill_snapshot_id = NULL,
  error_message = NULL,
  updated_at = datetime('now')
WHERE project_id IN (
  SELECT id FROM projects WHERE deleted_at IS NULL
);
