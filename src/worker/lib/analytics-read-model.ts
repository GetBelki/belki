// Version 10 reclassifies fan-out signals to include education domains.
export const ANALYTICS_READ_MODEL_SCHEMA_VERSION = 10;
export const RELATED_QUERY_SIGNAL_COUNTS_VERSION = 2;
export const ANALYTICS_BACKFILL_BATCH_SIZE = 50;
export const BRAND_METRICS_BACKFILL_BATCH_SIZE = 250;
export const FAN_OUT_SIGNAL_BACKFILL_BATCH_SIZE = 1_000;
export const FAN_OUT_TELEMETRY_BACKFILL_BATCH_SIZE = 400;
// Related-query tables and indexing were complete in version 4. Later additive
// schema versions must remain valid for this report.
export const RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION = 4;

export interface AnalyticsReadModelState {
  status: string;
  schema_version: number;
}

export function analyticsReadModelSupports(
  state: AnalyticsReadModelState | null,
  requiredVersion = ANALYTICS_READ_MODEL_SCHEMA_VERSION,
): boolean {
  return state?.status === "ready" && state.schema_version >= requiredVersion;
}

export function analyticsBackfillEstimatedMinutes(
  fullRemaining: number,
  telemetryRemaining = 0,
  signalRemaining = 0,
): number {
  return Math.max(
    Math.ceil(Math.max(0, fullRemaining) / ANALYTICS_BACKFILL_BATCH_SIZE),
    Math.ceil(
      Math.max(0, telemetryRemaining) / FAN_OUT_TELEMETRY_BACKFILL_BATCH_SIZE,
    ),
    Math.ceil(
      Math.max(0, signalRemaining) / FAN_OUT_SIGNAL_BACKFILL_BATCH_SIZE,
    ),
  );
}
