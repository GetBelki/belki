import type { TrackingSource } from "../../shared/contracts";
import { rankBrandFirstMentions, type BrandPositionInput } from "../lib/brand-position";
import { jsonParse, nowIso } from "../lib/http";

interface StoredBrandMetric {
  brandId: string;
  kind: "owned" | "competitor";
  position: number;
}

interface StoredContribution {
  brands_json: string;
  owned_mentioned: number;
  owned_position: number | null;
}

interface BrandMetricDelta {
  brandId: string;
  mentioned: number;
  positionSum: number;
  positionSamples: number;
}

function storedMetrics(value: string): StoredBrandMetric[] {
  const parsed = jsonParse<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.brandId !== "string" ||
      (row.kind !== "owned" && row.kind !== "competitor") ||
      typeof row.position !== "number" ||
      !Number.isInteger(row.position) ||
      row.position < 1
    ) {
      return [];
    }
    return [{
      brandId: row.brandId,
      kind: row.kind,
      position: row.position,
    } satisfies StoredBrandMetric];
  });
}

function metricDeltas(
  previous: StoredBrandMetric[],
  next: StoredBrandMetric[],
): BrandMetricDelta[] {
  const previousById = new Map(previous.map((metric) => [metric.brandId, metric]));
  const nextById = new Map(next.map((metric) => [metric.brandId, metric]));
  return [...new Set([...previousById.keys(), ...nextById.keys()])].flatMap(
    (brandId) => {
      const oldMetric = previousById.get(brandId);
      const newMetric = nextById.get(brandId);
      const delta = {
        brandId,
        mentioned: Number(Boolean(newMetric)) - Number(Boolean(oldMetric)),
        positionSum: (newMetric?.position ?? 0) - (oldMetric?.position ?? 0),
        positionSamples:
          Number(Boolean(newMetric)) - Number(Boolean(oldMetric)),
      };
      return delta.mentioned || delta.positionSum || delta.positionSamples
        ? [delta]
        : [];
    },
  );
}

export async function syncSnapshotBrandMetrics(
  db: D1Database,
  input: {
    snapshotId: string;
    projectId: string;
    trackingSource: TrackingSource;
    metricDate: string;
    answer: string;
    revision: number;
    brands: BrandPositionInput[];
  },
): Promise<void> {
  const previous = await db.prepare(
    `SELECT brands_json, owned_mentioned, owned_position
     FROM analytics_brand_snapshot_metrics
     WHERE snapshot_id = ? AND brand_metrics_revision = ?`,
  ).bind(input.snapshotId, input.revision).first<StoredContribution>();
  const currentBrandIds = new Set(input.brands.map((brand) => brand.id));
  // Deleted brands already cascade out of the daily aggregate table. Ignore
  // their embedded snapshot contribution so a later idempotent refresh does
  // not try to write a negative delta for a missing foreign key.
  const previousMetrics = storedMetrics(previous?.brands_json ?? "[]")
    .filter((metric) => currentBrandIds.has(metric.brandId));
  const nextMetrics = rankBrandFirstMentions(input.answer, input.brands);
  const deltas = metricDeltas(previousMetrics, nextMetrics);
  const previousOwnedPosition = previous?.owned_position ?? null;
  const nextOwnedPosition = Math.min(
    ...nextMetrics
      .filter((metric) => metric.kind === "owned")
      .map((metric) => metric.position),
    Number.POSITIVE_INFINITY,
  );
  const normalizedNextOwnedPosition = Number.isFinite(nextOwnedPosition)
    ? nextOwnedPosition
    : null;
  const previousOwnedMentioned = previous?.owned_mentioned ?? 0;
  const nextOwnedMentioned = normalizedNextOwnedPosition === null ? 0 : 1;
  const ownedMentionedDelta = nextOwnedMentioned - previousOwnedMentioned;
  const ownedPositionDelta =
    (normalizedNextOwnedPosition ?? 0) - (previousOwnedPosition ?? 0);
  const ownedSampleDelta =
    Number(normalizedNextOwnedPosition !== null) -
    Number(previousOwnedPosition !== null);
  const updatedAt = nowIso();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO analytics_brand_snapshot_metrics (
        snapshot_id, brand_metrics_revision, project_id, tracking_source,
        metric_date, brands_json, owned_mentioned, owned_position, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id, brand_metrics_revision) DO UPDATE SET
        brands_json = excluded.brands_json,
        owned_mentioned = excluded.owned_mentioned,
        owned_position = excluded.owned_position,
        updated_at = excluded.updated_at`,
    ).bind(
      input.snapshotId,
      input.revision,
      input.projectId,
      input.trackingSource,
      input.metricDate,
      JSON.stringify(nextMetrics),
      nextOwnedMentioned,
      normalizedNextOwnedPosition,
      updatedAt,
    ),
  ];
  if (deltas.length) {
    statements.push(
      db.prepare(
        `INSERT INTO analytics_daily_brand_metrics (
          project_id, tracking_source, metric_date, brand_metrics_revision,
          tracked_brand_id, mentioned_response_count, position_sum,
          position_sample_count, updated_at
        )
        SELECT ?, ?, ?, ?,
          CAST(json_extract(value, '$.brandId') AS TEXT),
          CAST(json_extract(value, '$.mentioned') AS INTEGER),
          CAST(json_extract(value, '$.positionSum') AS REAL),
          CAST(json_extract(value, '$.positionSamples') AS INTEGER), ?
        FROM json_each(?)
        WHERE 1
        ON CONFLICT(
          project_id, tracking_source, metric_date,
          brand_metrics_revision, tracked_brand_id
        ) DO UPDATE SET
          mentioned_response_count = mentioned_response_count + excluded.mentioned_response_count,
          position_sum = position_sum + excluded.position_sum,
          position_sample_count = position_sample_count + excluded.position_sample_count,
          updated_at = excluded.updated_at`,
      ).bind(
        input.projectId,
        input.trackingSource,
        input.metricDate,
        input.revision,
        updatedAt,
        JSON.stringify(deltas),
      ),
    );
  }
  if (ownedMentionedDelta || ownedPositionDelta || ownedSampleDelta) {
    statements.push(
      db.prepare(
        `INSERT INTO analytics_daily_owned_brand_metrics (
          project_id, tracking_source, metric_date, brand_metrics_revision,
          mentioned_response_count, position_sum, position_sample_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          project_id, tracking_source, metric_date, brand_metrics_revision
        ) DO UPDATE SET
          mentioned_response_count = mentioned_response_count + excluded.mentioned_response_count,
          position_sum = position_sum + excluded.position_sum,
          position_sample_count = position_sample_count + excluded.position_sample_count,
          updated_at = excluded.updated_at`,
      ).bind(
        input.projectId,
        input.trackingSource,
        input.metricDate,
        input.revision,
        ownedMentionedDelta,
        ownedPositionDelta,
        ownedSampleDelta,
        updatedAt,
      ),
    );
  }
  statements.push(
    db.prepare(
      `DELETE FROM analytics_daily_brand_metrics
       WHERE project_id = ? AND tracking_source = ? AND metric_date = ?
         AND brand_metrics_revision = ?
         AND mentioned_response_count <= 0 AND position_sample_count <= 0`,
    ).bind(
      input.projectId,
      input.trackingSource,
      input.metricDate,
      input.revision,
    ),
    db.prepare(
      `DELETE FROM analytics_daily_owned_brand_metrics
       WHERE project_id = ? AND tracking_source = ? AND metric_date = ?
         AND brand_metrics_revision = ?
         AND mentioned_response_count <= 0 AND position_sample_count <= 0`,
    ).bind(
      input.projectId,
      input.trackingSource,
      input.metricDate,
      input.revision,
    ),
    db.prepare(
      `UPDATE analytics_snapshot_facts
       SET brand_metrics_revision = ?, updated_at = ?
       WHERE snapshot_id = ?`,
    ).bind(input.revision, updatedAt, input.snapshotId),
  );
  await db.batch(statements);
}
