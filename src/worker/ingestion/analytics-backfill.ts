import type { TrackingSource } from "../../shared/contracts";
import {
  createBrandFirstMentionRanker,
  rankBrandFirstMentions,
  type BrandPositionInput,
} from "../lib/brand-position";
import { classifyRelatedQueries } from "../lib/reporting";
import { jsonParse, nowIso } from "../lib/http";
import {
  ANALYTICS_BACKFILL_BATCH_SIZE,
  ANALYTICS_READ_MODEL_SCHEMA_VERSION,
  BRAND_METRICS_BACKFILL_BATCH_SIZE,
  FAN_OUT_SIGNAL_BACKFILL_BATCH_SIZE,
  FAN_OUT_TELEMETRY_BACKFILL_BATCH_SIZE,
  RELATED_QUERY_SIGNAL_COUNTS_VERSION,
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
  tracking_source: TrackingSource;
  metric_date: string;
  captured_at: string;
}

interface FanOutTelemetryBackfillRow {
  id: string;
  shard_id: number;
}

interface FanOutSignalBackfillRow {
  snapshot_id: string;
}

interface FanOutSignalQueryRow {
  query_text: string;
  snapshot_id: string;
}

interface SnapshotFanOutTelemetryRow {
  fan_out_telemetry_status: "reported" | "unavailable" | "unknown";
  id: string;
  model: string | null;
}

interface SnapshotBrandAnswerRow {
  answer_markdown: string | null;
  id: string;
}

interface BackfillBrandRow {
  aliases_json: string;
  id: string;
  kind: "owned" | "competitor";
  name: string;
}

interface SnapshotBrandContributionRow {
  brands: ReturnType<typeof rankBrandFirstMentions>;
  metricDate: string;
  ownedMentioned: number;
  ownedPosition: number | null;
  projectId: string;
  snapshotId: string;
  trackingSource: TrackingSource;
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

export interface FanOutSignalBackfillResult {
  snapshots: number;
}

const FAN_OUT_TELEMETRY_SHARD_CONCURRENCY = 5;
const STALE_BRAND_METRIC_CLEANUP_BATCH_SIZE = 500;
const BRAND_METRICS_SHARD_CONCURRENCY = 5;
const D1_BATCH_STATEMENT_LIMIT = 100;

function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    result.push(rows.slice(offset, offset + size));
  }
  return result;
}

export async function backfillFanOutSignalCounts(
  env: Env,
): Promise<FanOutSignalBackfillResult> {
  const candidates = await env.CONTROL_DB.prepare(
    `SELECT fact.snapshot_id
     FROM analytics_snapshot_facts fact
     WHERE fact.related_query_signal_counts_indexed_at IS NOT NULL
       AND fact.related_queries_indexed_at IS NOT NULL
       AND fact.related_query_signal_counts_version < ?
     ORDER BY CASE
       WHEN fact.tracking_source IN ('chatgpt', 'gemini') THEN 0 ELSE 1
     END, fact.captured_at DESC, fact.snapshot_id
     LIMIT ?`,
  )
    .bind(
      RELATED_QUERY_SIGNAL_COUNTS_VERSION,
      FAN_OUT_SIGNAL_BACKFILL_BATCH_SIZE,
    )
    .all<FanOutSignalBackfillRow>();
  if (!candidates.results.length) return { snapshots: 0 };

  const queriesBySnapshot = new Map<string, string[]>(
    candidates.results.map((row) => [row.snapshot_id, []]),
  );
  for (const batch of chunks(candidates.results, D1_BATCH_STATEMENT_LIMIT)) {
    const placeholders = batch.map(() => "?").join(",");
    const queries = await env.CONTROL_DB.prepare(
      `SELECT snapshot_id, query_text
       FROM analytics_related_query_occurrences
       WHERE snapshot_id IN (${placeholders})
       ORDER BY snapshot_id, ordinal`,
    )
      .bind(...batch.map((row) => row.snapshot_id))
      .all<FanOutSignalQueryRow>();
    for (const query of queries.results) {
      queriesBySnapshot.get(query.snapshot_id)?.push(query.query_text);
    }
  }

  const indexedAt = nowIso();
  for (const batch of chunks(candidates.results, D1_BATCH_STATEMENT_LIMIT)) {
    await env.CONTROL_DB.batch(batch.map((row) => {
      const signalCounts = classifyRelatedQueries(
        queriesBySnapshot.get(row.snapshot_id) ?? [],
      ).signalCounts;
      return env.CONTROL_DB.prepare(
        `UPDATE analytics_snapshot_facts
         SET related_query_signal_counts_json = ?,
           related_query_signal_counts_indexed_at = ?,
           related_query_signal_counts_version = ?, updated_at = ?
         WHERE snapshot_id = ?
           AND related_query_signal_counts_version < ?`,
      ).bind(
        JSON.stringify(signalCounts),
        indexedAt,
        RELATED_QUERY_SIGNAL_COUNTS_VERSION,
        indexedAt,
        row.snapshot_id,
        RELATED_QUERY_SIGNAL_COUNTS_VERSION,
      );
    }));
  }

  return { snapshots: candidates.results.length };
}

async function backfillSnapshotBrandMetrics(
  env: Env,
  snapshots: BackfillSnapshotRow[],
): Promise<void> {
  if (!snapshots.length) return;
  const projectId = snapshots[0]!.project_id;
  const [brandRows, project] = await Promise.all([
    env.CONTROL_DB.prepare(
      `SELECT id, kind, name, aliases_json
       FROM tracked_brands WHERE project_id = ?`,
    ).bind(projectId).all<BackfillBrandRow>(),
    env.CONTROL_DB.prepare(
      "SELECT brand_metrics_revision FROM projects WHERE id = ?",
    ).bind(projectId).first<{ brand_metrics_revision: number }>(),
  ]);
  const revision = Number(project?.brand_metrics_revision ?? 1);
  const brands: BrandPositionInput[] = brandRows.results.map((brand) => ({
    id: brand.id,
    kind: brand.kind,
    name: brand.name,
    aliases: jsonParse<string[]>(brand.aliases_json, []),
  }));
  const snapshotGroups = new Map<number, BackfillSnapshotRow[]>();
  for (const snapshot of snapshots) {
    snapshotGroups.set(snapshot.shard_id, [
      ...(snapshotGroups.get(snapshot.shard_id) ?? []),
      snapshot,
    ]);
  }
  const requests = [...snapshotGroups.entries()].flatMap(([shardId, rows]) =>
    chunks(rows, D1_BATCH_STATEMENT_LIMIT).map((requestRows) => ({
      requestRows,
      shardId,
    }))
  );
  const answers = new Map<string, SnapshotBrandAnswerRow>();
  for (
    let offset = 0;
    offset < requests.length;
    offset += BRAND_METRICS_SHARD_CONCURRENCY
  ) {
    const wave = requests.slice(offset, offset + BRAND_METRICS_SHARD_CONCURRENCY);
    const waveRows = await Promise.all(wave.map(async ({ requestRows, shardId }) => {
      const placeholders = requestRows.map(() => "?").join(",");
      return getShard(env, shardId).prepare(
        `SELECT id, answer_markdown FROM snapshots
         WHERE id IN (${placeholders})`,
      ).bind(...requestRows.map((row) => row.id)).all<SnapshotBrandAnswerRow>();
    }));
    for (const result of waveRows) {
      for (const row of result.results) answers.set(row.id, row);
    }
  }
  if (answers.size !== snapshots.length) {
    throw new Error(
      `Brand metrics backfill loaded ${answers.size} of ${snapshots.length} snapshots`,
    );
  }

  const updatedAt = nowIso();
  const rankBrands = createBrandFirstMentionRanker(brands);
  const contributions: SnapshotBrandContributionRow[] = snapshots.map((snapshot) => {
    const metrics = rankBrands(answers.get(snapshot.id)?.answer_markdown ?? "");
    const ownedPosition = Math.min(
      ...metrics
        .filter((metric) => metric.kind === "owned")
        .map((metric) => metric.position),
      Number.POSITIVE_INFINITY,
    );
    return {
      brands: metrics,
      metricDate: snapshot.metric_date,
      ownedMentioned: Number(Number.isFinite(ownedPosition)),
      ownedPosition: Number.isFinite(ownedPosition) ? ownedPosition : null,
      projectId,
      snapshotId: snapshot.id,
      trackingSource: snapshot.tracking_source,
    };
  });

  for (const batch of chunks(contributions, D1_BATCH_STATEMENT_LIMIT)) {
    await env.CONTROL_DB.batch(batch.map((row) => env.CONTROL_DB.prepare(
      `INSERT INTO analytics_brand_snapshot_metrics (
        snapshot_id, brand_metrics_revision, project_id, tracking_source,
        metric_date, brands_json, owned_mentioned, owned_position, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id, brand_metrics_revision) DO UPDATE SET
        tracking_source = excluded.tracking_source,
        metric_date = excluded.metric_date,
        brands_json = excluded.brands_json,
        owned_mentioned = excluded.owned_mentioned,
        owned_position = excluded.owned_position,
        updated_at = excluded.updated_at`,
    ).bind(
      row.snapshotId,
      revision,
      row.projectId,
      row.trackingSource,
      row.metricDate,
      JSON.stringify(row.brands),
      row.ownedMentioned,
      row.ownedPosition,
      updatedAt,
    )));
  }

  const affectedDates = [...new Set(contributions.map((row) => row.metricDate))];
  const datePlaceholders = affectedDates.map(() => "?").join(",");
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `DELETE FROM analytics_daily_brand_metrics
       WHERE project_id = ? AND brand_metrics_revision = ?
         AND metric_date IN (${datePlaceholders})`,
    ).bind(projectId, revision, ...affectedDates),
    env.CONTROL_DB.prepare(
      `DELETE FROM analytics_daily_owned_brand_metrics
       WHERE project_id = ? AND brand_metrics_revision = ?
         AND metric_date IN (${datePlaceholders})`,
    ).bind(projectId, revision, ...affectedDates),
    env.CONTROL_DB.prepare(
      `INSERT INTO analytics_daily_brand_metrics (
        project_id, tracking_source, metric_date, brand_metrics_revision,
        tracked_brand_id, mentioned_response_count, position_sum,
        position_sample_count, updated_at
      )
      SELECT contribution.project_id, contribution.tracking_source,
        contribution.metric_date, contribution.brand_metrics_revision,
        CAST(json_extract(brand.value, '$.brandId') AS TEXT),
        COUNT(*),
        SUM(CAST(json_extract(brand.value, '$.position') AS REAL)),
        COUNT(*), ?
      FROM analytics_brand_snapshot_metrics contribution
      CROSS JOIN json_each(contribution.brands_json) brand
      JOIN tracked_brands tracked
        ON tracked.id = CAST(json_extract(brand.value, '$.brandId') AS TEXT)
       AND tracked.project_id = contribution.project_id
      WHERE contribution.project_id = ?
        AND contribution.brand_metrics_revision = ?
        AND contribution.metric_date IN (${datePlaceholders})
      GROUP BY contribution.project_id, contribution.tracking_source,
        contribution.metric_date, contribution.brand_metrics_revision,
        CAST(json_extract(brand.value, '$.brandId') AS TEXT)`,
    ).bind(updatedAt, projectId, revision, ...affectedDates),
    env.CONTROL_DB.prepare(
      `INSERT INTO analytics_daily_owned_brand_metrics (
        project_id, tracking_source, metric_date, brand_metrics_revision,
        mentioned_response_count, position_sum, position_sample_count, updated_at
      )
      SELECT project_id, tracking_source, metric_date, brand_metrics_revision,
        SUM(owned_mentioned), SUM(COALESCE(owned_position, 0)),
        SUM(CASE WHEN owned_position IS NULL THEN 0 ELSE 1 END), ?
      FROM analytics_brand_snapshot_metrics
      WHERE project_id = ? AND brand_metrics_revision = ?
        AND metric_date IN (${datePlaceholders})
      GROUP BY project_id, tracking_source, metric_date, brand_metrics_revision
      HAVING SUM(owned_mentioned) > 0`,
    ).bind(updatedAt, projectId, revision, ...affectedDates),
  ]);

  for (const batch of chunks(contributions, D1_BATCH_STATEMENT_LIMIT)) {
    await env.CONTROL_DB.batch(batch.map((row) => env.CONTROL_DB.prepare(
      `UPDATE analytics_snapshot_facts
       SET brand_metrics_revision = ?, updated_at = ?
       WHERE snapshot_id = ?`,
    ).bind(revision, updatedAt, row.snapshotId)));
  }
}

async function cleanupStaleBrandMetricRevisions(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM analytics_brand_snapshot_metrics
       WHERE rowid IN (
         SELECT metric.rowid
         FROM analytics_brand_snapshot_metrics metric
         JOIN projects project ON project.id = metric.project_id
         WHERE metric.brand_metrics_revision != project.brand_metrics_revision
         LIMIT ?
       )`,
    ).bind(STALE_BRAND_METRIC_CLEANUP_BATCH_SIZE),
    db.prepare(
      `DELETE FROM analytics_daily_brand_metrics
       WHERE rowid IN (
         SELECT metric.rowid
         FROM analytics_daily_brand_metrics metric
         JOIN projects project ON project.id = metric.project_id
         WHERE metric.brand_metrics_revision != project.brand_metrics_revision
         LIMIT ?
       )`,
    ).bind(STALE_BRAND_METRIC_CLEANUP_BATCH_SIZE),
    db.prepare(
      `DELETE FROM analytics_daily_owned_brand_metrics
       WHERE rowid IN (
         SELECT metric.rowid
         FROM analytics_daily_owned_brand_metrics metric
         JOIN projects project ON project.id = metric.project_id
         WHERE metric.brand_metrics_revision != project.brand_metrics_revision
         LIMIT ?
       )`,
    ).bind(STALE_BRAND_METRIC_CLEANUP_BATCH_SIZE),
  ]);
}

export async function backfillFanOutTelemetryReadModel(
  env: Env,
): Promise<FanOutTelemetryBackfillResult> {
  const candidates = await env.CONTROL_DB.prepare(
    `SELECT snapshot.id, snapshot.shard_id
     FROM snapshot_index snapshot
     JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
     WHERE snapshot.tracking_source IN ('chatgpt', 'gemini')
       AND fact.related_query_signal_counts_indexed_at IS NOT NULL
       AND fact.related_query_signal_counts_version >= ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
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
             OR fact.related_query_signal_counts_version < ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
             OR fact.brand_metrics_revision != (
               SELECT brand_metrics_revision FROM projects
               WHERE id = snapshot.project_id
             )
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
  await cleanupStaleBrandMetricRevisions(env.CONTROL_DB);
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
             OR fact.related_query_signal_counts_version < ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
             OR fact.brand_metrics_revision != (
               SELECT brand_metrics_revision FROM projects
               WHERE id = snapshot.project_id
             )
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
        snapshot.tracking_source,
        substr(snapshot.captured_at, 1, 10) AS metric_date,
        snapshot.captured_at
       FROM snapshot_index snapshot
       LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
       WHERE snapshot.project_id = ?
         AND (
           fact.snapshot_id IS NULL
           OR fact.related_query_signal_counts_indexed_at IS NULL
           OR fact.related_query_signal_counts_version < ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
         )
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

    let processedSnapshots = snapshots.results;
    if (!processedSnapshots.length) {
      const brandSnapshots = await env.CONTROL_DB.prepare(
        `SELECT
          snapshot.id,
          snapshot.project_id,
          snapshot.tracked_query_id,
          snapshot.shard_id,
          snapshot.tracking_source,
          substr(snapshot.captured_at, 1, 10) AS metric_date,
          snapshot.captured_at
         FROM snapshot_index snapshot
         JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
         JOIN projects project ON project.id = snapshot.project_id
         WHERE snapshot.project_id = ?
           AND fact.related_query_signal_counts_indexed_at IS NOT NULL
           AND fact.related_query_signal_counts_version >= ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
           AND fact.brand_metrics_revision != project.brand_metrics_revision
         ORDER BY snapshot.captured_at, snapshot.id
         LIMIT ?`,
      )
        .bind(project.project_id, BRAND_METRICS_BACKFILL_BATCH_SIZE)
        .all<BackfillSnapshotRow>();
      await backfillSnapshotBrandMetrics(env, brandSnapshots.results);
      processedSnapshots = brandSnapshots.results;
    }

    const lastSnapshot = processedSnapshots.at(-1);
    const remaining = await env.CONTROL_DB.prepare(
      `SELECT EXISTS(
        SELECT 1
        FROM snapshot_index snapshot
        LEFT JOIN analytics_snapshot_facts fact ON fact.snapshot_id = snapshot.id
        WHERE snapshot.project_id = ?
          AND (
            fact.snapshot_id IS NULL
            OR fact.related_query_signal_counts_indexed_at IS NULL
            OR fact.related_query_signal_counts_version < ${RELATED_QUERY_SIGNAL_COUNTS_VERSION}
            OR fact.brand_metrics_revision != (
              SELECT brand_metrics_revision FROM projects
              WHERE id = snapshot.project_id
            )
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
      snapshots: processedSnapshots.length,
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
