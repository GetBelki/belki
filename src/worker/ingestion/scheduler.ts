import type { JobQueueMessage, RollupQueueMessage } from "../../shared/contracts";
import { createSignedJobTag } from "../lib/crypto";
import { getLocaleCatalog } from "../lib/dataforseo";
import { nowIso } from "../lib/http";
import { calculateNextRun, scheduleFromRow } from "../lib/schedule";
import { getShard, SHARD_COUNT } from "../lib/shards";

interface DueQueryRow {
  id: string;
  workspace_id: string;
  project_id: string;
  shard_id: number;
  next_run_at: string;
  schedule_cadence: string;
  schedule_time: string;
  schedule_timezone: string;
  schedule_weekday: number | null;
  html_capture_enabled: number;
}

export async function enqueueDueQueries(env: Env): Promise<number> {
  const due = await env.CONTROL_DB.prepare(
    `SELECT
      q.id, p.workspace_id, q.project_id, q.shard_id, q.next_run_at,
      q.schedule_cadence, q.schedule_time, q.schedule_timezone,
      q.schedule_weekday, p.html_capture_enabled
    FROM tracked_queries q
    JOIN projects p ON p.id = q.project_id
    WHERE q.is_active = 1 AND q.deleted_at IS NULL AND p.deleted_at IS NULL
      AND q.next_run_at <= ?
      AND (
        SELECT COUNT(*) FROM crawl_jobs j
        WHERE j.workspace_id = p.workspace_id
          AND j.created_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
      ) + (
        SELECT COALESCE(SUM(usage.requested_runs), 0)
        FROM deleted_prompt_usage_daily usage
        WHERE usage.workspace_id = p.workspace_id
          AND usage.usage_date >= strftime('%Y-%m-01', 'now')
      ) < (
        SELECT monthly_run_cap FROM workspaces w WHERE w.id = p.workspace_id
      )
    ORDER BY q.next_run_at
    LIMIT 5000`,
  )
    .bind(nowIso())
    .all<DueQueryRow>();
  if (due.results.length === 0) return 0;

  const messages: JobQueueMessage[] = [];
  for (let start = 0; start < due.results.length; start += 100) {
    const group = due.results.slice(start, start + 100);
    const statements: D1PreparedStatement[] = [];
    for (const query of group) {
      const jobId = crypto.randomUUID();
      const tag = await createSignedJobTag(jobId, env.APP_CRYPTO_KEY);
      const createdAt = nowIso();
      statements.push(
        env.CONTROL_DB.prepare(
          `INSERT OR IGNORE INTO crawl_jobs (
            id, workspace_id, project_id, tracked_query_id, shard_id, run_type,
            delivery_method, status, scheduled_for, provider_tag, capture_html,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'scheduled', 'standard', 'queued', ?, ?, ?, ?, ?)`,
        ).bind(
          jobId,
          query.workspace_id,
          query.project_id,
          query.id,
          query.shard_id,
          query.next_run_at,
          tag,
          query.html_capture_enabled,
          createdAt,
          createdAt,
        ),
        env.CONTROL_DB.prepare(
          "UPDATE tracked_queries SET next_run_at = ?, updated_at = ? WHERE id = ?",
        ).bind(
          calculateNextRun(
            scheduleFromRow(query),
            new Date(Date.parse(query.next_run_at) + 1),
          ),
          createdAt,
          query.id,
        ),
      );
      messages.push({ jobId });
    }
    await env.CONTROL_DB.batch(statements);
  }
  for (let start = 0; start < messages.length; start += 100) {
    await env.STANDARD_QUEUE.sendBatch(
      messages.slice(start, start + 100).map((body) => ({ body })),
    );
  }
  return messages.length;
}

export async function reconcileJobs(env: Env): Promise<number> {
  const stale = await env.CONTROL_DB.prepare(
    `SELECT job.id, job.delivery_method FROM crawl_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     WHERE query.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM prompt_purge_jobs purge
         WHERE purge.tracked_query_id = query.id
       ) AND (
         (
           job.status = 'queued'
           AND julianday(job.updated_at) < julianday('now', '-5 minutes')
         ) OR (
           job.status = 'submission_unknown'
           AND julianday(job.updated_at) < julianday('now', '-60 minutes')
           AND job.submit_attempts < 2
         )
       )
     ORDER BY job.updated_at
     LIMIT 500`,
  ).all<{ id: string; delivery_method: string }>();
  for (const job of stale.results) {
    await env.CONTROL_DB.prepare(
      "UPDATE crawl_jobs SET status = 'queued', updated_at = ? WHERE id = ?",
    )
      .bind(nowIso(), job.id)
      .run();
    const queue = job.delivery_method === "live" ? env.LIVE_QUEUE : env.STANDARD_QUEUE;
    await queue.send({ jobId: job.id } satisfies JobQueueMessage);
  }
  return stale.results.length;
}

function flattenCatalogResults(payload: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (
      typeof record.location_code === "number" ||
      typeof record.language_code === "string"
    ) {
      found.push(record);
    }
    Object.values(record).forEach(visit);
  }
  visit(payload);
  return found;
}

export async function refreshLocaleCatalog(env: Env): Promise<number> {
  const [locations, languages] = await Promise.all([
    getLocaleCatalog(env, "locations"),
    getLocaleCatalog(env, "languages"),
  ]);
  const rows = [
    ...flattenCatalogResults(locations).map((row) => ({
      kind: "location" as const,
      code: String(row.location_code),
      name: String(row.location_name ?? row.location_code),
      payload: row,
    })),
    ...flattenCatalogResults(languages).map((row) => ({
      kind: "language" as const,
      code: String(row.language_code),
      name: String(row.language_name ?? row.language_code),
      payload: row,
    })),
  ];
  for (let start = 0; start < rows.length; start += 100) {
    await env.CONTROL_DB.batch(
      rows.slice(start, start + 100).map((row) =>
        env.CONTROL_DB.prepare(
          `INSERT INTO locale_catalog (kind, code, name, payload_json, refreshed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(kind, code) DO UPDATE SET
             name = excluded.name, payload_json = excluded.payload_json,
             refreshed_at = excluded.refreshed_at`,
        ).bind(row.kind, row.code, row.name, JSON.stringify(row.payload), nowIso()),
      ),
    );
  }
  return rows.length;
}

export async function reconcileMetricOutboxes(env: Env): Promise<number> {
  let queued = 0;
  for (let shardId = 0; shardId < SHARD_COUNT; shardId += 1) {
    const pending = await getShard(env, shardId)
      .prepare(
        `SELECT snapshot_id FROM metric_outbox
         WHERE delivered_at IS NULL ORDER BY created_at LIMIT 100`,
      )
      .all<{ snapshot_id: string }>();
    if (!pending.results.length) continue;
    await env.ROLLUP_QUEUE.sendBatch(
      pending.results.map((row) => ({
        body: { snapshotId: row.snapshot_id, shardId } satisfies RollupQueueMessage,
      })),
    );
    queued += pending.results.length;
  }
  return queued;
}

export async function runRetention(env: Env): Promise<void> {
  const now = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.CONTROL_DB.prepare(
      "DELETE FROM auth_tokens WHERE expires_at < ? OR julianday(consumed_at) < julianday('now', '-7 days')",
    ).bind(now),
    env.CONTROL_DB.prepare(
      "DELETE FROM ingest_events WHERE julianday(received_at) < julianday('now', '-90 days')",
    ),
    env.CONTROL_DB.prepare(
      `UPDATE exports SET status = 'expired', updated_at = ?
       WHERE expires_at < ? AND status = 'completed'`,
    ).bind(now, now),
  ]);
  for (let shardId = 0; shardId < SHARD_COUNT; shardId += 1) {
    await getShard(env, shardId)
      .prepare(
        "DELETE FROM snapshots WHERE julianday(captured_at) < julianday('now', '-12 months')",
      )
      .run();
  }
  await env.CONTROL_DB.prepare(
    "DELETE FROM snapshot_index WHERE julianday(captured_at) < julianday('now', '-12 months')",
  ).run();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `DELETE FROM project_entities
       WHERE tracked_brand_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM entity_mentions mention
           WHERE mention.entity_id = project_entities.id
         )`,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE project_entities SET
        snapshot_count = (
          SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id
        ),
        prompt_count = (
          SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id
        ),
        competitor_snapshot_count = (
          SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id AND mention.relationship = 'competitor'
        ),
        competitor_prompt_count = (
          SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id AND mention.relationship = 'competitor'
        ),
        updated_at = ?`,
    ).bind(now),
  ]);
  await env.CONTROL_DB.prepare(
    `DELETE FROM crawl_jobs
     WHERE julianday(created_at) < julianday('now', '-12 months')
       AND status IN ('completed', 'failed', 'cancelled')`,
  ).run();
  await env.CONTROL_DB.prepare(
    `DELETE FROM product_enrichment_jobs
     WHERE julianday(created_at) < julianday('now', '-12 months')
       AND status IN ('completed', 'failed', 'cancelled')`,
  ).run();
}
