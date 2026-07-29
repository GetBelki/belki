export function productIdentity(product: {
  provider_product_id: string | null;
  canonical_url: string | null;
  raw_url: string | null;
  title: string | null;
  merchants: string | null;
  registrable_domain: string | null;
}): string {
  if (product.provider_product_id) return `id:${product.provider_product_id}`;
  if (product.canonical_url || product.raw_url) {
    return `url:${product.canonical_url ?? product.raw_url}`;
  }
  const normalized = (value: string | null) =>
    (value ?? "").trim().toLocaleLowerCase().replace(/\s+/gu, " ");
  return `fallback:${normalized(product.title)}|${normalized(
    product.merchants ?? product.registrable_domain,
  )}`;
}

export type BillingPeriod = "30d" | "month";

export interface BillingDateRange {
  from: string;
  to: string;
  startTimestamp: string;
  endExclusiveTimestamp: string;
}

export interface BillingDailyRow {
  metric_date: string;
  charged_runs: number;
  provider_cost_usd: number;
}

function utcDate(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function roundCost(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

export function billingDateRange(
  period: BillingPeriod,
  now = new Date(),
): BillingDateRange {
  const today = utcDate(now);
  const start =
    period === "month"
      ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      : new Date(today.getTime() - 29 * 86_400_000);
  const endExclusive = new Date(today.getTime() + 86_400_000);
  return {
    from: dateKey(start),
    to: dateKey(today),
    startTimestamp: start.toISOString(),
    endExclusiveTimestamp: endExclusive.toISOString(),
  };
}

export function buildBillingReport(
  rows: BillingDailyRow[],
  dates: BillingDateRange,
) {
  const valuesByDate = new Map(
    rows.map((row) => [
      row.metric_date,
      {
        runs: Number(row.charged_runs) || 0,
        cost: roundCost(Number(row.provider_cost_usd) || 0),
      },
    ]),
  );
  const series: Array<{ date: string; runs: number; cost: number }> = [];
  const cursor = new Date(`${dates.from}T00:00:00.000Z`);
  const end = new Date(`${dates.to}T00:00:00.000Z`);
  while (cursor <= end) {
    const date = dateKey(cursor);
    const value = valuesByDate.get(date) ?? { runs: 0, cost: 0 };
    series.push({ date, ...value });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const summary = series.reduce(
    (total, point) => ({
      totalCost: roundCost(total.totalCost + point.cost),
      chargedRuns: total.chargedRuns + point.runs,
      highestDailyCost: Math.max(total.highestDailyCost, point.cost),
    }),
    { totalCost: 0, chargedRuns: 0, highestDailyCost: 0 },
  );
  return {
    range: { from: dates.from, to: dates.to },
    summary: {
      ...summary,
      averageCost: summary.chargedRuns
        ? roundCost(summary.totalCost / summary.chargedRuns)
        : 0,
    },
    series,
  };
}
