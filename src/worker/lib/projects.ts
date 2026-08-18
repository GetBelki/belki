export interface ProjectSummary {
  id: string;
  name: string;
  primary_domain: string | null;
  html_capture_enabled: number;
  created_at: string;
  updated_at: string;
  query_count: number;
  last_snapshot_at: string | null;
  ads_count: number;
  products_count: number;
}

export async function listProjects(
  db: D1Database,
  workspaceId: string,
): Promise<ProjectSummary[]> {
  const rows = await db
    .prepare(
      `SELECT
        p.id, p.name, p.primary_domain, p.html_capture_enabled, p.created_at, p.updated_at,
        (
          SELECT COUNT(*)
          FROM tracked_queries q
          WHERE q.project_id = p.id AND q.deleted_at IS NULL
        ) AS query_count,
        (
          SELECT MAX(s.captured_at)
          FROM snapshot_index s
          WHERE s.project_id = p.id
        ) AS last_snapshot_at,
        (
          SELECT COALESCE(SUM(f.ads_count), 0)
          FROM analytics_snapshot_facts f
          WHERE f.project_id = p.id
        ) AS ads_count,
        (
          SELECT COALESCE(SUM(f.products_count), 0)
          FROM analytics_snapshot_facts f
          WHERE f.project_id = p.id
        ) AS products_count
      FROM projects p
      WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND p.archived_at IS NULL
      ORDER BY p.updated_at DESC`,
    )
    .bind(workspaceId)
    .all<ProjectSummary>();

  return rows.results;
}
