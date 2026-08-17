import { nowIso } from "../lib/http";
import { ANALYTICS_READ_MODEL_SCHEMA_VERSION } from "../lib/analytics-read-model";
import { syncAnalyticsReadModel } from "./analytics-read-model";

interface BackfillProjectRow {
  project_id: string;
}

interface BackfillSnapshotRow {
  id: string;
  project_id: string;
  tracked_query_id: string;
  shard_id: number;
  metric_date: string;
  captured_at: string;
}

export interface AnalyticsBackfillResult {
  projects: number;
  snapshots: number;
  ready: number;
  failed: number;
}

const BACKFILL_BATCH_SIZE = 50;
export async function backfillAnalyticsReadModel(
  env: Env,
): Promise<AnalyticsBackfillResult> {
  const updatedAt = nowIso();
  // A schema bump means existing facts must be replayed even when an older
  // version marked them indexed. Clearing this timestamp once makes the
  // ordinary bounded backfill loop repair every source snapshot.
  await env.CONTROL_DB.prepare(
    `UPDATE analytics_snapshot_facts
     SET ad_render_status_indexed_at = NULL
     WHERE project_id IN (
       SELECT project.id
       FROM projects project
       LEFT JOIN analytics_read_model_projects state ON state.project_id = project.id
       WHERE project.deleted_at IS NULL
         AND (state.project_id IS NULL OR state.schema_version < ?)
     )`,
  )
    .bind(ANALYTICS_READ_MODEL_SCHEMA_VERSION)
    .run();
  await env.CONTROL_DB.prepare(
    `INSERT INTO analytics_read_model_projects (
      project_id, status, schema_version, updated_at
    )
    SELECT id, 'pending', ?, ?
    FROM projects
    WHERE deleted_at IS NULL
    ON CONFLICT(project_id) DO UPDATE SET
      status = CASE
        WHEN analytics_read_model_projects.schema_version < excluded.schema_version
          THEN 'pending'
        ELSE analytics_read_model_projects.status
      END,
      schema_version = MAX(
        analytics_read_model_projects.schema_version,
        excluded.schema_version
      ),
      updated_at = CASE
        WHEN analytics_read_model_projects.schema_version < excluded.schema_version
          THEN excluded.updated_at
        ELSE analytics_read_model_projects.updated_at
      END`,
  )
    .bind(ANALYTICS_READ_MODEL_SCHEMA_VERSION, updatedAt)
    .run();

  const project = await env.CONTROL_DB.prepare(
    `SELECT state.project_id
     FROM analytics_read_model_projects state
     JOIN projects project ON project.id = state.project_id
     WHERE state.status IN ('pending', 'backfilling')
       AND project.deleted_at IS NULL
     ORDER BY
       CASE state.status WHEN 'backfilling' THEN 0 ELSE 1 END,
       state.updated_at,
       state.project_id
     LIMIT 1`,
  ).first<BackfillProjectRow>();

  if (!project) {
    return { projects: 0, snapshots: 0, ready: 0, failed: 0 };
  }

  await env.CONTROL_DB.prepare(
    `UPDATE analytics_read_model_projects
     SET status = 'backfilling', error_message = NULL, updated_at = ?
     WHERE project_id = ?`,
  )
    .bind(updatedAt, project.project_id)
    .run();

  try {
    const snapshots = await env.CONTROL_DB.prepare(
      `SELECT
        snapshot.id,
        snapshot.project_id,
        snapshot.tracked_query_id,
        snapshot.shard_id,
        substr(snapshot.captured_at, 1, 10) AS metric_date,
        snapshot.captured_at
       FROM snapshot_index snapshot
       LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
       WHERE snapshot.project_id = ?
         AND (fact.snapshot_id IS NULL OR fact.ad_render_status_indexed_at IS NULL)
       ORDER BY snapshot.captured_at, snapshot.id
       LIMIT ?`,
    )
      .bind(project.project_id, BACKFILL_BATCH_SIZE)
      .all<BackfillSnapshotRow>();

    for (const snapshot of snapshots.results) {
      await syncAnalyticsReadModel(env, snapshot.shard_id, {
        snapshotId: snapshot.id,
        projectId: snapshot.project_id,
        trackedQueryId: snapshot.tracked_query_id,
        metricDate: snapshot.metric_date,
      });
    }

    const lastSnapshot = snapshots.results.at(-1);
    const remaining = await env.CONTROL_DB.prepare(
      `SELECT EXISTS(
        SELECT 1
        FROM snapshot_index snapshot
        LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
        WHERE snapshot.project_id = ?
          AND (fact.snapshot_id IS NULL OR fact.ad_render_status_indexed_at IS NULL)
      ) AS has_more`,
    )
      .bind(project.project_id)
      .first<{ has_more: number }>();
    const isReady = Number(remaining?.has_more ?? 0) === 0;

    await env.CONTROL_DB.prepare(
      `UPDATE analytics_read_model_projects
       SET status = ?,
         backfill_shard_id = COALESCE(?, backfill_shard_id),
         backfill_captured_at = COALESCE(?, backfill_captured_at),
         backfill_snapshot_id = COALESCE(?, backfill_snapshot_id),
         error_message = NULL,
         updated_at = ?
       WHERE project_id = ?`,
    )
      .bind(
        isReady ? "ready" : "backfilling",
        lastSnapshot?.shard_id ?? null,
        lastSnapshot?.captured_at ?? null,
        lastSnapshot?.id ?? null,
        nowIso(),
        project.project_id,
      )
      .run();

    return {
      projects: 1,
      snapshots: snapshots.results.length,
      ready: isReady ? 1 : 0,
      failed: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown backfill error";
    await env.CONTROL_DB.prepare(
      `UPDATE analytics_read_model_projects
       SET status = 'pending', error_message = ?, updated_at = ?
       WHERE project_id = ?`,
    )
      .bind(message.slice(0, 1_000), nowIso(), project.project_id)
      .run();
    console.error(
      JSON.stringify({
        level: "error",
        event: "analytics_read_model.backfill_failed",
        projectId: project.project_id,
        error: message,
      }),
    );
    return { projects: 1, snapshots: 0, ready: 0, failed: 1 };
  }
}
