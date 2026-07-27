import type { RollupQueueMessage } from "../../shared/contracts";
import { nowIso } from "../lib/http";
import { getShard } from "../lib/shards";
import { evaluateSnapshotAlerts } from "../automation/alerts";

interface DomainMetric {
  citedSnapshotCount: number;
  citationCount: number;
  retrievedSnapshotCount: number;
  retrievalCount: number;
  productCount: number;
}

interface MetricPayload {
  snapshotId: string;
  projectId: string;
  trackedQueryId: string;
  metricDate: string;
  completedRuns: number;
  citedRuns: number;
  brandMentionedRuns: number;
  productRuns: number;
  totalCitations: number;
  domains: Record<string, DomainMetric>;
  brands: string[];
}

export async function applyRollup(
  env: Env,
  message: RollupQueueMessage,
): Promise<void> {
  const shard = getShard(env, message.shardId);
  const outbox = await shard
    .prepare(
      "SELECT payload_json, delivered_at FROM metric_outbox WHERE snapshot_id = ?",
    )
    .bind(message.snapshotId)
    .first<{ payload_json: string; delivered_at: string | null }>();
  if (!outbox || outbox.delivered_at) return;
  const payload = JSON.parse(outbox.payload_json) as MetricPayload;

  const insert = await env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO metric_contributions (
      snapshot_id, project_id, tracked_query_id, metric_date, completed_runs,
      cited_runs, brand_mentioned_runs, product_runs, total_citations,
      domains_json, brands_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      payload.snapshotId,
      payload.projectId,
      payload.trackedQueryId,
      payload.metricDate,
      payload.completedRuns,
      payload.citedRuns,
      payload.brandMentionedRuns,
      payload.productRuns,
      payload.totalCitations,
      JSON.stringify(payload.domains),
      JSON.stringify(payload.brands),
      nowIso(),
    )
    .run();

  if (insert.meta.changes > 0) {
    const statements: D1PreparedStatement[] = [
      env.CONTROL_DB.prepare(
        `INSERT INTO daily_project_metrics (
          project_id, metric_date, completed_runs, cited_runs,
          brand_mentioned_runs, product_runs, total_citations, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, metric_date) DO UPDATE SET
          completed_runs = completed_runs + excluded.completed_runs,
          cited_runs = cited_runs + excluded.cited_runs,
          brand_mentioned_runs = brand_mentioned_runs + excluded.brand_mentioned_runs,
          product_runs = product_runs + excluded.product_runs,
          total_citations = total_citations + excluded.total_citations,
          updated_at = excluded.updated_at`,
      ).bind(
        payload.projectId,
        payload.metricDate,
        payload.completedRuns,
        payload.citedRuns,
        payload.brandMentionedRuns,
        payload.productRuns,
        payload.totalCitations,
        nowIso(),
      ),
    ];
    for (const [domain, metrics] of Object.entries(payload.domains)) {
      statements.push(
        env.CONTROL_DB.prepare(
          `INSERT INTO daily_domain_metrics (
            project_id, metric_date, domain, cited_snapshot_count, citation_count,
            retrieved_snapshot_count, retrieval_count, product_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, metric_date, domain) DO UPDATE SET
            cited_snapshot_count = cited_snapshot_count + excluded.cited_snapshot_count,
            citation_count = citation_count + excluded.citation_count,
            retrieved_snapshot_count = retrieved_snapshot_count + excluded.retrieved_snapshot_count,
            retrieval_count = retrieval_count + excluded.retrieval_count,
            product_count = product_count + excluded.product_count,
            updated_at = excluded.updated_at`,
        ).bind(
          payload.projectId,
          payload.metricDate,
          domain,
          metrics.citedSnapshotCount,
          metrics.citationCount,
          metrics.retrievedSnapshotCount,
          metrics.retrievalCount,
          metrics.productCount,
          nowIso(),
        ),
      );
    }
    for (const brandId of payload.brands) {
      statements.push(
        env.CONTROL_DB.prepare(
          `INSERT INTO daily_brand_metrics (
            project_id, tracked_brand_id, metric_date, mentioned_snapshot_count, updated_at
          ) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(project_id, tracked_brand_id, metric_date) DO UPDATE SET
            mentioned_snapshot_count = mentioned_snapshot_count + 1,
            updated_at = excluded.updated_at`,
        ).bind(payload.projectId, brandId, payload.metricDate, nowIso()),
      );
    }
    await env.CONTROL_DB.batch(statements);
  }

  await shard
    .prepare(
      "UPDATE metric_outbox SET delivered_at = ?, attempts = attempts + 1 WHERE snapshot_id = ?",
    )
    .bind(nowIso(), message.snapshotId)
    .run();
  await evaluateSnapshotAlerts(env, message.snapshotId, message.shardId);
}

export async function rollupBatch(
  env: Env,
  batch: MessageBatch<RollupQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await applyRollup(env, message.body);
      message.ack();
    } catch {
      message.retry({ delaySeconds: Math.min(300, 30 * 2 ** message.attempts) });
    }
  }
}
