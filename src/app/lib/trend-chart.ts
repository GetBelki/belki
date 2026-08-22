export type TrendDatum = Record<string, string | number | null | undefined>;

export interface PercentageChartScale {
  domain: [number, number];
  ticks: number[];
}

export interface TrendWindowSummary {
  value: number;
  change: number | null;
}

const PERCENTAGE_SCALES: PercentageChartScale[] = [
  { domain: [0, 10], ticks: [0, 2.5, 5, 7.5, 10] },
  { domain: [0, 20], ticks: [0, 5, 10, 15, 20] },
  { domain: [0, 30], ticks: [0, 10, 20, 30] },
  { domain: [0, 40], ticks: [0, 10, 20, 30, 40] },
  { domain: [0, 50], ticks: [0, 10, 20, 30, 40, 50] },
  { domain: [0, 60], ticks: [0, 15, 30, 45, 60] },
  { domain: [0, 75], ticks: [0, 25, 50, 75] },
  { domain: [0, 100], ticks: [0, 25, 50, 75, 100] },
];

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function percentageChartScale(
  data: readonly TrendDatum[],
  seriesKeys: readonly string[],
): PercentageChartScale {
  const values = data.flatMap((point) =>
    seriesKeys
      .map((key) => finiteNumber(point[key]))
      .filter((value): value is number => value !== null),
  );
  const maximum = Math.max(0, ...values);
  const paddedMaximum = maximum === 0 ? 10 : maximum * 1.08;
  return PERCENTAGE_SCALES.find(
    ({ domain }) => paddedMaximum <= domain[1],
  ) ?? PERCENTAGE_SCALES[PERCENTAGE_SCALES.length - 1]!;
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function trendWindowSummary(
  data: readonly TrendDatum[],
  seriesKey: string,
  windowSize = 7,
): TrendWindowSummary | null {
  if (!Number.isInteger(windowSize) || windowSize < 1) return null;
  const values = data
    .map((point) => finiteNumber(point[seriesKey]))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  const currentValues = values.slice(-windowSize);
  const previousValues = values.slice(-windowSize * 2, -windowSize);
  const value = average(currentValues);
  return {
    value,
    change:
      currentValues.length === windowSize && previousValues.length === windowSize
        ? value - average(previousValues)
        : null,
  };
}

export function previousTrendValue(
  data: readonly TrendDatum[],
  chartDate: string,
  seriesKey: string,
): number | null {
  const index = data.findIndex((point) => point.metric_date === chartDate);
  if (index < 1) return null;
  return finiteNumber(data[index - 1]?.[seriesKey]);
}

export function shortChartDate(value: string | number): string {
  const date = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return date;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

export function toggleTrendSeries(
  hiddenKeys: ReadonlySet<string>,
  seriesKey: string,
  allSeriesKeys: readonly string[],
): Set<string> {
  const next = new Set(hiddenKeys);
  if (next.has(seriesKey)) {
    next.delete(seriesKey);
    return next;
  }
  const visibleCount = allSeriesKeys.filter((key) => !next.has(key)).length;
  if (visibleCount > 1) next.add(seriesKey);
  return next;
}

export function mobileHiddenTrendSeries(
  series: readonly { key: string; primary?: boolean }[],
  comparisonLimit = 2,
): Set<string> {
  const visible = new Set(
    series.filter(({ primary }) => primary).map(({ key }) => key),
  );
  let visibleComparisons = 0;
  for (const item of series) {
    if (!item.primary && visibleComparisons < comparisonLimit) {
      visible.add(item.key);
      visibleComparisons += 1;
    }
  }
  return new Set(
    series.filter(({ key }) => !visible.has(key)).map(({ key }) => key),
  );
}
