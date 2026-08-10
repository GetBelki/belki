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
    (value ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
  return `fallback:${normalized(product.title)}|${normalized(
    product.merchants ?? product.registrable_domain,
  )}`;
}

export function productKey(product: Parameters<typeof productIdentity>[0]): string {
  const bytes = new TextEncoder().encode(productIdentity(product));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function productIdentityFromKey(key: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) return null;
  try {
    const padded = `${key.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
      (4 - (key.length % 4)) % 4,
    )}`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

export type ProductAnalyticsPeriod = "7d" | "30d" | "90d" | "365d";

export function productAnalyticsDateRange(
  period: ProductAnalyticsPeriod,
  now = new Date(),
): BillingDateRange {
  const days =
    period === "365d" ? 365 : period === "90d" ? 90 : period === "7d" ? 7 : 30;
  const today = utcDate(now);
  const start = new Date(today.getTime() - (days - 1) * 86_400_000);
  const endExclusive = new Date(today.getTime() + 86_400_000);
  return {
    from: dateKey(start),
    to: dateKey(today),
    startTimestamp: start.toISOString(),
    endExclusiveTimestamp: endExclusive.toISOString(),
  };
}

export function summarizeProductPrices(
  occurrences: Array<{
    captured_at: string;
    price: number | null;
    currency: string | null;
  }>,
) {
  const priced = occurrences
    .filter(
      (
        occurrence,
      ): occurrence is {
        captured_at: string;
        price: number;
        currency: string | null;
      } => occurrence.price !== null,
    )
    .sort((left, right) => right.captured_at.localeCompare(left.captured_at));
  const latest = priced[0];
  if (!latest) return null;
  const comparable = priced.filter(
    (occurrence) => occurrence.currency === latest.currency,
  );
  const earliest = comparable.at(-1)!;
  const values = comparable.map((occurrence) => occurrence.price);
  const hasComparison = comparable.length > 1;
  const change = hasComparison ? latest.price - earliest.price : null;
  return {
    currency: latest.currency,
    latest: latest.price,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    change,
    changePercent:
      change !== null && earliest.price ? (change / earliest.price) * 100 : null,
  };
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

type BillingReport = ReturnType<typeof buildBillingReport>;

export function mergeBillingReports(
  promptTracking: BillingReport,
  productEnrichment: BillingReport,
) {
  const totalCost = roundCost(
    promptTracking.summary.totalCost + productEnrichment.summary.totalCost,
  );
  const chargedTasks =
    promptTracking.summary.chargedRuns + productEnrichment.summary.chargedRuns;
  const series = promptTracking.series.map((prompt, index) => {
    const enrichment = productEnrichment.series[index] ?? {
      date: prompt.date,
      runs: 0,
      cost: 0,
    };
    return {
      date: prompt.date,
      totalCost: roundCost(prompt.cost + enrichment.cost),
      promptTrackingCost: prompt.cost,
      productEnrichmentCost: enrichment.cost,
      totalTasks: prompt.runs + enrichment.runs,
      promptTrackingTasks: prompt.runs,
      productEnrichmentTasks: enrichment.runs,
    };
  });
  const category = (report: BillingReport) => ({
    chargedTasks: report.summary.chargedRuns,
    totalCost: report.summary.totalCost,
    averageCost: report.summary.averageCost,
    sharePercent: totalCost
      ? (report.summary.totalCost / totalCost) * 100
      : 0,
  });
  return {
    range: promptTracking.range,
    summary: {
      totalCost,
      chargedTasks,
      chargedRuns: chargedTasks,
      averageCost: chargedTasks ? roundCost(totalCost / chargedTasks) : 0,
      highestDailyCost: Math.max(
        ...series.map((point) => point.totalCost),
        0,
      ),
      byCategory: {
        promptTracking: category(promptTracking),
        productEnrichment: category(productEnrichment),
      },
    },
    series,
  };
}
