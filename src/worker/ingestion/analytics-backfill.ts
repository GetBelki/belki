import { nowIso } from "../lib/http";
import {
  ANALYTICS_BACKFILL_BATCH_SIZE,
  ANALYTICS_READ_MODEL_SCHEMA_VERSION,
  FAN_OUT_TELEMETRY_BACKFILL_BATCH_SIZE,
} from "../lib/analytics-read-model";
import { getShard } from "../lib/shards";
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

interface FanOutTelemetryBackfillRow {
  id: string;
  shard_id: number;
}

interface SnapshotFanOutTelemetryRow {
  fan_out_telemetry_status: "reported" | "unavailable" | "unknown";
  id: string;
  model: string | null;
}

export interface AnalyticsBackfillResult {
  projects: number;
  snapshots: number;
  ready: number;
  failed: number;
}

export interface FanOutTelemetryBackfillResult {
  snapshots: number;
  shards: number;
}

const FAN_OUT_TELEMETRY_SHARD_CONCURRENCY = 5;

export async function backfillFanOutTelemetryReadModel(
  env: Env,
): Promise<FanOutTelemetryBackfillResult> {
  const candidates = await env.CONTROL_DB.prepare(
    `SELECT snapshot.id, snapshot.shard_id
     FROM snapshot_index snapshot
     JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
     WHERE snapshot.tracking_source IN ('chatgpt', 'gemini')
       AND fact.related_query_signal_counts_indexed_at IS NOT NULL
       AND fact.fan_out_telemetry_indexed_at IS NULL
     ORDER BY snapshot.captured_at, snapshot.id
     LIMIT ?`,
  )
    .bind(FAN_OUT_TELEMETRY_BACKFILL_BATCH_SIZE)
    .all<FanOutTelemetryBackfillRow>();
  if (!candidates.results.length) return { snapshots: 0, shards: 0 };

  const idsByShard = new Map<number, string[]>();
  for (const candidate of candidates.results) {
    const ids = idsByShard.get(candidate.shard_id) ?? [];
    ids.push(candidate.id);
    idsByShard.set(candidate.shard_id, ids);
  }

  const shardGroups = [...idsByShard.entries()];
  const telemetryRows: SnapshotFanOutTelemetryRow[] = [];
  for (
    let offset = 0;
    offset < shardGroups.length;
    offset += FAN_OUT_TELEMETRY_SHARD_CONCURRENCY
  ) {
    const wave = shardGroups.slice(
      offset,
      offset + FAN_OUT_TELEMETRY_SHARD_CONCURRENCY,
    );
    const waveRows = await Promise.all(wave.map(async ([shardId, snapshotIds]) => {
      const shard = getShard(env, shardId);
      const results = await shard.batch(snapshotIds.map((snapshotId) =>
        shard.prepare(
          `SELECT id, model, fan_out_telemetry_status
           FROM snapshots
           WHERE id = ?`,
        ).bind(snapshotId)
      ));
      return results.flatMap((result) =>
        (result.results ?? []) as unknown as SnapshotFanOutTelemetryRow[]
      );
    }));
    telemetryRows.push(...waveRows.flat());
  }

  if (telemetryRows.length !== candidates.results.length) {
    throw new Error(
      `Fan-out telemetry backfill loaded ${telemetryRows.length} of ${candidates.results.length} snapshots`,
    );
  }

  const indexedAt = nowIso();
  await env.CONTROL_DB.batch(telemetryRows.map((row) =>
    env.CONTROL_DB.prepare(
      `UPDATE analytics_snapshot_facts
       SET provider_model = ?, fan_out_telemetry_status = ?,
         fan_out_telemetry_indexed_at = ?, updated_at = ?
       WHERE snapshot_id = ?`,
    ).bind(
      row.model,
      row.fan_out_telemetry_status,
      indexedAt,
      indexedAt,
      row.id,
    )
  ));

  await env.CONTROL_DB.prepare(
    `UPDATE analytics_read_model_projects
     SET status = 'ready', error_message = NULL, updated_at = ?
     WHERE schema_version >= ?
       AND status IN ('pending', 'backfilling')
       AND NOT EXISTS(
         SELECT 1
         FROM snapshot_index snapshot
         LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
         WHERE snapshot.project_id = analytics_read_model_projects.project_id
           AND (
             fact.snapshot_id IS NULL
             OR fact.related_query_signal_counts_indexed_at IS NULL
             OR (
               snapshot.tracking_source IN ('chatgpt', 'gemini')
               AND fact.fan_out_telemetry_indexed_at IS NULL
             )
           )
       )`,
  )
    .bind(indexedAt, ANALYTICS_READ_MODEL_SCHEMA_VERSION)
    .run();

  return { snapshots: telemetryRows.length, shards: shardGroups.length };
}

export async function backfillAnalyticsReadModel(
  env: Env,
): Promise<AnalyticsBackfillResult> {
  const updatedAt = nowIso();
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

  // Recover projects that were marked ready before every response-level
  // fan-out signal count had actually been persisted.
  await env.CONTROL_DB.prepare(
    `UPDATE analytics_read_model_projects
     SET status = 'pending', error_message = NULL, updated_at = ?
     WHERE status = 'ready'
       AND EXISTS(
         SELECT 1
         FROM snapshot_index snapshot
         LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
         WHERE snapshot.project_id = analytics_read_model_projects.project_id
           AND (
             fact.snapshot_id IS NULL
             OR fact.related_query_signal_counts_indexed_at IS NULL
             OR (
               snapshot.tracking_source IN ('chatgpt', 'gemini')
               AND fact.fan_out_telemetry_indexed_at IS NULL
             )
           )
       )`,
  )
    .bind(updatedAt)
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
         AND (fact.snapshot_id IS NULL OR fact.related_query_signal_counts_indexed_at IS NULL)
       ORDER BY snapshot.captured_at, snapshot.id
       LIMIT ?`,
    )
      .bind(project.project_id, ANALYTICS_BACKFILL_BATCH_SIZE)
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
          AND (
            fact.snapshot_id IS NULL
            OR fact.related_query_signal_counts_indexed_at IS NULL
            OR (
              snapshot.tracking_source IN ('chatgpt', 'gemini')
              AND fact.fan_out_telemetry_indexed_at IS NULL
            )
          )
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
