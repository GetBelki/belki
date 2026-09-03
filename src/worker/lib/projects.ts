import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import type { TrackingSource } from "../../shared/tracking-sources";

export interface ProjectSourceDataCount {
  ads: number;
  products: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  primary_domain: string | null;
  html_capture_enabled: number;
  paused_at: string | null;
  created_at: string;
  updated_at: string;
  query_count: number;
  last_snapshot_at: string | null;
  ads_count: number;
  products_count: number;
  source_data_counts: Partial<Record<TrackingSource, ProjectSourceDataCount>>;
}

export type ProjectSummaryRow = Omit<ProjectSummary, "source_data_counts">;

export interface ProjectSourceCountRow {
  project_id: string;
  tracking_source: TrackingSource;
  ads_count: number;
  products_count: number;
}

export function projectListStatements(
  db: D1Database,
  workspaceId: string,
): [D1PreparedStatement, D1PreparedStatement] {
  return [
    db.prepare(
      `SELECT
        p.id, p.name, p.primary_domain, p.html_capture_enabled, p.paused_at,
        p.created_at, p.updated_at,
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
    ).bind(workspaceId),
    db.prepare(
      `SELECT fact.project_id, fact.tracking_source,
        COALESCE(SUM(fact.ads_count), 0) AS ads_count,
        COALESCE(SUM(fact.products_count), 0) AS products_count
       FROM analytics_snapshot_facts fact
       JOIN projects project ON project.id = fact.project_id
       WHERE project.workspace_id = ? AND project.deleted_at IS NULL
         AND project.archived_at IS NULL
         AND (fact.ads_count > 0 OR fact.products_count > 0)
       GROUP BY fact.project_id, fact.tracking_source`,
    ).bind(workspaceId),
  ];
}

export function projectSummariesFromRows(
  rows: ProjectSummaryRow[],
  sourceCounts: ProjectSourceCountRow[],
): ProjectSummary[] {
  const countsByProject = new Map<
    string,
    Partial<Record<TrackingSource, ProjectSourceDataCount>>
  >();
  for (const count of sourceCounts) {
    const projectCounts = countsByProject.get(count.project_id) ?? {};
    projectCounts[count.tracking_source] = {
      ads: Number(count.ads_count),
      products: Number(count.products_count),
    };
    countsByProject.set(count.project_id, projectCounts);
  }

  return rows.map((project) => ({
    ...project,
    source_data_counts: countsByProject.get(project.id) ?? {},
  }));
}

export async function listProjects(
  db: D1Database,
  workspaceId: string,
): Promise<ProjectSummary[]> {
  const [rowsResult, sourceCountsResult] = await db.batch(
    projectListStatements(db, workspaceId),
  );
  if (!rowsResult || !sourceCountsResult) {
    throw new Error("Project list batch returned incomplete results.");
  }
  return projectSummariesFromRows(
    rowsResult.results as ProjectSummaryRow[],
    sourceCountsResult.results as ProjectSourceCountRow[],
  );
}
