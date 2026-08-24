import type { Principal, PromptPurgeQueueMessage } from "../../shared/contracts";
import { getShard } from "../lib/shards";
import { ApiError, jsonParse, nowIso } from "../lib/http";
import { prepareAudit } from "../lib/audit";
import { projectEventStatement } from "../lib/project-events";

const PURGE_GRACE_SECONDS = 120;

interface PromptRow {
  id: string;
  project_id: string;
  shard_id: number;
  deleted_at: string | null;
}

interface PurgeJobRow {
  id: string;
  workspace_id: string;
  project_id: string;
  tracked_query_id: string;
  shard_id: number;
  status: "pending" | "queued" | "processing" | "finalizing" | "completed" | "failed";
  r2_keys_json: string;
  affected_dates_json: string;
  not_before: string;
}

interface ExportArtifactRow {
  id: string;
  r2_key: string | null;
}

interface PurgeRequestResult {
  acceptedCount: number;
  queryIds: string[];
  status: "queued";
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function deleteR2Keys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let start = 0; start < keys.length; start += 1_000) {
    await bucket.delete(keys.slice(start, start + 1_000));
  }
}

export async function requestPromptPurges(
  env: Env,
  principal: Principal,
  projectId: string,
  queryIds: string[],
): Promise<PurgeRequestResult> {
  const project = await env.CONTROL_DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL",
  )
    .bind(projectId, principal.workspaceId)
    .first<{ id: string }>();
  if (!project) throw new ApiError(404, "project_not_found", "Project not found.");

  const [promptResult, existingPurgeResult] = await Promise.all([
    env.CONTROL_DB.prepare(
      `SELECT q.id, q.project_id, q.shard_id, q.deleted_at
       FROM tracked_queries q
       JOIN projects p ON p.id = q.project_id
       WHERE q.id IN (${placeholders(queryIds)})
         AND q.project_id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
    )
      .bind(...queryIds, projectId, principal.workspaceId)
      .all<PromptRow>(),
    env.CONTROL_DB.prepare(
      `SELECT tracked_query_id AS id
       FROM prompt_purge_jobs
       WHERE tracked_query_id IN (${placeholders(queryIds)})
         AND project_id = ? AND workspace_id = ?`,
    )
      .bind(...queryIds, projectId, principal.workspaceId)
      .all<{ id: string }>(),
  ]);

  const foundIds = new Set([
    ...promptResult.results.map((row) => row.id),
    ...existingPurgeResult.results.map((row) => row.id),
  ]);
  if (queryIds.some((id) => !foundIds.has(id))) {
    throw new ApiError(404, "query_not_found", "One or more prompts were not found.");
  }

  const existingPurgeIds = new Set(existingPurgeResult.results.map((row) => row.id));
  const newPrompts = promptResult.results.filter((row) => !existingPurgeIds.has(row.id));
  if (newPrompts.length) {
    const now = nowIso();
    const notBefore = new Date(Date.parse(now) + PURGE_GRACE_SECONDS * 1_000).toISOString();
    const statements: D1PreparedStatement[] = [];
    const activeByShard = new Map<number, number>();

    for (const prompt of newPrompts) {
      const purgeJobId = crypto.randomUUID();
      statements.push(
        env.CONTROL_DB.prepare(
          `INSERT INTO prompt_purge_jobs (
            id, workspace_id, project_id, tracked_query_id, shard_id, status,
            not_before, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        ).bind(
          purgeJobId,
          principal.workspaceId,
          projectId,
          prompt.id,
          prompt.shard_id,
          notBefore,
          now,
          now,
        ),
        env.CONTROL_DB.prepare(
          `UPDATE tracked_queries
           SET query_text = '[deleted prompt]', is_active = 0,
             deleted_at = COALESCE(deleted_at, ?), updated_at = ?
           WHERE id = ?`,
        ).bind(now, now, prompt.id),
        env.CONTROL_DB.prepare(
          `UPDATE crawl_jobs SET status = 'cancelled', updated_at = ?
           WHERE tracked_query_id = ?
             AND status IN (
               'queued', 'submitting', 'submission_unknown', 'submitted',
               'awaiting_result', 'normalizing'
             )`,
        ).bind(now, prompt.id),
        env.CONTROL_DB.prepare(
          "DELETE FROM tracked_query_tags WHERE tracked_query_id = ?",
        ).bind(prompt.id),
      );
      if (!prompt.deleted_at) {
        activeByShard.set(
          prompt.shard_id,
          (activeByShard.get(prompt.shard_id) ?? 0) + 1,
        );
      }
    }

    for (const [shardId, count] of activeByShard) {
      statements.push(
        env.CONTROL_DB.prepare(
          `UPDATE shard_registry
           SET assigned_queries = MAX(assigned_queries - ?, 0), updated_at = ?
           WHERE shard_id = ?`,
        ).bind(count, now, shardId),
      );
    }
    statements.push(
      env.CONTROL_DB.prepare(
        `DELETE FROM prompt_tags
         WHERE project_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM tracked_query_tags assignment
             WHERE assignment.tag_id = prompt_tags.id
           )`,
      ).bind(projectId),
    );
    await env.CONTROL_DB.batch(statements);

    const eventStatements = newPrompts.flatMap((prompt) => {
      const audit = prepareAudit(env.CONTROL_DB, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "query.purge_requested",
          resourceType: "tracked_query",
          resourceId: prompt.id,
          metadata: { projectId },
      });
      return [
        audit.statement,
        projectEventStatement(env.CONTROL_DB, {
          projectId,
          type: "prompt_set_changed",
          occurredAt: audit.createdAt,
          payload: { addedCount: 0, removedCount: 1 },
          dedupeKey: `audit:${audit.id}`,
          actorUserId: principal.userId,
        }),
      ];
    });
    for (let index = 0; index < eventStatements.length; index += 100) {
      await env.CONTROL_DB.batch(eventStatements.slice(index, index + 100));
    }
  }

  const purgeJobs = await env.CONTROL_DB.prepare(
    `SELECT id FROM prompt_purge_jobs
     WHERE tracked_query_id IN (${placeholders(queryIds)})
       AND status IN ('pending', 'failed')`,
  )
    .bind(...queryIds)
    .all<{ id: string }>();
  if (purgeJobs.results.length) {
    try {
      await env.PROMPT_PURGE_QUEUE.sendBatch(
        purgeJobs.results.map((row) => ({
          body: { purgeJobId: row.id } satisfies PromptPurgeQueueMessage,
          options: { delaySeconds: PURGE_GRACE_SECONDS },
        })),
      );
      await env.CONTROL_DB.batch(
        purgeJobs.results.map((row) =>
          env.CONTROL_DB.prepare(
            "UPDATE prompt_purge_jobs SET status = 'queued', updated_at = ? WHERE id = ?",
          ).bind(nowIso(), row.id),
        ),
      );
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        message: "prompt_purge_enqueue_failed",
        purgeJobIds: purgeJobs.results.map((row) => row.id),
        error: String(error),
      }));
    }
  }

  return { acceptedCount: queryIds.length, queryIds, status: "queued" };
}

async function loadPurgeManifest(
  env: Env,
  job: PurgeJobRow,
): Promise<{ dates: string[]; r2Keys: string[]; exportIds: string[] }> {
  const [snapshots, crawlJobs, ingestEvents, dates, exports] = await Promise.all([
    env.CONTROL_DB.prepare(
      `SELECT raw_r2_key, html_r2_key
       FROM snapshot_index WHERE tracked_query_id = ?`,
    )
      .bind(job.tracked_query_id)
      .all<{ raw_r2_key: string; html_r2_key: string | null }>(),
    env.CONTROL_DB.prepare(
      `SELECT raw_r2_key, html_r2_key
       FROM crawl_jobs WHERE tracked_query_id = ?`,
    )
      .bind(job.tracked_query_id)
      .all<{ raw_r2_key: string | null; html_r2_key: string | null }>(),
    env.CONTROL_DB.prepare(
      `SELECT event.r2_key
       FROM ingest_events event
       JOIN crawl_jobs job ON job.id = event.crawl_job_id
       WHERE job.tracked_query_id = ? AND event.r2_key IS NOT NULL`,
    )
      .bind(job.tracked_query_id)
      .all<{ r2_key: string }>(),
    env.CONTROL_DB.prepare(
      `SELECT DISTINCT metric_date
       FROM metric_contributions WHERE tracked_query_id = ? ORDER BY metric_date`,
    )
      .bind(job.tracked_query_id)
      .all<{ metric_date: string }>(),
    env.CONTROL_DB.prepare(
      `SELECT id, r2_key FROM exports
       WHERE workspace_id = ?
         AND (project_id = ? OR project_id IS NULL)
         AND status IN ('queued', 'processing', 'completed')`,
    )
      .bind(job.workspace_id, job.project_id)
      .all<ExportArtifactRow>(),
  ]);

  return {
    dates: uniqueStrings([
      ...jsonParse<string[]>(job.affected_dates_json, []),
      ...dates.results.map((row) => row.metric_date),
    ]),
    r2Keys: uniqueStrings([
      ...jsonParse<string[]>(job.r2_keys_json, []),
      ...snapshots.results.flatMap((row) => [row.raw_r2_key, row.html_r2_key]),
      ...crawlJobs.results.flatMap((row) => [row.raw_r2_key, row.html_r2_key]),
      ...ingestEvents.results.map((row) => row.r2_key),
      ...exports.results.map((row) => row.r2_key),
    ]),
    exportIds: exports.results.map((row) => row.id),
  };
}

function rebuildMetricStatements(
  env: Env,
  projectId: string,
  dates: string[],
  now: string,
): D1PreparedStatement[] {
  if (!dates.length) return [];
  const datesJson = JSON.stringify(dates);
  return [
    env.CONTROL_DB.prepare(
      `DELETE FROM daily_source_project_metrics
       WHERE project_id = ? AND metric_date IN (SELECT value FROM json_each(?))`,
    ).bind(projectId, datesJson),
    env.CONTROL_DB.prepare(
      `DELETE FROM daily_source_domain_metrics
       WHERE project_id = ? AND metric_date IN (SELECT value FROM json_each(?))`,
    ).bind(projectId, datesJson),
    env.CONTROL_DB.prepare(
      `DELETE FROM daily_source_brand_metrics
       WHERE project_id = ? AND metric_date IN (SELECT value FROM json_each(?))`,
    ).bind(projectId, datesJson),
    env.CONTROL_DB.prepare(
      `INSERT INTO daily_source_project_metrics (
        project_id, tracking_source, metric_date, completed_runs,
        surface_present_runs, cited_runs, brand_mentioned_runs,
        product_runs, total_citations, updated_at
      )
      SELECT project_id, tracking_source, metric_date, SUM(completed_runs),
        SUM(surface_present_runs), SUM(cited_runs), SUM(brand_mentioned_runs),
        SUM(product_runs), SUM(total_citations), ?
      FROM metric_contributions
      WHERE project_id = ? AND metric_date IN (SELECT value FROM json_each(?))
      GROUP BY project_id, tracking_source, metric_date`,
    ).bind(now, projectId, datesJson),
    env.CONTROL_DB.prepare(
      `INSERT INTO daily_source_domain_metrics (
        project_id, tracking_source, metric_date, domain,
        cited_snapshot_count, citation_count, retrieved_snapshot_count,
        retrieval_count, product_count, updated_at
      )
      SELECT contribution.project_id, contribution.tracking_source,
        contribution.metric_date, domain.key,
        SUM(CAST(json_extract(domain.value, '$.citedSnapshotCount') AS INTEGER)),
        SUM(CAST(json_extract(domain.value, '$.citationCount') AS INTEGER)),
        SUM(CAST(json_extract(domain.value, '$.retrievedSnapshotCount') AS INTEGER)),
        SUM(CAST(json_extract(domain.value, '$.retrievalCount') AS INTEGER)),
        SUM(CAST(json_extract(domain.value, '$.productCount') AS INTEGER)), ?
      FROM metric_contributions contribution, json_each(contribution.domains_json) domain
      WHERE contribution.project_id = ?
        AND contribution.metric_date IN (SELECT value FROM json_each(?))
      GROUP BY contribution.project_id, contribution.tracking_source,
        contribution.metric_date, domain.key`,
    ).bind(now, projectId, datesJson),
    env.CONTROL_DB.prepare(
      `INSERT INTO daily_source_brand_metrics (
        project_id, tracking_source, tracked_brand_id, metric_date,
        mentioned_snapshot_count, updated_at
      )
      SELECT contribution.project_id, contribution.tracking_source, brand.value,
        contribution.metric_date, COUNT(*), ?
      FROM metric_contributions contribution, json_each(contribution.brands_json) brand
      WHERE contribution.project_id = ?
        AND contribution.metric_date IN (SELECT value FROM json_each(?))
      GROUP BY contribution.project_id, contribution.tracking_source,
        brand.value, contribution.metric_date`,
    ).bind(now, projectId, datesJson),
    env.CONTROL_DB.prepare(
      `DELETE FROM analytics_daily_brand_metrics
       WHERE project_id = ?
         AND metric_date IN (SELECT value FROM json_each(?))
         AND brand_metrics_revision = (
           SELECT brand_metrics_revision FROM projects WHERE id = ?
         )`,
    ).bind(projectId, datesJson, projectId),
    env.CONTROL_DB.prepare(
      `DELETE FROM analytics_daily_owned_brand_metrics
       WHERE project_id = ?
         AND metric_date IN (SELECT value FROM json_each(?))
         AND brand_metrics_revision = (
           SELECT brand_metrics_revision FROM projects WHERE id = ?
         )`,
    ).bind(projectId, datesJson, projectId),
    env.CONTROL_DB.prepare(
      `INSERT INTO analytics_daily_brand_metrics (
        project_id, tracking_source, metric_date, brand_metrics_revision,
        tracked_brand_id, mentioned_response_count, position_sum,
        position_sample_count, updated_at
      )
      SELECT contribution.project_id, contribution.tracking_source,
        contribution.metric_date, contribution.brand_metrics_revision,
        CAST(json_extract(brand.value, '$.brandId') AS TEXT), COUNT(*),
        SUM(CAST(json_extract(brand.value, '$.position') AS REAL)), COUNT(*), ?
      FROM analytics_brand_snapshot_metrics contribution
      JOIN projects project ON project.id = contribution.project_id,
        json_each(contribution.brands_json) brand
      WHERE contribution.project_id = ?
        AND contribution.brand_metrics_revision = project.brand_metrics_revision
        AND contribution.metric_date IN (SELECT value FROM json_each(?))
      GROUP BY contribution.project_id, contribution.tracking_source,
        contribution.metric_date, contribution.brand_metrics_revision,
        CAST(json_extract(brand.value, '$.brandId') AS TEXT)`,
    ).bind(now, projectId, datesJson),
    env.CONTROL_DB.prepare(
      `INSERT INTO analytics_daily_owned_brand_metrics (
        project_id, tracking_source, metric_date, brand_metrics_revision,
        mentioned_response_count, position_sum, position_sample_count, updated_at
      )
      SELECT contribution.project_id, contribution.tracking_source,
        contribution.metric_date, contribution.brand_metrics_revision,
        COUNT(*), SUM(contribution.owned_position), COUNT(*), ?
      FROM analytics_brand_snapshot_metrics contribution
      JOIN projects project ON project.id = contribution.project_id
      WHERE contribution.project_id = ?
        AND contribution.brand_metrics_revision = project.brand_metrics_revision
        AND contribution.owned_mentioned = 1
        AND contribution.metric_date IN (SELECT value FROM json_each(?))
      GROUP BY contribution.project_id, contribution.tracking_source,
        contribution.metric_date, contribution.brand_metrics_revision`,
    ).bind(now, projectId, datesJson),
    env.CONTROL_DB.prepare(
      `DELETE FROM daily_project_metrics
       WHERE project_id = ? AND metric_date IN (SELECT value FROM json_each(?))`,
    ).bind(projectId, datesJson),
    env.CONTROL_DB.prepare(
      `DELETE FROM daily_domain_metrics
       WHERE project_id = ? AND metric_date IN (SELECT value FROM json_each(?))`,
    ).bind(projectId, datesJson),
    env.CONTROL_DB.prepare(
      `DELETE FROM daily_brand_metrics
       WHERE project_id = ? AND metric_date IN (SELECT value FROM json_each(?))`,
    ).bind(projectId, datesJson),
    env.CONTROL_DB.prepare(
      `INSERT INTO daily_project_metrics (
        project_id, metric_date, completed_runs, cited_runs, brand_mentioned_runs,
        product_runs, total_citations, updated_at
      )
      SELECT project_id, metric_date, SUM(completed_runs), SUM(cited_runs),
        SUM(brand_mentioned_runs), SUM(product_runs), SUM(total_citations), ?
      FROM metric_contributions
      WHERE project_id = ? AND tracking_source = 'chatgpt'
        AND metric_date IN (SELECT value FROM json_each(?))
      GROUP BY project_id, metric_date`,
    ).bind(now, projectId, datesJson),
    env.CONTROL_DB.prepare(
      `INSERT INTO daily_domain_metrics (
        project_id, metric_date, domain, cited_snapshot_count, citation_count,
        retrieved_snapshot_count, retrieval_count, product_count, updated_at
      )
      SELECT contribution.project_id, contribution.metric_date, domain.key,
        SUM(CAST(json_extract(domain.value, '$.citedSnapshotCount') AS INTEGER)),
        SUM(CAST(json_extract(domain.value, '$.citationCount') AS INTEGER)),
        SUM(CAST(json_extract(domain.value, '$.retrievedSnapshotCount') AS INTEGER)),
        SUM(CAST(json_extract(domain.value, '$.retrievalCount') AS INTEGER)),
        SUM(CAST(json_extract(domain.value, '$.productCount') AS INTEGER)), ?
      FROM metric_contributions contribution, json_each(contribution.domains_json) domain
      WHERE contribution.project_id = ?
        AND contribution.tracking_source = 'chatgpt'
        AND contribution.metric_date IN (SELECT value FROM json_each(?))
      GROUP BY contribution.project_id, contribution.metric_date, domain.key`,
    ).bind(now, projectId, datesJson),
    env.CONTROL_DB.prepare(
      `INSERT INTO daily_brand_metrics (
        project_id, tracked_brand_id, metric_date, mentioned_snapshot_count, updated_at
      )
      SELECT contribution.project_id, brand.value, contribution.metric_date, COUNT(*), ?
      FROM metric_contributions contribution, json_each(contribution.brands_json) brand
      WHERE contribution.project_id = ?
        AND contribution.tracking_source = 'chatgpt'
        AND contribution.metric_date IN (SELECT value FROM json_each(?))
      GROUP BY contribution.project_id, brand.value, contribution.metric_date`,
    ).bind(now, projectId, datesJson),
  ];
}

export async function processPromptPurge(env: Env, purgeJobId: string): Promise<void> {
  const job = await env.CONTROL_DB.prepare(
    "SELECT * FROM prompt_purge_jobs WHERE id = ?",
  )
    .bind(purgeJobId)
    .first<PurgeJobRow>();
  if (!job || job.status === "completed") return;
  if (Date.parse(job.not_before) > Date.now()) {
    throw new Error("Prompt purge grace period has not elapsed.");
  }

  const startedAt = nowIso();
  await env.CONTROL_DB.prepare(
    `UPDATE prompt_purge_jobs SET
      status = 'processing', attempts = attempts + 1,
      error_message = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(startedAt, job.id)
    .run();
  console.log(JSON.stringify({
    level: "info",
    message: "prompt_purge_started",
    purgeJobId: job.id,
    trackedQueryId: job.tracked_query_id,
  }));

  const manifest = await loadPurgeManifest(env, job);
  await env.CONTROL_DB.prepare(
    `UPDATE prompt_purge_jobs SET
      r2_keys_json = ?, affected_dates_json = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      JSON.stringify(manifest.r2Keys),
      JSON.stringify(manifest.dates),
      nowIso(),
      job.id,
    )
    .run();

  if (manifest.exportIds.length) {
    await env.CONTROL_DB.prepare(
      `UPDATE exports SET status = 'expired', expires_at = ?, updated_at = ?
       WHERE id IN (${placeholders(manifest.exportIds)})`,
    )
      .bind(nowIso(), nowIso(), ...manifest.exportIds)
      .run();
  }

  const shard = getShard(env, job.shard_id);
  await shard
    .prepare("DELETE FROM snapshots WHERE tracked_query_id = ?")
    .bind(job.tracked_query_id)
    .run();
  await deleteR2Keys(env.EVIDENCE_BUCKET, manifest.r2Keys);

  const now = nowIso();
  const controlStatements: D1PreparedStatement[] = [
    env.CONTROL_DB.prepare(
      `INSERT INTO deleted_entity_extraction_usage_daily (
        workspace_id, project_id, usage_date, charged_tasks, input_tokens,
        output_tokens, estimated_cost_usd, updated_at
      )
      SELECT job.workspace_id, job.project_id, substr(chunk.completed_at, 1, 10),
        COUNT(*), COALESCE(SUM(chunk.input_tokens), 0),
        COALESCE(SUM(chunk.output_tokens), 0),
        COALESCE(SUM(chunk.estimated_cost_usd), 0), ?
      FROM entity_extraction_chunks chunk
      JOIN entity_extraction_jobs job ON job.id = chunk.job_id
      WHERE job.tracked_query_id = ? AND job.run_type = 'live'
        AND chunk.status = 'completed'
      GROUP BY job.workspace_id, job.project_id, substr(chunk.completed_at, 1, 10)
      ON CONFLICT(project_id, usage_date) DO UPDATE SET
        charged_tasks = charged_tasks + excluded.charged_tasks,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd,
        updated_at = excluded.updated_at`,
    ).bind(now, job.tracked_query_id),
    env.CONTROL_DB.prepare(
      "DELETE FROM entity_mentions WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare(
      "DELETE FROM entity_extraction_jobs WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare(
      `DELETE FROM project_entities
       WHERE project_id = ? AND tracked_brand_id IS NULL AND status = 'candidate'
         AND NOT EXISTS (
           SELECT 1 FROM entity_mentions mention
           WHERE mention.entity_id = project_entities.id
             AND mention.extractor_version = (
               SELECT active_entity_extractor_version FROM projects
               WHERE id = project_entities.project_id
             )
         )`,
    ).bind(job.project_id),
    env.CONTROL_DB.prepare(
      `UPDATE project_entities SET
        snapshot_count = (
          SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id
            AND mention.extractor_version = (
              SELECT active_entity_extractor_version FROM projects
              WHERE id = project_entities.project_id
            )
        ),
        prompt_count = (
          SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id
            AND mention.extractor_version = (
              SELECT active_entity_extractor_version FROM projects
              WHERE id = project_entities.project_id
            )
        ),
        competitor_snapshot_count = (
          SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id AND mention.relationship = 'competitor'
            AND mention.extractor_version = (
              SELECT active_entity_extractor_version FROM projects
              WHERE id = project_entities.project_id
            )
        ),
        competitor_prompt_count = (
          SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
          WHERE mention.entity_id = project_entities.id AND mention.relationship = 'competitor'
            AND mention.extractor_version = (
              SELECT active_entity_extractor_version FROM projects
              WHERE id = project_entities.project_id
            )
        ),
        updated_at = ? WHERE project_id = ?`,
    ).bind(now, job.project_id),
    env.CONTROL_DB.prepare(
      `INSERT INTO deleted_prompt_usage_daily (
        workspace_id, project_id, usage_date, requested_runs, charged_runs,
        provider_cost_usd, updated_at
      )
      SELECT workspace_id, project_id, substr(created_at, 1, 10), COUNT(*), 0, 0, ?
      FROM crawl_jobs
      WHERE tracked_query_id = ?
      GROUP BY workspace_id, project_id, substr(created_at, 1, 10)
      HAVING COUNT(*) > 0
      ON CONFLICT(project_id, usage_date) DO UPDATE SET
        requested_runs = requested_runs + excluded.requested_runs,
        updated_at = excluded.updated_at`,
    ).bind(now, job.tracked_query_id),
    env.CONTROL_DB.prepare(
      `INSERT INTO deleted_prompt_usage_daily (
        workspace_id, project_id, usage_date, requested_runs, charged_runs,
        provider_cost_usd, updated_at
      )
      SELECT workspace_id, project_id,
        substr(COALESCE(submitted_at, created_at), 1, 10), 0, COUNT(*),
        COALESCE(SUM(request_cost_usd), 0), ?
      FROM crawl_jobs
      WHERE tracked_query_id = ?
        AND request_cost_usd IS NOT NULL AND request_cost_usd > 0
      GROUP BY workspace_id, project_id,
        substr(COALESCE(submitted_at, created_at), 1, 10)
      HAVING COUNT(*) > 0
      ON CONFLICT(project_id, usage_date) DO UPDATE SET
        charged_runs = charged_runs + excluded.charged_runs,
        provider_cost_usd = provider_cost_usd + excluded.provider_cost_usd,
        updated_at = excluded.updated_at`,
    ).bind(now, job.tracked_query_id),
    env.CONTROL_DB.prepare(
      `DELETE FROM ingest_events WHERE crawl_job_id IN (
        SELECT id FROM crawl_jobs WHERE tracked_query_id = ?
      )`,
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare(
      `DELETE FROM webhook_deliveries WHERE alert_id IN (
        SELECT id FROM alerts WHERE tracked_query_id = ?
      )`,
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare("DELETE FROM alerts WHERE tracked_query_id = ?").bind(
      job.tracked_query_id,
    ),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_citation_occurrences WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_product_occurrences WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_related_query_occurrences WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_retrieval_occurrences WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare(
      "DELETE FROM analytics_snapshot_facts WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare(
      "DELETE FROM metric_contributions WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare(
      "DELETE FROM snapshot_index WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare("DELETE FROM crawl_jobs WHERE tracked_query_id = ?").bind(
      job.tracked_query_id,
    ),
    env.CONTROL_DB.prepare(
      "DELETE FROM tracked_query_tags WHERE tracked_query_id = ?",
    ).bind(job.tracked_query_id),
    env.CONTROL_DB.prepare("DELETE FROM tracked_queries WHERE id = ?").bind(
      job.tracked_query_id,
    ),
    ...rebuildMetricStatements(env, job.project_id, manifest.dates, now),
    env.CONTROL_DB.prepare(
      `DELETE FROM prompt_tags
       WHERE project_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM tracked_query_tags assignment
           WHERE assignment.tag_id = prompt_tags.id
         )`,
    ).bind(job.project_id),
    env.CONTROL_DB.prepare(
      `UPDATE shard_registry SET
        completed_snapshots = (
          SELECT COUNT(*) FROM snapshot_index WHERE shard_id = ?
        ), updated_at = ?
       WHERE shard_id = ?`,
    ).bind(job.shard_id, now, job.shard_id),
    env.CONTROL_DB.prepare(
      "UPDATE prompt_purge_jobs SET status = 'finalizing', updated_at = ? WHERE id = ?",
    ).bind(now, job.id),
  ];
  await env.CONTROL_DB.batch(controlStatements);

  await shard
    .prepare("DELETE FROM snapshots WHERE tracked_query_id = ?")
    .bind(job.tracked_query_id)
    .run();
  await deleteR2Keys(env.EVIDENCE_BUCKET, manifest.r2Keys);
  await env.CONTROL_DB.prepare(
    `UPDATE prompt_purge_jobs SET
      status = 'completed', r2_keys_json = '[]', affected_dates_json = '[]',
      completed_at = ?, error_message = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(nowIso(), nowIso(), job.id)
    .run();
  console.log(JSON.stringify({
    level: "info",
    message: "prompt_purge_completed",
    purgeJobId: job.id,
    trackedQueryId: job.tracked_query_id,
    r2ObjectsDeleted: manifest.r2Keys.length,
  }));
}

export async function promptPurgeBatch(
  env: Env,
  batch: MessageBatch<PromptPurgeQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processPromptPurge(env, message.body.purgeJobId);
      message.ack();
    } catch (error) {
      const errorMessage = String(error).slice(0, 1_000);
      await env.CONTROL_DB.prepare(
        `UPDATE prompt_purge_jobs SET
          status = 'failed', error_message = ?, updated_at = ?
         WHERE id = ? AND status != 'completed'`,
      )
        .bind(errorMessage, nowIso(), message.body.purgeJobId)
        .run();
      console.error(JSON.stringify({
        level: "error",
        message: "prompt_purge_failed",
        purgeJobId: message.body.purgeJobId,
        error: errorMessage,
      }));
      message.retry({ delaySeconds: Math.min(3_600, 60 * 2 ** message.attempts) });
    }
  }
}

export async function reconcilePromptPurges(env: Env): Promise<number> {
  const jobs = await env.CONTROL_DB.prepare(
    `SELECT id FROM prompt_purge_jobs
     WHERE not_before <= ? AND (
       status IN ('pending', 'failed')
       OR (status IN ('queued', 'processing', 'finalizing')
         AND julianday(updated_at) < julianday('now', '-15 minutes'))
     )
     ORDER BY updated_at LIMIT 100`,
  )
    .bind(nowIso())
    .all<{ id: string }>();
  if (!jobs.results.length) return 0;
  await env.PROMPT_PURGE_QUEUE.sendBatch(
    jobs.results.map((row) => ({
      body: { purgeJobId: row.id } satisfies PromptPurgeQueueMessage,
    })),
  );
  await env.CONTROL_DB.batch(
    jobs.results.map((row) =>
      env.CONTROL_DB.prepare(
        "UPDATE prompt_purge_jobs SET status = 'queued', updated_at = ? WHERE id = ?",
      ).bind(nowIso(), row.id),
    ),
  );
  return jobs.results.length;
}
