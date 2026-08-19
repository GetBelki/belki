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

export function relatedQueryLabel(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["query", "keyword", "text", "title"] as const) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].trim();
    }
  }
  return null;
}

export function normalizeRelatedQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export interface RelatedQueryClassification {
  reviewPresent: boolean;
  sitePresent: boolean;
  years: number[];
}

export interface ResponseShareTrendPoint {
  date: string;
  matchingResponses: number;
  completedResponses: number;
  share: number;
}

export function buildResponseShareTrend(
  dates: { from: string; to: string },
  completedByDate: ReadonlyMap<string, number>,
  matchingByDate: ReadonlyMap<string, number>,
): ResponseShareTrendPoint[] {
  const values: ResponseShareTrendPoint[] = [];
  const cursor = new Date(`${dates.from}T00:00:00.000Z`);
  const end = Date.parse(`${dates.to}T00:00:00.000Z`);
  while (cursor.getTime() <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const completedResponses = completedByDate.get(date) ?? 0;
    const matchingResponses = matchingByDate.get(date) ?? 0;
    values.push({
      date,
      matchingResponses,
      completedResponses,
      share: completedResponses
        ? (matchingResponses / completedResponses) * 100
        : 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
}

export function classifyRelatedQueries(
  queries: Iterable<string>,
  currentYear = new Date().getUTCFullYear(),
): RelatedQueryClassification {
  let reviewPresent = false;
  let sitePresent = false;
  const years = new Set<number>();
  for (const query of queries) {
    const normalized = query.normalize("NFKC").toLowerCase();
    sitePresent ||= /(?:^|[^\p{L}\p{N}_])site:/iu.test(normalized);
    reviewPresent ||= /(?:^|[^\p{L}\p{N}_])reviews?(?=$|[^\p{L}\p{N}_])/iu.test(
      normalized,
    );
    for (const match of normalized.matchAll(/(?:^|\D)(\d{4})(?=\D|$)/gu)) {
      const year = Number(match[1]);
      if (year >= 2025 && year <= currentYear) years.add(year);
    }
  }
  return {
    reviewPresent,
    sitePresent,
    years: [...years].sort((left, right) => left - right),
  };
}

export function relatedQueryKey(normalizedQuery: string): string {
  const bytes = new TextEncoder().encode(normalizedQuery);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function relatedQueryFromKey(key: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) return null;
  try {
    const padded = `${key.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
      (4 - (key.length % 4)) % 4,
    )}`;
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
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

export interface TrackedBrandReportRow {
  id: string;
  name: string;
  kind: "owned" | "competitor";
}

export interface CompletedRunsDailyRow {
  metric_date: string;
  completed_runs: number;
}

export interface PromptSetAuditRow {
  action: string;
  metadata_json: string;
  created_at: string;
}

export interface PromptSetEvent {
  metric_date: string;
  addedCount: number;
  removedCount: number;
}

export function buildPromptSetEvents(
  rows: PromptSetAuditRow[],
  projectId: string,
): PromptSetEvent[] {
  const eventsByDate = new Map<string, PromptSetEvent>();

  for (const row of rows) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      continue;
    }
    if (!metadata || typeof metadata !== "object") continue;
    const values = metadata as Record<string, unknown>;
    if (values.projectId !== projectId) continue;

    const date = row.created_at.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
    let addedCount = 0;
    let removedCount = 0;
    if (row.action === "query.created") {
      addedCount = 1;
    } else if (row.action === "query.bulk_created") {
      const createdCount = values.createdCount;
      if (
        typeof createdCount !== "number" ||
        !Number.isInteger(createdCount) ||
        createdCount <= 0
      ) {
        continue;
      }
      addedCount = createdCount;
    } else if (row.action === "query.purge_requested") {
      removedCount = 1;
    } else {
      continue;
    }

    const event = eventsByDate.get(date) ?? {
      metric_date: date,
      addedCount: 0,
      removedCount: 0,
    };
    event.addedCount += addedCount;
    event.removedCount += removedCount;
    eventsByDate.set(date, event);
  }

  return [...eventsByDate.values()].sort((left, right) =>
    left.metric_date.localeCompare(right.metric_date),
  );
}

export interface BrandMentionDailyRow {
  metric_date: string;
  brand_id: string;
  deterministic_responses: number;
  extracted_responses: number;
  overlap_responses: number;
  owned_mentioned_responses: number;
}

export interface SourceBrandMentionDailyRow extends BrandMentionDailyRow {
  tracking_source: string;
}

/**
 * Combines source-scoped brand rows without double-counting the owned-brand
 * response union, which is repeated once for every brand on a source/day.
 */
export function aggregateBrandMentionDays(
  rows: SourceBrandMentionDailyRow[],
): BrandMentionDailyRow[] {
  const mentions = new Map<string, BrandMentionDailyRow>();
  const ownedBySourceDate = new Map<string, number>();

  for (const row of rows) {
    const key = `${row.metric_date}\u0000${row.brand_id}`;
    const current = mentions.get(key) ?? {
      metric_date: row.metric_date,
      brand_id: row.brand_id,
      deterministic_responses: 0,
      extracted_responses: 0,
      overlap_responses: 0,
      owned_mentioned_responses: 0,
    };
    current.deterministic_responses += nonNegativeCount(
      row.deterministic_responses,
    );
    current.extracted_responses += nonNegativeCount(row.extracted_responses);
    current.overlap_responses += nonNegativeCount(row.overlap_responses);
    mentions.set(key, current);

    const sourceDateKey = `${row.tracking_source}\u0000${row.metric_date}`;
    ownedBySourceDate.set(
      sourceDateKey,
      Math.max(
        ownedBySourceDate.get(sourceDateKey) ?? 0,
        nonNegativeCount(row.owned_mentioned_responses),
      ),
    );
  }

  const ownedByDate = new Map<string, number>();
  for (const [sourceDateKey, count] of ownedBySourceDate) {
    const metricDate = sourceDateKey.split("\u0000")[1]!;
    ownedByDate.set(metricDate, (ownedByDate.get(metricDate) ?? 0) + count);
  }
  for (const row of mentions.values()) {
    row.owned_mentioned_responses = ownedByDate.get(row.metric_date) ?? 0;
  }
  return [...mentions.values()].sort(
    (left, right) =>
      left.metric_date.localeCompare(right.metric_date) ||
      left.brand_id.localeCompare(right.brand_id),
  );
}

interface BrandMetric {
  mentionedResponses: number;
  appearances: number;
  visibility: number;
  shareOfVoice: number | null;
}

export interface BrandComparisonBrand extends BrandMetric {
  key: string;
  id: string | null;
  name: string;
  kind: "owned" | "competitor";
}

function nonNegativeCount(value: number): number {
  return Math.max(0, Number(value) || 0);
}

function rate(numerator: number, denominator: number): number {
  return denominator ? (numerator / denominator) * 100 : 0;
}

function deduplicatedMentions(row: BrandMentionDailyRow): number {
  return Math.max(
    0,
    nonNegativeCount(row.deterministic_responses) +
      nonNegativeCount(row.extracted_responses) -
      nonNegativeCount(row.overlap_responses),
  );
}

export function buildBrandComparison(
  trackedBrands: TrackedBrandReportRow[],
  completedDays: CompletedRunsDailyRow[],
  mentionDays: BrandMentionDailyRow[],
) {
  const ownedBrands = trackedBrands.filter((brand) => brand.kind === "owned");
  const competitors = trackedBrands.filter(
    (brand) => brand.kind === "competitor",
  );
  const trackedById = new Map(trackedBrands.map((brand) => [brand.id, brand]));
  const countsByDate = new Map<string, Map<string, number>>();
  const ownedMentionsByDate = new Map<string, number>();

  for (const row of mentionDays) {
    if (!trackedById.has(row.brand_id)) continue;
    const values = countsByDate.get(row.metric_date) ?? new Map<string, number>();
    values.set(
      row.brand_id,
      (values.get(row.brand_id) ?? 0) + deduplicatedMentions(row),
    );
    countsByDate.set(row.metric_date, values);
    ownedMentionsByDate.set(
      row.metric_date,
      Math.max(
        ownedMentionsByDate.get(row.metric_date) ?? 0,
        nonNegativeCount(row.owned_mentioned_responses),
      ),
    );
  }

  const completedRuns = completedDays.reduce(
    (total, day) => total + nonNegativeCount(day.completed_runs),
    0,
  );
  const totalsByBrand = new Map(trackedBrands.map((brand) => [brand.id, 0]));
  let ownedMentionedResponses = 0;
  for (const day of completedDays) {
    ownedMentionedResponses += ownedMentionsByDate.get(day.metric_date) ?? 0;
    for (const [brandId, count] of countsByDate.get(day.metric_date) ?? []) {
      totalsByBrand.set(brandId, (totalsByBrand.get(brandId) ?? 0) + count);
    }
  }

  const ownedAppearances = ownedBrands.reduce(
    (total, brand) => total + (totalsByBrand.get(brand.id) ?? 0),
    0,
  );
  const totalBrandAppearances = [...totalsByBrand.values()].reduce(
    (total, count) => total + count,
    0,
  );
  const competitorMetrics = competitors
    .map((brand) => {
      const appearances = totalsByBrand.get(brand.id) ?? 0;
      return {
        key: `competitor_${brand.id}`,
        id: brand.id,
        name: brand.name,
        kind: brand.kind,
        mentionedResponses: appearances,
        appearances,
        visibility: rate(appearances, completedRuns),
        shareOfVoice: totalBrandAppearances
          ? rate(appearances, totalBrandAppearances)
          : null,
      } satisfies BrandComparisonBrand;
    })
    .sort(
      (left, right) =>
        right.appearances - left.appearances ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
  const hasCompetitors = competitors.length > 0;
  const ownedVisibility = rate(ownedMentionedResponses, completedRuns);
  const ownedShareOfVoice =
    hasCompetitors && totalBrandAppearances
      ? rate(ownedAppearances, totalBrandAppearances)
      : null;
  const leadingCompetitor = competitorMetrics[0] ?? null;
  const ownedSeriesName =
    ownedBrands.length === 1 ? ownedBrands[0]!.name : "Your brands";
  const displayedBrands: BrandComparisonBrand[] = [
    {
      key: "owned",
      id: ownedBrands.length === 1 ? ownedBrands[0]!.id : null,
      name: ownedSeriesName,
      kind: "owned",
      mentionedResponses: ownedMentionedResponses,
      appearances: ownedAppearances,
      visibility: ownedVisibility,
      shareOfVoice: ownedShareOfVoice,
    },
    ...competitorMetrics.slice(0, 4),
  ];

  return {
    summary: {
      ownedMentionedResponses,
      ownedAppearances,
      ownedVisibility,
      ownedShareOfVoice,
      totalBrandAppearances,
      trackedCompetitorCount: competitors.length,
      competitiveGap: leadingCompetitor
        ? {
            competitorId: leadingCompetitor.id,
            competitorName: leadingCompetitor.name,
            competitorVisibility: leadingCompetitor.visibility,
            differencePercentagePoints:
              ownedVisibility - leadingCompetitor.visibility,
          }
        : null,
    },
    brands: displayedBrands,
    series: completedDays.map((day) => {
      const counts = countsByDate.get(day.metric_date) ?? new Map<string, number>();
      const completed = nonNegativeCount(day.completed_runs);
      const totalAppearances = [...counts.values()].reduce(
        (total, count) => total + count,
        0,
      );
      const ownedDailyAppearances = ownedBrands.reduce(
        (total, brand) => total + (counts.get(brand.id) ?? 0),
        0,
      );
      const ownedDailyMentions = ownedMentionsByDate.get(day.metric_date) ?? 0;
      return {
        metric_date: day.metric_date,
        completedRuns: completed,
        totalBrandAppearances: totalAppearances,
        metrics: Object.fromEntries(
          displayedBrands.map((brand) => {
            const appearances =
              brand.kind === "owned"
                ? ownedDailyAppearances
                : counts.get(brand.id ?? "") ?? 0;
            const mentionedResponses =
              brand.kind === "owned" ? ownedDailyMentions : appearances;
            return [
              brand.key,
              {
                mentionedResponses,
                appearances,
                visibility: rate(mentionedResponses, completed),
                shareOfVoice:
                  hasCompetitors && totalAppearances
                    ? rate(appearances, totalAppearances)
                    : null,
              } satisfies BrandMetric,
            ];
          }),
        ),
      };
    }),
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
  const valuesByDate = new Map<string, { runs: number; cost: number }>();
  for (const row of rows) {
    const current = valuesByDate.get(row.metric_date) ?? { runs: 0, cost: 0 };
    valuesByDate.set(row.metric_date, {
      runs: current.runs + (Number(row.charged_runs) || 0),
      cost: roundCost(current.cost + (Number(row.provider_cost_usd) || 0)),
    });
  }
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
  entityExtraction?: BillingReport,
  promptDetails?: {
    highPriority?: BillingReport;
    live?: BillingReport;
    retainedPages?: BillingReport;
  },
) {
  const emptyReport = (): BillingReport => ({
    range: promptTracking.range,
    summary: { totalCost: 0, chargedRuns: 0, highestDailyCost: 0, averageCost: 0 },
    series: promptTracking.series.map((point) => ({ date: point.date, runs: 0, cost: 0 })),
  });
  const extraction = entityExtraction ?? emptyReport();
  const highPriority = promptDetails?.highPriority ?? emptyReport();
  const live = promptDetails?.live ?? emptyReport();
  const retainedPages = promptDetails?.retainedPages ?? emptyReport();
  const standard: BillingReport = {
    range: promptTracking.range,
    summary: {
      totalCost: roundCost(Math.max(
        0,
        promptTracking.summary.totalCost - highPriority.summary.totalCost -
          live.summary.totalCost,
      )),
      chargedRuns: Math.max(
        0,
        promptTracking.summary.chargedRuns - highPriority.summary.chargedRuns -
          live.summary.chargedRuns,
      ),
      highestDailyCost: 0,
      averageCost: 0,
    },
    series: promptTracking.series.map((point, index) => {
      const priorityPoint = highPriority.series[index] ?? {
        date: point.date,
        runs: 0,
        cost: 0,
      };
      const livePoint = live.series[index] ?? {
        date: point.date,
        runs: 0,
        cost: 0,
      };
      return {
        date: point.date,
        runs: Math.max(0, point.runs - priorityPoint.runs - livePoint.runs),
        cost: roundCost(Math.max(0, point.cost - priorityPoint.cost - livePoint.cost)),
      };
    }),
  };
  standard.summary.highestDailyCost = Math.max(
    ...standard.series.map((point) => point.cost),
    0,
  );
  standard.summary.averageCost = standard.summary.chargedRuns
    ? roundCost(
      standard.summary.totalCost / standard.summary.chargedRuns,
    )
    : 0;
  const totalCost = roundCost(
    promptTracking.summary.totalCost + productEnrichment.summary.totalCost +
      extraction.summary.totalCost,
  );
  const chargedTasks =
    promptTracking.summary.chargedRuns + productEnrichment.summary.chargedRuns +
      extraction.summary.chargedRuns;
  const series = promptTracking.series.map((prompt, index) => {
    const enrichment = productEnrichment.series[index] ?? {
      date: prompt.date,
      runs: 0,
      cost: 0,
    };
    const entity = extraction.series[index] ?? {
      date: prompt.date,
      runs: 0,
      cost: 0,
    };
    const standardPoint = standard.series[index] ?? {
      date: prompt.date,
      runs: 0,
      cost: 0,
    };
    const priorityPoint = highPriority.series[index] ?? {
      date: prompt.date,
      runs: 0,
      cost: 0,
    };
    const livePoint = live.series[index] ?? {
      date: prompt.date,
      runs: 0,
      cost: 0,
    };
    return {
      date: prompt.date,
      totalCost: roundCost(prompt.cost + enrichment.cost + entity.cost),
      promptTrackingCost: prompt.cost,
      promptTrackingStandardCost: standardPoint.cost,
      promptTrackingHighPriorityCost: priorityPoint.cost,
      promptTrackingLiveCost: livePoint.cost,
      productEnrichmentCost: enrichment.cost,
      entityExtractionCost: entity.cost,
      totalTasks: prompt.runs + enrichment.runs + entity.runs,
      promptTrackingTasks: prompt.runs,
      promptTrackingStandardTasks: standardPoint.runs,
      promptTrackingHighPriorityTasks: priorityPoint.runs,
      promptTrackingLiveTasks: livePoint.runs,
      productEnrichmentTasks: enrichment.runs,
      entityExtractionTasks: entity.runs,
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
        entityExtraction: category(extraction),
      },
      promptTrackingBreakdown: {
        standard: category(standard),
        highPriority: category(highPriority),
        live: category(live),
        retainedPages: category(retainedPages),
      },
    },
    series,
  };
}
