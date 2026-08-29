import type { CaptureProvider, TrackingSource } from "./contracts";
import { TRACKING_SOURCES } from "./tracking-sources";

export interface CaptureProviderActivityRow {
  provider_account_id: string;
  provider: CaptureProvider;
  tracking_source: TrackingSource;
  attempts: number;
  submitted: number;
  completed: number;
  failed: number;
  ambiguous: number;
  in_progress: number;
  latency_samples: number;
  latency_total_ms: number;
  last_activity_at: string | null;
}

export interface CaptureProviderActivityMetrics {
  attempts: number;
  submitted: number;
  completed: number;
  failed: number;
  ambiguous: number;
  needsAttention: number;
  inProgress: number;
  successRate: number;
  averageLatencyMs: number | null;
  lastActivityAt: string | null;
}

function activityMetrics(
  rows: CaptureProviderActivityRow[],
): CaptureProviderActivityMetrics {
  const totals = rows.reduce(
    (result, row) => ({
      attempts: result.attempts + Number(row.attempts ?? 0),
      submitted: result.submitted + Number(row.submitted ?? 0),
      completed: result.completed + Number(row.completed ?? 0),
      failed: result.failed + Number(row.failed ?? 0),
      ambiguous: result.ambiguous + Number(row.ambiguous ?? 0),
      inProgress: result.inProgress + Number(row.in_progress ?? 0),
      latencySamples: result.latencySamples + Number(row.latency_samples ?? 0),
      latencyTotalMs: result.latencyTotalMs + Number(row.latency_total_ms ?? 0),
      lastActivityAt: !result.lastActivityAt || (
        row.last_activity_at && row.last_activity_at > result.lastActivityAt
      )
        ? row.last_activity_at
        : result.lastActivityAt,
    }),
    {
      attempts: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      ambiguous: 0,
      inProgress: 0,
      latencySamples: 0,
      latencyTotalMs: 0,
      lastActivityAt: null as string | null,
    },
  );
  const settled = totals.completed + totals.failed + totals.ambiguous;
  return {
    attempts: totals.attempts,
    submitted: totals.submitted,
    completed: totals.completed,
    failed: totals.failed,
    ambiguous: totals.ambiguous,
    needsAttention: totals.failed + totals.ambiguous,
    inProgress: totals.inProgress,
    successRate: settled ? Math.round((totals.completed / settled) * 1_000) / 10 : 0,
    averageLatencyMs: totals.latencySamples
      ? Math.round(totals.latencyTotalMs / totals.latencySamples)
      : null,
    lastActivityAt: totals.lastActivityAt,
  };
}

export function summarizeCaptureProviderActivity(
  rows: CaptureProviderActivityRow[],
  range: { from: string; to: string },
) {
  const accountKeys = [...new Set(rows.map((row) => row.provider_account_id))];
  return {
    period: "30d" as const,
    range,
    summary: activityMetrics(rows),
    byAccount: accountKeys.map((providerAccountId) => {
      const accountRows = rows.filter(
        (row) => row.provider_account_id === providerAccountId,
      );
      return {
        providerAccountId,
        provider: accountRows[0]!.provider,
        ...activityMetrics(accountRows),
      };
    }),
    byPlatform: TRACKING_SOURCES.map((trackingSource) => ({
      trackingSource,
      ...activityMetrics(rows.filter((row) => row.tracking_source === trackingSource)),
    })),
  };
}
