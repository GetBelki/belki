import { ANALYTICS_READ_MODEL_SCHEMA_VERSION } from "./analytics-read-model";
import { nowIso } from "./http";

export async function markBrandMetricsStale(
  db: D1Database,
  projectId: string,
): Promise<void> {
  const updatedAt = nowIso();
  await db.batch([
    db.prepare(
      `UPDATE projects
       SET brand_metrics_revision = brand_metrics_revision + 1,
         updated_at = ?
       WHERE id = ?`,
    ).bind(updatedAt, projectId),
    db.prepare(
      `INSERT INTO analytics_read_model_projects (
        project_id, status, schema_version, updated_at
      ) VALUES (?, 'pending', ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        status = 'pending',
        schema_version = MAX(
          analytics_read_model_projects.schema_version,
          excluded.schema_version
        ),
        error_message = NULL,
        updated_at = excluded.updated_at`,
    ).bind(projectId, ANALYTICS_READ_MODEL_SCHEMA_VERSION, updatedAt),
  ]);
}
