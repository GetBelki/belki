import type { NotificationQueueMessage } from "../../shared/contracts";
import type { TrackingSource } from "../../shared/tracking-sources";
import { jsonParse, nowIso } from "../lib/http";
import { getShard } from "../lib/shards";
import { promptPurgeRequested } from "../lib/prompt-purges";

interface RuleRow {
  id: string;
  event_type: string;
  threshold: number | null;
  tracked_brand_id: string | null;
  tracking_source: TrackingSource;
  channels_json: string;
}

async function emitAlert(
  env: Env,
  input: {
    rule: RuleRow;
    projectId: string;
    queryId: string;
    snapshotId: string | null;
    dedupeResourceId?: string;
    title: string;
    message: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const alertId = crypto.randomUUID();
  const insert = await env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO alerts (
      id, alert_rule_id, project_id, tracked_query_id, snapshot_id,
      event_type, title, message, payload_json, dedupe_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      alertId,
      input.rule.id,
      input.projectId,
      input.queryId,
      input.snapshotId,
      input.rule.event_type,
      input.title,
      input.message,
      JSON.stringify(input.payload),
      `${input.rule.id}:${input.snapshotId ?? input.dedupeResourceId ?? input.queryId}`,
      nowIso(),
    )
    .run();
  if (insert.meta.changes === 0) return;
  const channels = jsonParse<string[]>(input.rule.channels_json, ["in_app"]);
  if (!channels.includes("webhook")) return;
  const destinations = await env.CONTROL_DB.prepare(
    `SELECT w.id
     FROM webhook_destinations w
     JOIN projects p ON p.workspace_id = w.workspace_id
     WHERE p.id = ? AND w.is_enabled = 1`,
  )
    .bind(input.projectId)
    .all<{ id: string }>();
  for (const destination of destinations.results) {
    const deliveryId = crypto.randomUUID();
    await env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO webhook_deliveries (
        id, destination_id, alert_id, status, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
    )
      .bind(deliveryId, destination.id, alertId, nowIso(), nowIso())
      .run();
    await env.NOTIFICATION_QUEUE.send({
      deliveryId,
    } satisfies NotificationQueueMessage);
  }
}

export async function evaluateSnapshotAlerts(
  env: Env,
  snapshotId: string,
  shardId: number,
): Promise<void> {
  const current = await env.CONTROL_DB.prepare(
    `SELECT
      id, project_id, tracked_query_id, tracking_source, captured_at, has_product_block
     FROM snapshot_index WHERE id = ?`,
  )
    .bind(snapshotId)
    .first<{
      id: string;
      project_id: string;
      tracked_query_id: string;
      tracking_source: TrackingSource;
      captured_at: string;
      has_product_block: number;
    }>();
  if (!current) return;
  if (await promptPurgeRequested(env.CONTROL_DB, current.tracked_query_id)) return;
  const rules = await env.CONTROL_DB.prepare(
    `SELECT id, event_type, threshold, tracked_brand_id, tracking_source, channels_json
     FROM alert_rules
     WHERE project_id = ? AND tracking_source = ? AND is_enabled = 1`,
  )
    .bind(current.project_id, current.tracking_source)
    .all<RuleRow>();
  if (!rules.results.length) return;
  const previous = await env.CONTROL_DB.prepare(
    `SELECT id, has_product_block
     FROM snapshot_index
     WHERE tracked_query_id = ? AND tracking_source = ? AND captured_at < ?
     ORDER BY captured_at DESC LIMIT 1`,
  )
    .bind(current.tracked_query_id, current.tracking_source, current.captured_at)
    .first<{ id: string; has_product_block: number }>();
  if (!previous) return;
  const shard = getShard(env, shardId);
  const [currentDomains, previousDomains, currentBrands, previousBrands, trackedBrands] =
    await Promise.all([
      shard
        .prepare(
          "SELECT registrable_domain FROM snapshot_domains WHERE snapshot_id = ? AND cited_count > 0",
        )
        .bind(current.id)
        .all<{ registrable_domain: string }>(),
      shard
        .prepare(
          "SELECT registrable_domain FROM snapshot_domains WHERE snapshot_id = ? AND cited_count > 0",
        )
        .bind(previous.id)
        .all<{ registrable_domain: string }>(),
      shard
        .prepare(
          "SELECT DISTINCT matched_tracked_brand_id FROM snapshot_brand_entities WHERE snapshot_id = ? AND matched_tracked_brand_id IS NOT NULL",
        )
        .bind(current.id)
        .all<{ matched_tracked_brand_id: string }>(),
      shard
        .prepare(
          "SELECT DISTINCT matched_tracked_brand_id FROM snapshot_brand_entities WHERE snapshot_id = ? AND matched_tracked_brand_id IS NOT NULL",
        )
        .bind(previous.id)
        .all<{ matched_tracked_brand_id: string }>(),
      env.CONTROL_DB.prepare(
        "SELECT id, kind, name, domains_json FROM tracked_brands WHERE project_id = ?",
      )
        .bind(current.project_id)
        .all<{
          id: string;
          kind: "owned" | "competitor";
          name: string;
          domains_json: string;
        }>(),
    ]);

  const currentDomainSet = new Set(
    currentDomains.results.map((row) => row.registrable_domain),
  );
  const previousDomainSet = new Set(
    previousDomains.results.map((row) => row.registrable_domain),
  );
  const currentBrandSet = new Set(
    currentBrands.results.map((row) => row.matched_tracked_brand_id),
  );
  const previousBrandSet = new Set(
    previousBrands.results.map((row) => row.matched_tracked_brand_id),
  );
  const ownedDomains = new Set(
    trackedBrands.results
      .filter((brand) => brand.kind === "owned")
      .flatMap((brand) => jsonParse<string[]>(brand.domains_json, [])),
  );
  const ownedCitedBefore = [...ownedDomains].some((domain) => previousDomainSet.has(domain));
  const ownedCitedNow = [...ownedDomains].some((domain) => currentDomainSet.has(domain));

  for (const rule of rules.results) {
    if (rule.event_type === "own_citation_lost" && ownedCitedBefore && !ownedCitedNow) {
      await emitAlert(env, {
        rule,
        projectId: current.project_id,
        queryId: current.tracked_query_id,
        snapshotId: current.id,
        title: "Owned citation lost",
        message: "The latest result no longer cites an owned domain.",
        payload: { previousSnapshotId: previous.id, ownedDomains: [...ownedDomains] },
      });
    }
    if (rule.event_type === "product_block_changed" &&
      current.has_product_block !== previous.has_product_block) {
      await emitAlert(env, {
        rule,
        projectId: current.project_id,
        queryId: current.tracked_query_id,
        snapshotId: current.id,
        title: "Product block changed",
        message: current.has_product_block
          ? "A product block appeared in the latest result."
          : "The product block disappeared from the latest result.",
        payload: { previousSnapshotId: previous.id },
      });
    }
    if (rule.event_type === "brand_mention_lost") {
      const candidateIds = rule.tracked_brand_id
        ? [rule.tracked_brand_id]
        : trackedBrands.results.filter((brand) => brand.kind === "owned").map((brand) => brand.id);
      const lost = candidateIds.find(
        (brandId) => previousBrandSet.has(brandId) && !currentBrandSet.has(brandId),
      );
      if (lost) {
        const brand = trackedBrands.results.find((item) => item.id === lost);
        await emitAlert(env, {
          rule,
          projectId: current.project_id,
          queryId: current.tracked_query_id,
          snapshotId: current.id,
          title: "Brand mention lost",
          message: `${brand?.name ?? "A tracked brand"} is no longer mentioned.`,
          payload: { previousSnapshotId: previous.id, trackedBrandId: lost },
        });
      }
    }
    if (rule.event_type === "competitor_citation_gained") {
      const candidateIds = rule.tracked_brand_id
        ? [rule.tracked_brand_id]
        : trackedBrands.results
            .filter((brand) => brand.kind === "competitor")
            .map((brand) => brand.id);
      const gained = candidateIds.find(
        (brandId) => currentBrandSet.has(brandId) && !previousBrandSet.has(brandId),
      );
      if (gained) {
        const brand = trackedBrands.results.find((item) => item.id === gained);
        await emitAlert(env, {
          rule,
          projectId: current.project_id,
          queryId: current.tracked_query_id,
          snapshotId: current.id,
          title: "Competitor gained visibility",
          message: `${brand?.name ?? "A competitor"} appeared in the latest result.`,
          payload: { previousSnapshotId: previous.id, trackedBrandId: gained },
        });
      }
    }
    if (rule.event_type === "visibility_drop") {
      const aggregate = await env.CONTROL_DB.prepare(
        `SELECT
          SUM(CASE WHEN metric_date >= date('now', '-6 days') THEN cited_runs ELSE 0 END) AS current_cited,
          SUM(CASE WHEN metric_date >= date('now', '-6 days') THEN completed_runs ELSE 0 END) AS current_runs,
          SUM(CASE WHEN metric_date BETWEEN date('now', '-13 days') AND date('now', '-7 days') THEN cited_runs ELSE 0 END) AS previous_cited,
          SUM(CASE WHEN metric_date BETWEEN date('now', '-13 days') AND date('now', '-7 days') THEN completed_runs ELSE 0 END) AS previous_runs
        FROM daily_source_project_metrics
        WHERE project_id = ? AND tracking_source = ?`,
      )
        .bind(current.project_id, current.tracking_source)
        .first<{
          current_cited: number;
          current_runs: number;
          previous_cited: number;
          previous_runs: number;
        }>();
      const currentRate = aggregate?.current_runs
        ? (aggregate.current_cited / aggregate.current_runs) * 100
        : 0;
      const previousRate = aggregate?.previous_runs
        ? (aggregate.previous_cited / aggregate.previous_runs) * 100
        : 0;
      const threshold = rule.threshold ?? 10;
      if ((aggregate?.current_runs ?? 0) >= 5 && previousRate - currentRate >= threshold) {
        await emitAlert(env, {
          rule,
          projectId: current.project_id,
          queryId: current.tracked_query_id,
          snapshotId: current.id,
          title: "Visibility dropped",
          message: `Citation rate dropped ${Math.round(previousRate - currentRate)} percentage points.`,
          payload: { currentRate, previousRate, threshold },
        });
      }
    }
  }
}

export async function emitRunFailureAlerts(
  env: Env,
  jobId: string,
  errorMessage: string,
): Promise<void> {
  const job = await env.CONTROL_DB.prepare(
    `SELECT job.project_id, job.tracked_query_id, job.tracking_source
     FROM crawl_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     WHERE job.id = ? AND query.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM prompt_purge_jobs purge
         WHERE purge.tracked_query_id = query.id
       )`,
  )
    .bind(jobId)
    .first<{
      project_id: string;
      tracked_query_id: string;
      tracking_source: TrackingSource;
    }>();
  if (!job) return;
  const rules = await env.CONTROL_DB.prepare(
    `SELECT id, event_type, threshold, tracked_brand_id, tracking_source, channels_json
     FROM alert_rules
     WHERE project_id = ? AND tracking_source = ?
       AND event_type = 'run_failed' AND is_enabled = 1`,
  )
    .bind(job.project_id, job.tracking_source)
    .all<RuleRow>();
  for (const rule of rules.results) {
    await emitAlert(env, {
      rule,
      projectId: job.project_id,
      queryId: job.tracked_query_id,
      snapshotId: null,
      dedupeResourceId: jobId,
      title: "Tracking update failed",
      message: errorMessage,
      payload: { jobId },
    });
  }
}
