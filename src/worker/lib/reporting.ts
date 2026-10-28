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

export const RELATED_QUERY_SIGNAL_KEYS = [
  "site",
  "official",
  "government",
  "education",
  "pricing",
  "reviews",
  "best",
  "top",
  "comparison",
  "vs",
] as const;

export type RelatedQuerySignalKey = (typeof RELATED_QUERY_SIGNAL_KEYS)[number];

export interface RelatedQuerySignalCounts
  extends Record<RelatedQuerySignalKey, number> {
  years: Record<string, number>;
}

export interface RelatedQueryClassification {
  governmentPresent: boolean;
  officialPresent: boolean;
  reviewPresent: boolean;
  signalCounts: RelatedQuerySignalCounts;
  sitePresent: boolean;
  years: number[];
}

export interface ResponseShareTrendPoint {
  date: string;
  matchingResponses: number;
  completedResponses: number;
  share: number;
}

export interface CitationUtmCoverageTrendPoint {
  date: string;
  citations: number;
  citationUrls: number;
  utmSourceCitations: number;
  coverage: number | null;
}

export function buildCitationUtmCoverageTrend(
  dates: { from: string; to: string },
  citationsByDate: ReadonlyMap<string, number>,
  citationUrlsByDate: ReadonlyMap<string, number>,
  utmSourceCitationsByDate: ReadonlyMap<string, number>,
): CitationUtmCoverageTrendPoint[] {
  const values: CitationUtmCoverageTrendPoint[] = [];
  const cursor = new Date(`${dates.from}T00:00:00.000Z`);
  const end = Date.parse(`${dates.to}T00:00:00.000Z`);
  while (cursor.getTime() <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const citations = citationsByDate.get(date) ?? 0;
    const citationUrls = citationUrlsByDate.get(date) ?? 0;
    const utmSourceCitations = utmSourceCitationsByDate.get(date) ?? 0;
    values.push({
      date,
      citations,
      citationUrls,
      utmSourceCitations,
      coverage: citationUrls
        ? (utmSourceCitations / citationUrls) * 100
        : null,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
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

export interface FanOutActivityTrendPoint {
  date: string;
  completedResponses: number;
  reportedResponses: number;
  unavailableResponses: number;
  responsesWithFanOut: number;
  totalFanOuts: number;
  responseShare: number;
  fanOutsPerResponse: number;
  telemetryCoverage: number;
}

export interface FanOutSignalTrendPoint {
  date: string;
  matchingFanOuts: number;
  totalFanOuts: number;
  matchingResponses: number;
  completedResponses: number;
  reportedResponses: number;
  shareOfFanOuts: number;
  fanOutsPerResponse: number;
  responseShare: number;
}

export function buildFanOutActivityTrend(
  dates: { from: string; to: string },
  completedByDate: ReadonlyMap<string, number>,
  reportedByDate: ReadonlyMap<string, number>,
  responsesWithFanOutByDate: ReadonlyMap<string, number>,
  totalFanOutsByDate: ReadonlyMap<string, number>,
): FanOutActivityTrendPoint[] {
  const values: FanOutActivityTrendPoint[] = [];
  const cursor = new Date(`${dates.from}T00:00:00.000Z`);
  const end = Date.parse(`${dates.to}T00:00:00.000Z`);
  while (cursor.getTime() <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const completedResponses = completedByDate.get(date) ?? 0;
    const reportedResponses = reportedByDate.get(date) ?? 0;
    const responsesWithFanOut = responsesWithFanOutByDate.get(date) ?? 0;
    const totalFanOuts = totalFanOutsByDate.get(date) ?? 0;
    values.push({
      date,
      completedResponses,
      reportedResponses,
      unavailableResponses: Math.max(0, completedResponses - reportedResponses),
      responsesWithFanOut,
      totalFanOuts,
      responseShare: reportedResponses
        ? (responsesWithFanOut / reportedResponses) * 100
        : 0,
      fanOutsPerResponse: reportedResponses
        ? totalFanOuts / reportedResponses
        : 0,
      telemetryCoverage: completedResponses
        ? (reportedResponses / completedResponses) * 100
        : 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
}

export function buildFanOutSignalTrend(
  dates: { from: string; to: string },
  completedByDate: ReadonlyMap<string, number>,
  reportedByDate: ReadonlyMap<string, number>,
  totalFanOutsByDate: ReadonlyMap<string, number>,
  matchingResponsesByDate: ReadonlyMap<string, number>,
  matchingFanOutsByDate: ReadonlyMap<string, number>,
): FanOutSignalTrendPoint[] {
  const values: FanOutSignalTrendPoint[] = [];
  const cursor = new Date(`${dates.from}T00:00:00.000Z`);
  const end = Date.parse(`${dates.to}T00:00:00.000Z`);
  while (cursor.getTime() <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const completedResponses = completedByDate.get(date) ?? 0;
    const reportedResponses = reportedByDate.get(date) ?? 0;
    const totalFanOuts = totalFanOutsByDate.get(date) ?? 0;
    const matchingResponses = matchingResponsesByDate.get(date) ?? 0;
    const matchingFanOuts = matchingFanOutsByDate.get(date) ?? 0;
    values.push({
      date,
      matchingFanOuts,
      totalFanOuts,
      matchingResponses,
      completedResponses,
      reportedResponses,
      shareOfFanOuts: totalFanOuts
        ? (matchingFanOuts / totalFanOuts) * 100
        : 0,
      fanOutsPerResponse: reportedResponses
        ? matchingFanOuts / reportedResponses
        : 0,
      responseShare: reportedResponses
        ? (matchingResponses / reportedResponses) * 100
        : 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
}

function emptyRelatedQuerySignalCounts(): RelatedQuerySignalCounts {
  return {
    site: 0,
    official: 0,
    government: 0,
    education: 0,
    pricing: 0,
    reviews: 0,
    best: 0,
    top: 0,
    comparison: 0,
    vs: 0,
    years: {},
  };
}

export function classifyRelatedQueries(
  queries: Iterable<string>,
  currentYear = new Date().getUTCFullYear(),
): RelatedQueryClassification {
  const signalCounts = emptyRelatedQuerySignalCounts();
  const seenQueries = new Set<string>();
  for (const query of queries) {
    const normalized = normalizeRelatedQuery(query);
    if (!normalized || seenQueries.has(normalized)) continue;
    seenQueries.add(normalized);
    if (/(?:^|[^\p{L}\p{N}_])site:/iu.test(normalized)) {
      signalCounts.site += 1;
    }
    if (/(?:^|[^\p{L}\p{N}_])(?:official|oficial)(?=$|[^\p{L}\p{N}_])/iu.test(normalized)) {
      signalCounts.official += 1;
    }
    if (/\.(?:gov|gob)(?=$|[^\p{L}\p{N}_])/iu.test(normalized)) {
      signalCounts.government += 1;
    }
    if (/\.edu(?=$|[^\p{L}\p{N}_])/iu.test(normalized)) {
      signalCounts.education += 1;
    }
    if (/(?:^|[^\p{L}\p{N}_])pricing(?=$|[^\p{L}\p{N}_])/iu.test(normalized)) {
      signalCounts.pricing += 1;
    }
    if (/(?:^|[^\p{L}\p{N}_])reviews?(?=$|[^\p{L}\p{N}_])/iu.test(normalized)) {
      signalCounts.reviews += 1;
    }
    if (/(?:^|[^\p{L}\p{N}_])best(?=$|[^\p{L}\p{N}_])/iu.test(normalized)) {
      signalCounts.best += 1;
    }
    if (/(?:^|[^\p{L}\p{N}_])top(?=$|[^\p{L}\p{N}_])/iu.test(normalized)) {
      signalCounts.top += 1;
    }
    if (/(?:^|[^\p{L}\p{N}_])comparisons?(?=$|[^\p{L}\p{N}_])/iu.test(normalized)) {
      signalCounts.comparison += 1;
    }
    if (/(?:^|[^\p{L}\p{N}_])vs(?=$|[^\p{L}\p{N}_])/iu.test(normalized)) {
      signalCounts.vs += 1;
    }
    const queryYears = new Set<number>();
    for (const match of normalized.matchAll(/(?:^|\D)(\d{4})(?=\D|$)/gu)) {
      const year = Number(match[1]);
      if (year >= 2025 && year <= currentYear) queryYears.add(year);
    }
    for (const year of queryYears) {
      const key = String(year);
      signalCounts.years[key] = (signalCounts.years[key] ?? 0) + 1;
    }
  }
  const years = Object.keys(signalCounts.years)
    .map(Number)
    .sort((left, right) => left - right);
  return {
    governmentPresent: signalCounts.government > 0,
    officialPresent: signalCounts.official > 0,
    reviewPresent: signalCounts.reviews > 0,
    signalCounts,
    sitePresent: signalCounts.site > 0,
    years,
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
): AnalyticsDateRange {
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

export function productAnalyticsComparisonDateRange(
  period: ProductAnalyticsPeriod,
  now = new Date(),
): AnalyticsDateRange {
  const current = productAnalyticsDateRange(period, now);
  const currentStart = new Date(current.startTimestamp);
  const currentEnd = new Date(current.endExclusiveTimestamp);
  const duration = currentEnd.getTime() - currentStart.getTime();
  const previousEnd = currentStart;
  const previousStart = new Date(previousEnd.getTime() - duration);
  const previousTo = new Date(previousEnd.getTime() - 86_400_000);
  return {
    from: dateKey(previousStart),
    to: dateKey(previousTo),
    startTimestamp: previousStart.toISOString(),
    endExclusiveTimestamp: previousEnd.toISOString(),
  };
}

export interface ProductCaptureOccurrence {
  snapshot_id: string;
  ordinal: number;
}

export interface ProductPerformanceSummary {
  appearances: number;
  appearingCaptures: number;
  winningCaptures: number;
  appearanceRate: number;
  winRate: number;
  averagePosition: number | null;
}

export function productCapturePositions(
  occurrences: ProductCaptureOccurrence[],
): Map<string, number> {
  const positions = new Map<string, number>();
  for (const occurrence of occurrences) {
    const position = occurrence.ordinal + 1;
    const current = positions.get(occurrence.snapshot_id);
    if (current === undefined || position < current) {
      positions.set(occurrence.snapshot_id, position);
    }
  }
  return positions;
}

export function summarizeProductPerformance(
  occurrences: ProductCaptureOccurrence[],
  completedRuns: number,
): ProductPerformanceSummary {
  const positions = [...productCapturePositions(occurrences).values()];
  const winningCaptures = positions.filter((position) => position === 1).length;
  return {
    appearances: occurrences.length,
    appearingCaptures: positions.length,
    winningCaptures,
    appearanceRate: completedRuns ? (positions.length / completedRuns) * 100 : 0,
    winRate: positions.length ? (winningCaptures / positions.length) * 100 : 0,
    averagePosition: positions.length
      ? positions.reduce((sum, position) => sum + position, 0) / positions.length
      : null,
  };
}

export interface PositionDistribution {
  count: number;
  minimum: number;
  firstQuartile: number;
  median: number;
  thirdQuartile: number;
  maximum: number;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function positionDistribution(
  positions: Iterable<number>,
): PositionDistribution | null {
  const sorted = [...positions]
    .filter((position) => Number.isFinite(position) && position >= 1)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  return {
    count: sorted.length,
    minimum: sorted[0]!,
    firstQuartile: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    thirdQuartile: percentile(sorted, 0.75),
    maximum: sorted.at(-1)!,
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

export interface BrandMentionDailyRow {
  metric_date: string;
  brand_id: string;
  deterministic_responses: number;
  extracted_responses: number;
  overlap_responses: number;
  owned_mentioned_responses: number;
  position_sum?: number;
  position_sample_count?: number;
  owned_position_sum?: number;
  owned_position_sample_count?: number;
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
  const ownedPositionBySourceDate = new Map<
    string,
    { sum: number; samples: number }
  >();

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
    if (
      row.position_sum !== undefined ||
      row.position_sample_count !== undefined
    ) {
      current.position_sum =
        (current.position_sum ?? 0) + nonNegativeCount(row.position_sum ?? 0);
      current.position_sample_count =
        (current.position_sample_count ?? 0) +
        nonNegativeCount(row.position_sample_count ?? 0);
    }
    mentions.set(key, current);

    const sourceDateKey = `${row.tracking_source}\u0000${row.metric_date}`;
    ownedBySourceDate.set(
      sourceDateKey,
      Math.max(
        ownedBySourceDate.get(sourceDateKey) ?? 0,
        nonNegativeCount(row.owned_mentioned_responses),
      ),
    );
    if (
      !ownedPositionBySourceDate.has(sourceDateKey) &&
      (row.owned_position_sum !== undefined ||
        row.owned_position_sample_count !== undefined)
    ) {
      ownedPositionBySourceDate.set(sourceDateKey, {
        sum: nonNegativeCount(row.owned_position_sum ?? 0),
        samples: nonNegativeCount(row.owned_position_sample_count ?? 0),
      });
    }
  }

  const ownedByDate = new Map<string, number>();
  const ownedPositionByDate = new Map<
    string,
    { sum: number; samples: number }
  >();
  for (const [sourceDateKey, count] of ownedBySourceDate) {
    const metricDate = sourceDateKey.split("\u0000")[1]!;
    ownedByDate.set(metricDate, (ownedByDate.get(metricDate) ?? 0) + count);
  }
  for (const [sourceDateKey, position] of ownedPositionBySourceDate) {
    const metricDate = sourceDateKey.split("\u0000")[1]!;
    const current = ownedPositionByDate.get(metricDate) ?? {
      sum: 0,
      samples: 0,
    };
    current.sum += position.sum;
    current.samples += position.samples;
    ownedPositionByDate.set(metricDate, current);
  }
  for (const row of mentions.values()) {
    row.owned_mentioned_responses = ownedByDate.get(row.metric_date) ?? 0;
    const ownedPosition = ownedPositionByDate.get(row.metric_date);
    if (ownedPosition) {
      row.owned_position_sum = ownedPosition.sum;
      row.owned_position_sample_count = ownedPosition.samples;
    }
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
  averagePosition: number | null;
  positionSamples: number;
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
  const positionsByDate = new Map<
    string,
    Map<string, { sum: number; samples: number }>
  >();
  const ownedPositionsByDate = new Map<
    string,
    { sum: number; samples: number }
  >();

  for (const row of mentionDays) {
    if (!trackedById.has(row.brand_id)) continue;
    const values = countsByDate.get(row.metric_date) ?? new Map<string, number>();
    values.set(
      row.brand_id,
      (values.get(row.brand_id) ?? 0) + deduplicatedMentions(row),
    );
    countsByDate.set(row.metric_date, values);
    if (
      row.position_sum !== undefined ||
      row.position_sample_count !== undefined
    ) {
      const positions = positionsByDate.get(row.metric_date) ??
        new Map<string, { sum: number; samples: number }>();
      const current = positions.get(row.brand_id) ?? { sum: 0, samples: 0 };
      current.sum += nonNegativeCount(row.position_sum ?? 0);
      current.samples += nonNegativeCount(row.position_sample_count ?? 0);
      positions.set(row.brand_id, current);
      positionsByDate.set(row.metric_date, positions);
    }
    ownedMentionsByDate.set(
      row.metric_date,
      Math.max(
        ownedMentionsByDate.get(row.metric_date) ?? 0,
        nonNegativeCount(row.owned_mentioned_responses),
      ),
    );
    if (
      !ownedPositionsByDate.has(row.metric_date) &&
      (row.owned_position_sum !== undefined ||
        row.owned_position_sample_count !== undefined)
    ) {
      ownedPositionsByDate.set(row.metric_date, {
        sum: nonNegativeCount(row.owned_position_sum ?? 0),
        samples: nonNegativeCount(row.owned_position_sample_count ?? 0),
      });
    }
  }

  const completedRuns = completedDays.reduce(
    (total, day) => total + nonNegativeCount(day.completed_runs),
    0,
  );
  const totalsByBrand = new Map(trackedBrands.map((brand) => [brand.id, 0]));
  const positionTotalsByBrand = new Map(
    trackedBrands.map((brand) => [brand.id, { sum: 0, samples: 0 }]),
  );
  let ownedMentionedResponses = 0;
  let ownedPositionSum = 0;
  let ownedPositionSamples = 0;
  for (const day of completedDays) {
    ownedMentionedResponses += ownedMentionsByDate.get(day.metric_date) ?? 0;
    const ownedPosition = ownedPositionsByDate.get(day.metric_date);
    ownedPositionSum += ownedPosition?.sum ?? 0;
    ownedPositionSamples += ownedPosition?.samples ?? 0;
    for (const [brandId, count] of countsByDate.get(day.metric_date) ?? []) {
      totalsByBrand.set(brandId, (totalsByBrand.get(brandId) ?? 0) + count);
    }
    for (const [brandId, position] of positionsByDate.get(day.metric_date) ?? []) {
      const total = positionTotalsByBrand.get(brandId) ?? { sum: 0, samples: 0 };
      total.sum += position.sum;
      total.samples += position.samples;
      positionTotalsByBrand.set(brandId, total);
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
      const position = positionTotalsByBrand.get(brand.id) ?? {
        sum: 0,
        samples: 0,
      };
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
        averagePosition: position.samples
          ? position.sum / position.samples
          : null,
        positionSamples: position.samples,
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
      averagePosition: ownedPositionSamples
        ? ownedPositionSum / ownedPositionSamples
        : null,
      positionSamples: ownedPositionSamples,
    },
    ...competitorMetrics.slice(0, 4),
  ];

  return {
    summary: {
      ownedMentionedResponses,
      ownedAppearances,
      ownedVisibility,
      ownedShareOfVoice,
      ownedAveragePosition: ownedPositionSamples
        ? ownedPositionSum / ownedPositionSamples
        : null,
      ownedPositionSamples,
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
      const dailyPositions = positionsByDate.get(day.metric_date) ??
        new Map<string, { sum: number; samples: number }>();
      const ownedDailyPosition = ownedPositionsByDate.get(day.metric_date) ?? {
        sum: 0,
        samples: 0,
      };
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
            const position = brand.kind === "owned"
              ? ownedDailyPosition
              : dailyPositions.get(brand.id ?? "") ?? { sum: 0, samples: 0 };
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
                averagePosition: position.samples
                  ? position.sum / position.samples
                  : null,
                positionSamples: position.samples,
              } satisfies BrandMetric,
            ];
          }),
        ),
      };
    }),
  };
}

export interface AnalyticsDateRange {
  from: string;
  to: string;
  startTimestamp: string;
  endExclusiveTimestamp: string;
}

function utcDate(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
