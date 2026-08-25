import { ANALYTICS_READ_MODEL_SCHEMA_VERSION } from "./analytics-read-model";
import { nowIso } from "./http";

/**
 * Brand configuration changes are effective from the time they are made.
 * Historical metrics describe the tracked set that was active for each
 * capture, so changing that set must not invalidate an otherwise-ready
 * project or restart a project-wide snapshot scan.
 *
 * Keep this helper for mutation paths that can run before the first snapshot:
 * it creates missing read-model state without touching an existing project.
 */
export async function preserveBrandMetricsHistory(
  db: D1Database,
  projectId: string,
): Promise<void> {
  const updatedAt = nowIso();
  await db.prepare(
    `INSERT INTO analytics_read_model_projects (
      project_id, status, schema_version, updated_at
    ) VALUES (?, 'pending', ?, ?)
    ON CONFLICT(project_id) DO NOTHING`,
  ).bind(projectId, ANALYTICS_READ_MODEL_SCHEMA_VERSION, updatedAt).run();
}
