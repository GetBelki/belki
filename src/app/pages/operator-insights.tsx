import { Combobox } from "@base-ui/react/combobox";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { PageHeader } from "../components/layout";
import { OperatorDataFailure } from "../components/operator-access";
import { TrendChartLegend } from "../components/trend-chart";
import {
  Card,
  CardHeader,
  EmptyState,
  Select,
  Skeleton,
} from "../components/ui";
import { api } from "../lib/api";
import { insightNumericYAxisMax, insightYAxisMax } from "../lib/chart-scale";
import {
  fanOutMetricValue,
  fanOutSignalGroupValue,
  type FanOutMetric,
  type FanOutSignalGroup,
} from "../lib/operator-fanout";
import {
  TRACKING_SOURCE_LABELS,
  TRACKING_SOURCES,
  type TrackingSource,
} from "../../shared/tracking-sources";

type InsightPeriod = "7d" | "30d" | "90d";
type InsightSource = TrackingSource | "all";
type FanOutSource = "chatgpt" | "gemini" | "all";
type FanOutModel = string;
type FanOutSignalKey =
  | "site"
  | "official"
  | "government"
  | "education"
  | "pricing"
  | "reviews"
  | "best"
  | "top"
  | "comparison"
  | "vs";

interface TrendPoint {
  date: string;
  matchingResponses: number;
  completedResponses: number;
  share: number;
}

interface CitationTrendReport {
  period: InsightPeriod;
  source: InsightSource;
  domain: string | null;
  trend: TrendPoint[];
}

interface FanOutActivityPoint {
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

interface FanOutSignalPoint {
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

interface FanOutTrendReport {
  period: InsightPeriod;
  source: InsightSource;
  model: FanOutModel;
  models: Array<{ value: string; label: string; responses: number }>;
  indexing: boolean;
  remainingSnapshots: number;
  estimatedMinutes: number;
  activity: FanOutActivityPoint[];
  signals: Record<FanOutSignalKey, FanOutSignalPoint[]>;
  yearSignals: Array<{ year: number; trend: FanOutSignalPoint[] }>;
  total: TrendPoint[];
  siteOperator: TrendPoint[];
  reviews: TrendPoint[];
  official: TrendPoint[];
  government: TrendPoint[];
  years: Array<{ year: number; trend: TrendPoint[] }>;
}

interface CitationDomainOption {
  domain: string;
  citedResponses: number;
  citations: number;
}

interface DomainComboboxOption {
  label: string;
  value: string;
}

const PERIOD_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  ...TRACKING_SOURCES.map((source) => ({
    value: source,
    label: TRACKING_SOURCE_LABELS[source],
  })),
];

const FAN_OUT_SOURCE_OPTIONS = [
  { value: "chatgpt", label: TRACKING_SOURCE_LABELS.chatgpt },
  { value: "gemini", label: TRACKING_SOURCE_LABELS.gemini },
  { value: "all", label: "All fan-out sources" },
];

const FAN_OUT_METRIC_OPTIONS = [
  { value: "shareOfFanOuts", label: "Share of fan-outs" },
  { value: "fanOutsPerResponse", label: "Per response" },
  { value: "responseShare", label: "Response prevalence" },
];

const FAN_OUT_GROUP_OPTIONS = [
  { value: "direct-source", label: "Direct source" },
  { value: "commercial-research", label: "Commercial research" },
  { value: "listicle", label: "Listicle" },
  { value: "comparison", label: "Comparison" },
  { value: "years", label: "Years" },
];

const FAN_OUT_SIGNAL_GROUPS: Record<
  Exclude<FanOutSignalGroup, "years">,
  Array<{ key: FanOutSignalKey; label: string }>
> = {
  "direct-source": [
    { key: "site", label: "Site operator" },
    { key: "official", label: "Official" },
    { key: "government", label: "Government domains" },
    { key: "education", label: "Education domains (.edu)" },
  ],
  "commercial-research": [
    { key: "pricing", label: "Pricing" },
    { key: "reviews", label: "Reviews" },
  ],
  listicle: [
    { key: "best", label: "Best" },
    { key: "top", label: "Top" },
  ],
  comparison: [
    { key: "vs", label: "Vs" },
    { key: "comparison", label: "Comparison" },
  ],
};

const FAN_OUT_METRIC_COPY: Record<
  FanOutMetric,
  { label: string; description: string; percentage: boolean }
> = {
  shareOfFanOuts: {
    label: "Share of fan-outs",
    description: "Matching fan-out queries as a share of all fan-out queries.",
    percentage: true,
  },
  fanOutsPerResponse: {
    label: "Fan-outs per response",
    description: "Average matching fan-out queries per response with reported telemetry, including explicit zeroes.",
    percentage: false,
  },
  responseShare: {
    label: "Response prevalence",
    description: "Share of responses with reported telemetry containing at least one matching fan-out query.",
    percentage: true,
  },
};

const YEAR_COLORS = [
  "#18181b",
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#9333ea",
  "#dc2626",
  "#0891b2",
  "#4f46e5",
];

const ALL_DOMAINS_OPTION: DomainComboboxOption = {
  label: "All cited domains",
  value: "",
};

function periodValue(value: string | null): InsightPeriod {
  return value === "7d" || value === "90d" ? value : "30d";
}

function sourceValue(value: string | null): InsightSource {
  return value && TRACKING_SOURCES.includes(value as TrackingSource)
    ? (value as TrackingSource)
    : "all";
}

function fanOutSourceValue(value: string | null): FanOutSource {
  return value === "all" || value === "gemini" ? value : "chatgpt";
}

function fanOutModelValue(value: string | null): FanOutModel {
  return value?.trim() || "all";
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);
  return debouncedValue;
}

function percent(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function decimal(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function insightYAxisTicks(maximum: number): number[] {
  return Array.from({ length: 5 }, (_, index) =>
    Number(((maximum * index) / 4).toFixed(2)),
  );
}

function axisPercent(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function dateLabel(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function tooltipDateLabel(value: ReactNode): string {
  return typeof value === "string" || typeof value === "number"
    ? dateLabel(String(value))
    : "";
}

function isTrendPoint(value: unknown): value is TrendPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<TrendPoint>;
  return (
    typeof point.date === "string" &&
    typeof point.matchingResponses === "number" &&
    typeof point.completedResponses === "number" &&
    typeof point.share === "number"
  );
}

function TrendTooltip({
  active,
  label,
  payload,
}: TooltipContentProps) {
  const point: unknown = payload[0]?.payload;
  if (!active || !isTrendPoint(point)) return null;
  return (
    <div className="operator-chart-tooltip">
      <strong>{tooltipDateLabel(label)}</strong>
      <span>{percent(point.share)}</span>
      <small>
        {point.matchingResponses.toLocaleString()} of{" "}
        {point.completedResponses.toLocaleString()} responses
      </small>
    </div>
  );
}

function TrendChart({
  title,
  description,
  data,
  pending,
  emptyTitle = "No trend data",
}: {
  title: string;
  description: string;
  data: TrendPoint[];
  pending: boolean;
  emptyTitle?: string;
}) {
  const hasResponses = data.some((point) => point.completedResponses > 0);
  const yAxisMax = insightYAxisMax(data.map((point) => point.share));
  return (
    <Card className="operator-insight-card">
      <CardHeader title={title} description={description} />
      <div className="operator-insight-chart">
        {pending ? (
          <Skeleton className="operator-insight-chart-skeleton" />
        ) : !hasResponses ? (
          <EmptyState
            title={emptyTitle}
            description="Completed responses will appear here for the selected period."
          />
        ) : (
          <ResponsiveContainer height="100%" minWidth={0} width="100%">
            <AreaChart accessibilityLayer data={data} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
              <defs>
                <linearGradient id={`operator-${title.replaceAll(" ", "-")}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="#18181b" stopOpacity={0.12} />
                  <stop offset="95%" stopColor="#18181b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#ececf0" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="date"
                interval="preserveStartEnd"
                minTickGap={38}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={dateLabel}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                domain={[0, yAxisMax]}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={(value) => axisPercent(Number(value))}
                tickLine={false}
                ticks={insightYAxisTicks(yAxisMax)}
                width={42}
              />
              <Tooltip content={TrendTooltip} cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }} isAnimationActive={false} />
              <Area
                activeDot={{ fill: "#fff", r: 4, stroke: "#18181b", strokeWidth: 2 }}
                dataKey="share"
                dot={false}
                fill={`url(#operator-${title.replaceAll(" ", "-")})`}
                isAnimationActive={false}
                name="Share"
                stroke="#18181b"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.25}
                type="linear"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

export function YearsChart({
  years,
  pending,
}: {
  years: FanOutTrendReport["years"];
  pending: boolean;
}) {
  const currentYear = new Date().getUTCFullYear();
  const yAxisMax = insightYAxisMax(
    years.flatMap(({ trend }) => trend.map((point) => point.share)),
  );
  const data = useMemo(() => {
    const dates = years[0]?.trend.map((point) => point.date) ?? [];
    return dates.map((date, index) => ({
      date,
      ...Object.fromEntries(
        years.map(({ year, trend }) => [String(year), trend[index]?.share ?? 0]),
      ),
    }));
  }, [years]);
  return (
    <Card className="operator-insight-card">
      <CardHeader
        title="Years"
        description={`Share of responses with reported telemetry containing a fan-out query with each standalone year from 2025 through ${currentYear}.`}
      />
      <div className="operator-insight-chart">
        {pending ? (
          <Skeleton className="operator-insight-chart-skeleton" />
        ) : !years.length ? (
          <EmptyState
            title="No year queries"
            description={`Related queries containing years from 2025 through ${currentYear} will appear here.`}
          />
        ) : (
          <ResponsiveContainer height="100%" minWidth={0} width="100%">
            <LineChart accessibilityLayer data={data} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
              <CartesianGrid stroke="#ececf0" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="date"
                interval="preserveStartEnd"
                minTickGap={38}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={dateLabel}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                domain={[0, yAxisMax]}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={(value) => axisPercent(Number(value))}
                tickLine={false}
                ticks={insightYAxisTicks(yAxisMax)}
                width={42}
              />
              <Tooltip
                cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }}
                formatter={(value, name) => [percent(Number(value)), String(name)]}
                isAnimationActive={false}
                labelFormatter={tooltipDateLabel}
              />
              <Legend iconSize={10} iconType="line" />
              {years.map(({ year }, index) => (
                <Line
                  dataKey={String(year)}
                  activeDot={{ fill: "#fff", r: 3.5, strokeWidth: 2 }}
                  dot={false}
                  isAnimationActive={false}
                  key={year}
                  name={String(year)}
                  stroke={YEAR_COLORS[index % YEAR_COLORS.length]}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.25}
                  type="linear"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

function isFanOutActivityPoint(value: unknown): value is FanOutActivityPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<FanOutActivityPoint>;
  return typeof point.date === "string"
    && typeof point.completedResponses === "number"
    && typeof point.reportedResponses === "number"
    && typeof point.unavailableResponses === "number"
    && typeof point.responsesWithFanOut === "number"
    && typeof point.totalFanOuts === "number"
    && typeof point.responseShare === "number"
    && typeof point.fanOutsPerResponse === "number"
    && typeof point.telemetryCoverage === "number";
}

function ActivityTooltip({
  active,
  label,
  payload,
  metric,
}: TooltipContentProps & {
  metric: "responseShare" | "fanOutsPerResponse" | "telemetryCoverage";
}) {
  const point: unknown = payload[0]?.payload;
  if (!active || !isFanOutActivityPoint(point)) return null;
  const isPercentage = metric !== "fanOutsPerResponse";
  const value = point[metric];
  return (
    <div className="operator-chart-tooltip">
      <strong>{tooltipDateLabel(label)}</strong>
      <span>{isPercentage ? percent(value) : decimal(value)}</span>
      <small>
        {metric === "telemetryCoverage"
          ? `${point.reportedResponses.toLocaleString()} of ${point.completedResponses.toLocaleString()} responses reported telemetry`
          : metric === "responseShare"
            ? `${point.responsesWithFanOut.toLocaleString()} of ${point.reportedResponses.toLocaleString()} reported responses`
            : `${point.totalFanOuts.toLocaleString()} fan-outs across ${point.reportedResponses.toLocaleString()} reported responses`}
      </small>
    </div>
  );
}

function FanOutResponseStatusTooltip({
  active,
  label,
  payload,
}: TooltipContentProps) {
  const point: unknown = payload[0]?.payload;
  if (!active || !isFanOutActivityPoint(point)) return null;
  const responsesWithoutFanOut = Math.max(
    0,
    point.reportedResponses - point.responsesWithFanOut,
  );
  return (
    <div className="operator-chart-tooltip operator-response-status-tooltip">
      <strong>{tooltipDateLabel(label)}</strong>
      <div className="operator-response-status-tooltip-row">
        <i style={{ background: "#18181b" }} />
        <span>With fan-out</span>
        <b>{point.responsesWithFanOut.toLocaleString()}</b>
      </div>
      <div className="operator-response-status-tooltip-row">
        <i style={{ background: "#a1a1aa" }} />
        <span>Reported none</span>
        <b>{responsesWithoutFanOut.toLocaleString()}</b>
      </div>
      <div className="operator-response-status-tooltip-row">
        <i style={{ background: "#f59e0b" }} />
        <span>Telemetry unavailable</span>
        <b>{point.unavailableResponses.toLocaleString()}</b>
      </div>
      <small>{point.completedResponses.toLocaleString()} completed responses</small>
    </div>
  );
}

export function FanOutResponseStatusChart({
  data,
  pending,
}: {
  data: FanOutActivityPoint[];
  pending: boolean;
}) {
  const chartData = data.map((point) => ({
    ...point,
    responsesWithoutFanOut: Math.max(
      0,
      point.reportedResponses - point.responsesWithFanOut,
    ),
  }));
  const hasResponses = data.some((point) => point.completedResponses > 0);
  const yAxisMax = insightNumericYAxisMax(
    data.map((point) => point.completedResponses),
  );
  return (
    <Card className="operator-insight-card">
      <CardHeader
        title="Fan-out response status"
        description="Daily completed responses split by fan-out result. Unavailable means the provider did not return fan-out telemetry."
      />
      <div className="operator-insight-chart">
        {pending ? (
          <Skeleton className="operator-insight-chart-skeleton" />
        ) : !hasResponses ? (
          <EmptyState
            title="No fan-out activity"
            description="Completed responses will appear here for the selected period."
          />
        ) : (
          <ResponsiveContainer height="100%" minWidth={0} width="100%">
            <BarChart accessibilityLayer data={chartData} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
              <CartesianGrid stroke="#ececf0" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="date"
                interval="preserveStartEnd"
                minTickGap={38}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={dateLabel}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                domain={[0, yAxisMax]}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={(value) => Number(value).toLocaleString()}
                tickLine={false}
                ticks={insightYAxisTicks(yAxisMax)}
                width={42}
              />
              <Tooltip
                content={FanOutResponseStatusTooltip}
                cursor={{ fill: "rgba(161, 161, 170, 0.12)" }}
                isAnimationActive={false}
              />
              <Bar
                dataKey="responsesWithFanOut"
                fill="#18181b"
                isAnimationActive={false}
                maxBarSize={28}
                name="With fan-out"
                stackId="responses"
              />
              <Bar
                dataKey="responsesWithoutFanOut"
                fill="#a1a1aa"
                isAnimationActive={false}
                maxBarSize={28}
                name="Reported none"
                stackId="responses"
              />
              <Bar
                dataKey="unavailableResponses"
                fill="#f59e0b"
                isAnimationActive={false}
                maxBarSize={28}
                name="Telemetry unavailable"
                stackId="responses"
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {!pending && hasResponses ? (
        <div aria-label="Response status" className="operator-response-status-legend" role="group">
          <span><i style={{ background: "#18181b" }} />With fan-out</span>
          <span><i style={{ background: "#a1a1aa" }} />Reported none</span>
          <span><i style={{ background: "#f59e0b" }} />Telemetry unavailable</span>
        </div>
      ) : null}
    </Card>
  );
}

function FanOutActivityChart({
  title,
  description,
  data,
  metric,
  pending,
}: {
  title: string;
  description: string;
  data: FanOutActivityPoint[];
  metric: "responseShare" | "fanOutsPerResponse" | "telemetryCoverage";
  pending: boolean;
}) {
  const isShare = metric !== "fanOutsPerResponse";
  const values = data.map((point) => point[metric]);
  const chartData = data.map((point) => ({
    ...point,
    [metric]: point.reportedResponses > 0 ? point[metric] : null,
  }));
  const yAxisMax = isShare
    ? insightYAxisMax(values)
    : insightNumericYAxisMax(values);
  const hasResponses = data.some((point) => point.completedResponses > 0);
  const gradientId = `operator-activity-${metric}`;
  return (
    <Card className="operator-insight-card">
      <CardHeader title={title} description={description} />
      <div className="operator-insight-chart">
        {pending ? (
          <Skeleton className="operator-insight-chart-skeleton" />
        ) : !hasResponses ? (
          <EmptyState
            title="No fan-out activity"
            description="Completed responses will appear here for the selected period."
          />
        ) : (
          <ResponsiveContainer height="100%" minWidth={0} width="100%">
            <AreaChart accessibilityLayer data={chartData} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="#18181b" stopOpacity={0.12} />
                  <stop offset="95%" stopColor="#18181b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#ececf0" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="date"
                interval="preserveStartEnd"
                minTickGap={38}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={dateLabel}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                domain={[0, yAxisMax]}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={(value) => isShare
                  ? axisPercent(Number(value))
                  : Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                tickLine={false}
                ticks={insightYAxisTicks(yAxisMax)}
                width={42}
              />
              <Tooltip
                content={(props) => <ActivityTooltip {...props} metric={metric} />}
                cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }}
                isAnimationActive={false}
              />
              <Area
                activeDot={{ fill: "#fff", r: 4, stroke: "#18181b", strokeWidth: 2 }}
                dataKey={metric}
                dot={false}
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
                name={title}
                stroke="#18181b"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.25}
                type="linear"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

function isFanOutSignalPoint(value: unknown): value is FanOutSignalPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<FanOutSignalPoint>;
  return typeof point.date === "string"
    && typeof point.matchingFanOuts === "number"
    && typeof point.totalFanOuts === "number"
    && typeof point.matchingResponses === "number"
    && typeof point.completedResponses === "number"
    && typeof point.reportedResponses === "number"
    && typeof point.shareOfFanOuts === "number"
    && typeof point.fanOutsPerResponse === "number"
    && typeof point.responseShare === "number";
}

function SignalTooltip({
  active,
  label,
  payload,
  metric,
}: TooltipContentProps & { metric: FanOutMetric }) {
  if (!active || !payload.length) return null;
  return (
    <div className="operator-chart-tooltip operator-signal-tooltip">
      <strong>{tooltipDateLabel(label)}</strong>
      {payload.map((entry) => {
        const dataKey = String(entry.dataKey ?? "");
        const chartPoint: unknown = entry.payload;
        const detail: unknown = chartPoint && typeof chartPoint === "object"
          ? (chartPoint as Record<string, unknown>)[`${dataKey}Detail`]
          : null;
        if (!isFanOutSignalPoint(detail)) return null;
        const value = detail[metric];
        const denominator = metric === "shareOfFanOuts"
          ? `${detail.matchingFanOuts.toLocaleString()} of ${detail.totalFanOuts.toLocaleString()} fan-outs`
          : metric === "fanOutsPerResponse"
            ? `${detail.matchingFanOuts.toLocaleString()} fan-outs across ${detail.reportedResponses.toLocaleString()} reported responses`
            : `${detail.matchingResponses.toLocaleString()} of ${detail.reportedResponses.toLocaleString()} reported responses`;
        return (
          <div className="operator-signal-tooltip-row" key={dataKey}>
            <i style={{ background: entry.color }} />
            <span>{String(entry.name)}</span>
            <b>{FAN_OUT_METRIC_COPY[metric].percentage ? percent(value) : decimal(value)}</b>
            <small>{denominator}</small>
          </div>
        );
      })}
    </div>
  );
}

export function FanOutSignalExplorer({
  activity,
  group,
  metric,
  onGroupChange,
  pending,
  signals,
  yearSignals,
}: {
  activity: FanOutActivityPoint[];
  group: FanOutSignalGroup;
  metric: FanOutMetric;
  onGroupChange: (group: FanOutSignalGroup) => void;
  pending: boolean;
  signals: FanOutTrendReport["signals"];
  yearSignals: FanOutTrendReport["yearSignals"];
}) {
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());
  const [highlightedSeries, setHighlightedSeries] = useState<string | null>(null);
  const series = (group === "years"
    ? yearSignals.map(({ year, trend }) => ({
        id: `year-${year}`,
        label: String(year),
        trend,
      }))
    : FAN_OUT_SIGNAL_GROUPS[group].map(({ key, label }) => ({
        id: key,
        label,
        trend: signals[key] ?? [],
      }))).map((item, index) => ({
        ...item,
        color: YEAR_COLORS[index % YEAR_COLORS.length]!,
      }));
  const visibleSeries = series.filter(({ id }) => !hiddenSeries.has(id));
  const dates = activity.map((point) => point.date);
  const chartData = dates.map((date, index) => {
    const point: Record<string, unknown> = { date };
    for (const { id, trend } of series) {
      point[id] = trend[index]?.[metric] ?? 0;
      point[`${id}Detail`] = trend[index] ?? null;
    }
    return point;
  });
  const values = visibleSeries.flatMap(({ trend }) =>
    trend.map((point) => point[metric])
  );
  const metricCopy = FAN_OUT_METRIC_COPY[metric];
  const yAxisMax = metricCopy.percentage
    ? insightYAxisMax(values)
    : insightNumericYAxisMax(values);
  const hasResponses = activity.some((point) => point.completedResponses > 0);
  return (
    <Card className="operator-insight-card operator-signal-card">
      <CardHeader
        title="Fan-out signals"
        description={metricCopy.description}
        action={(
          <div className="operator-signal-group-control">
            <span className="operator-insight-filter-label">Signal group</span>
            <Select
              ariaLabel="Fan-out signal group"
              onValueChange={(value) => onGroupChange(fanOutSignalGroupValue(value))}
              options={FAN_OUT_GROUP_OPTIONS}
              value={group}
            />
          </div>
        )}
      />
      <div className="operator-insight-chart operator-signal-chart">
        {pending ? (
          <Skeleton className="operator-insight-chart-skeleton" />
        ) : !hasResponses ? (
          <EmptyState
            title="No fan-out signals"
            description="Completed responses will appear here for the selected period."
          />
        ) : !series.length ? (
          <EmptyState
            title="No year signals"
            description="Standalone years from 2025 through the current year will appear here."
          />
        ) : (
          <ResponsiveContainer height="100%" minWidth={0} width="100%">
            <LineChart accessibilityLayer data={chartData} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
              <CartesianGrid stroke="#ececf0" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="date"
                interval="preserveStartEnd"
                minTickGap={38}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={dateLabel}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                domain={[0, yAxisMax]}
                tick={{ fill: "#71717a", fontSize: 10 }}
                tickFormatter={(value) => metricCopy.percentage
                  ? axisPercent(Number(value))
                  : Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                tickLine={false}
                ticks={insightYAxisTicks(yAxisMax)}
                width={42}
              />
              <Tooltip
                content={(props) => <SignalTooltip {...props} metric={metric} />}
                cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }}
                isAnimationActive={false}
              />
              {visibleSeries.map(({ color, id, label }) => (
                <Line
                  dataKey={id}
                  activeDot={{ fill: "#fff", r: 3.5, strokeWidth: 2 }}
                  dot={false}
                  isAnimationActive={false}
                  key={id}
                  name={label}
                  opacity={highlightedSeries !== null && highlightedSeries !== id
                    ? 0.16
                    : 1}
                  stroke={color}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.25}
                  type="linear"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      {!pending && hasResponses && series.length ? (
        <TrendChartLegend
          hiddenKeys={hiddenSeries}
          highlightedKey={highlightedSeries}
          items={series.map(({ color, id, label }) => ({
            color,
            key: id,
            label,
          }))}
          onHighlightedKeyChange={setHighlightedSeries}
          onToggle={(id) => {
            setHiddenSeries((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
        />
      ) : null}
      <p className="operator-signal-note">
        Select legend items to show or hide them. Signals can overlap when one
        fan-out query matches more than one category.
      </p>
    </Card>
  );
}

function Filters({
  period,
  source,
  onPeriodChange,
  onSourceChange,
  children,
}: {
  period: InsightPeriod;
  source: InsightSource;
  onPeriodChange: (period: InsightPeriod) => void;
  onSourceChange: (source: InsightSource) => void;
  children?: ReactNode;
}) {
  return (
    <div className={`operator-insight-filters${children ? " has-domain" : ""}`}>
      {children}
      <div className="operator-insight-filter-field">
        <span className="operator-insight-filter-label">Source</span>
        <Select
          ariaLabel="Tracking source"
          onValueChange={(value) => onSourceChange(sourceValue(value))}
          options={SOURCE_OPTIONS}
          value={source}
        />
      </div>
      <div className="operator-insight-filter-field">
        <span className="operator-insight-filter-label">Period</span>
        <Select
          ariaLabel="Trend period"
          onValueChange={(value) => onPeriodChange(periodValue(value))}
          options={PERIOD_OPTIONS}
          value={period}
        />
      </div>
    </div>
  );
}

function FanOutFilters({
  metric,
  model,
  modelOptions,
  onMetricChange,
  onModelChange,
  onPeriodChange,
  onSourceChange,
  period,
  source,
}: {
  metric: FanOutMetric;
  model: FanOutModel;
  modelOptions: Array<{ value: string; label: string }>;
  onMetricChange: (metric: FanOutMetric) => void;
  onModelChange: (model: FanOutModel) => void;
  onPeriodChange: (period: InsightPeriod) => void;
  onSourceChange: (source: FanOutSource) => void;
  period: InsightPeriod;
  source: FanOutSource;
}) {
  return (
    <div className="operator-insight-filters operator-fanout-filters">
      <div className="operator-insight-filter-field">
        <span className="operator-insight-filter-label">Source</span>
        <Select
          ariaLabel="Fan-out source"
          onValueChange={(value) => onSourceChange(fanOutSourceValue(value))}
          options={FAN_OUT_SOURCE_OPTIONS}
          value={source}
        />
      </div>
      <div className="operator-insight-filter-field">
        <span className="operator-insight-filter-label">Model</span>
        <Select
          ariaLabel="Fan-out model"
          onValueChange={(value) => onModelChange(fanOutModelValue(value))}
          options={modelOptions}
          value={model}
        />
      </div>
      <div className="operator-insight-filter-field">
        <span className="operator-insight-filter-label">Period</span>
        <Select
          ariaLabel="Fan-out trend period"
          onValueChange={(value) => onPeriodChange(periodValue(value))}
          options={PERIOD_OPTIONS}
          value={period}
        />
      </div>
      <div className="operator-insight-filter-field">
        <span className="operator-insight-filter-label">Metric</span>
        <Select
          ariaLabel="Fan-out metric"
          onValueChange={(value) => onMetricChange(fanOutMetricValue(value))}
          options={FAN_OUT_METRIC_OPTIONS}
          value={metric}
        />
      </div>
    </div>
  );
}

function useInsightFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = periodValue(searchParams.get("period"));
  const source = sourceValue(searchParams.get("source"));
  const update = (values: { period?: InsightPeriod; source?: InsightSource; domain?: string | null }) => {
    const next = new URLSearchParams(searchParams);
    if (values.period !== undefined) {
      if (values.period === "30d") next.delete("period");
      else next.set("period", values.period);
    }
    if (values.source !== undefined) {
      if (values.source === "all") next.delete("source");
      else next.set("source", values.source);
    }
    if (values.domain !== undefined) {
      if (values.domain) next.set("domain", values.domain);
      else next.delete("domain");
    }
    setSearchParams(next, { replace: true });
  };
  return { period, searchParams, source, update };
}

function useFanOutFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = periodValue(searchParams.get("period"));
  const source = fanOutSourceValue(searchParams.get("source"));
  const model = fanOutModelValue(searchParams.get("model"));
  const metric = fanOutMetricValue(searchParams.get("metric"));
  const group = fanOutSignalGroupValue(searchParams.get("group"));
  const update = (values: {
    period?: InsightPeriod;
    source?: FanOutSource;
    model?: FanOutModel;
    metric?: FanOutMetric;
    group?: FanOutSignalGroup;
  }) => {
    const next = new URLSearchParams(searchParams);
    if (values.period !== undefined) {
      if (values.period === "30d") next.delete("period");
      else next.set("period", values.period);
    }
    if (values.source !== undefined) {
      if (values.source === "chatgpt") next.delete("source");
      else next.set("source", values.source);
    }
    if (values.model !== undefined) {
      if (values.model === "all") next.delete("model");
      else next.set("model", values.model);
    }
    if (values.metric !== undefined) {
      if (values.metric === "shareOfFanOuts") next.delete("metric");
      else next.set("metric", values.metric);
    }
    if (values.group !== undefined) {
      if (values.group === "direct-source") next.delete("group");
      else next.set("group", values.group);
    }
    setSearchParams(next, { replace: true });
  };
  return { group, metric, model, period, source, update };
}

export function CitationDomainCombobox({
  isFetching,
  onSearchChange,
  onValueChange,
  options,
  searchValue,
  value,
}: {
  isFetching: boolean;
  onSearchChange: (value: string) => void;
  onValueChange: (option: DomainComboboxOption | null) => void;
  options: DomainComboboxOption[];
  searchValue: string;
  value: DomainComboboxOption;
}) {
  return (
    <Combobox.Root
      autoHighlight
      inputValue={searchValue}
      isItemEqualToValue={(item, selected) => item.value === selected.value}
      items={options}
      onInputValueChange={(nextValue, details) => {
        if (details.reason !== "item-press") onSearchChange(nextValue);
      }}
      onOpenChange={(open) => {
        if (!open) onSearchChange("");
      }}
      onValueChange={onValueChange}
      value={value}
    >
      <div className="operator-domain-combobox">
        <Combobox.Label className="operator-insight-filter-label">
          Cited domain
        </Combobox.Label>
        <Combobox.Trigger className="operator-combobox-trigger">
          <Combobox.Value />
          <Combobox.Icon className="operator-combobox-trigger-icon">
            <ChevronsUpDown size={15} />
          </Combobox.Icon>
        </Combobox.Trigger>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner
          align="start"
          className="operator-combobox-positioner"
          sideOffset={6}
        >
          <Combobox.Popup
            aria-label="Select cited domain"
            className="operator-combobox-popup"
          >
            <div className="operator-combobox-search">
              <Search aria-hidden="true" size={15} />
              <Combobox.Input
                aria-label="Search cited domains"
                autoFocus
                className="operator-combobox-search-input"
                placeholder="Search domains..."
              />
              {isFetching ? (
                <LoaderCircle
                  aria-label="Searching domains"
                  className="operator-combobox-spinner"
                  size={15}
                />
              ) : null}
            </div>
            <div className="operator-combobox-viewport">
              <Combobox.Empty className="operator-combobox-empty">
                No domains found
              </Combobox.Empty>
              <Combobox.List className="operator-combobox-list">
                {(option: DomainComboboxOption) => (
                  <Combobox.Item
                    className="operator-combobox-item"
                    key={option.value || "all-domains"}
                    value={option}
                  >
                    <Combobox.ItemIndicator className="operator-combobox-item-indicator">
                      <Check size={14} />
                    </Combobox.ItemIndicator>
                    <span>{option.label}</span>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </div>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

export function OperatorCitationTrendsPage() {
  const { period, searchParams, source, update } = useInsightFilters();
  const domain = searchParams.get("domain")?.trim().toLowerCase() ?? "";
  const [domainSearch, setDomainSearch] = useState("");
  const debouncedDomainSearch = useDebouncedValue(domainSearch.trim(), 180);
  const params = new URLSearchParams({ period, source });
  if (domain) params.set("domain", domain);
  const report = useQuery({
    queryKey: ["operator-citation-trends", period, source, domain],
    queryFn: () =>
      api<CitationTrendReport>(`/operator/insights/citations?${params}`),
  });
  const domainParams = new URLSearchParams({ period, source, limit: "50" });
  if (debouncedDomainSearch) domainParams.set("search", debouncedDomainSearch);
  const domains = useQuery({
    queryKey: ["operator-citation-domains", period, source, debouncedDomainSearch],
    queryFn: () =>
      api<CitationDomainOption[]>(
        `/operator/insights/citation-domains?${domainParams}`,
      ),
    placeholderData: keepPreviousData,
  });
  const domainOptions = useMemo(() => {
    const options = [ALL_DOMAINS_OPTION];
    const seen = new Set([""]);
    if (domain) {
      options.push({ label: domain, value: domain });
      seen.add(domain);
    }
    for (const option of domains.data ?? []) {
      if (seen.has(option.domain)) continue;
      seen.add(option.domain);
      options.push({ label: option.domain, value: option.domain });
    }
    return options;
  }, [domain, domains.data]);
  const selectedDomain = domainOptions.find((option) => option.value === domain)
    ?? ALL_DOMAINS_OPTION;
  if (report.isError) {
    return (
      <OperatorDataFailure
        error={report.error}
        onRetry={() => {
          void report.refetch();
          void domains.refetch();
        }}
      />
    );
  }
  return (
    <div className="page operator-insights-page">
      <PageHeader
        title="Citation trends"
        description="Daily citation share aggregated across every retained project."
      />
      <Filters
        onPeriodChange={(value) => update({ period: value })}
        onSourceChange={(value) => update({ source: value })}
        period={period}
        source={source}
      >
        <CitationDomainCombobox
          isFetching={domains.isFetching}
          onSearchChange={setDomainSearch}
          onValueChange={(option) => {
            update({ domain: option?.value || null });
            setDomainSearch("");
          }}
          options={domainOptions}
          searchValue={domainSearch}
          value={selectedDomain}
        />
      </Filters>
      <TrendChart
        data={report.data?.trend ?? []}
        description={domain
          ? `Share of completed responses citing ${domain}.`
          : "Share of completed responses containing at least one citation."}
        pending={report.isPending}
        title={domain ? domain : "All cited domains"}
      />
    </div>
  );
}

export function OperatorFanOutTrendsPage() {
  const { group, metric, model, period, source, update } = useFanOutFilters();
  const params = new URLSearchParams({ period, source, model });
  const report = useQuery({
    queryKey: ["operator-fan-out-trends", period, source, model],
    queryFn: () =>
      api<FanOutTrendReport>(`/operator/insights/fan-out?${params}`),
    refetchInterval: (query) => query.state.data?.indexing ? 15_000 : false,
  });
  const data = report.data;
  const indexing = data?.indexing ?? false;
  const remainingSnapshots = data?.remainingSnapshots ?? 0;
  const estimatedMinutes = data?.estimatedMinutes ?? 0;
  const modelOptions = useMemo(() => {
    const options = [{ value: "all", label: "All models" }];
    const seen = new Set(["all"]);
    for (const option of data?.models ?? []) {
      if (seen.has(option.value)) continue;
      seen.add(option.value);
      options.push({
        value: option.value,
        label: `${option.label} (${option.responses.toLocaleString()})`,
      });
    }
    if (!seen.has(model)) {
      options.push({
        value: model,
        label: model === "__unreported__" ? "Model not reported" : model,
      });
    }
    return options;
  }, [data?.models, model]);
  const unavailableResponses = (data?.activity ?? []).reduce(
    (total, point) => total + point.unavailableResponses,
    0,
  );
  if (report.isError) {
    return (
      <OperatorDataFailure
        error={report.error}
        onRetry={() => void report.refetch()}
      />
    );
  }
  return (
    <div className="page operator-insights-page">
      <PageHeader
        title="Fan-out query trends"
        description="Daily fan-out behavior aggregated across every retained project."
      />
      <FanOutFilters
        metric={metric}
        model={model}
        modelOptions={modelOptions}
        onMetricChange={(value) => update({ metric: value })}
        onModelChange={(value) => update({ model: value })}
        onPeriodChange={(value) => update({ period: value })}
        onSourceChange={(value) => update({ source: value, model: "all" })}
        period={period}
        source={source}
      />
      {indexing ? (
        <Card className="operator-insight-card operator-indexing-card">
          <EmptyState
            title="Preparing fan-out history"
            description={`${remainingSnapshots.toLocaleString()} responses in this view still need classification. Estimated completion: about ${estimatedMinutes} ${estimatedMinutes === 1 ? "minute" : "minutes"}. This page refreshes automatically.`}
          />
        </Card>
      ) : (
        <>
          {unavailableResponses > 0 ? (
            <div className="operator-telemetry-notice" role="status">
              <strong>Partial fan-out telemetry</strong>
              <span>
                {unavailableResponses.toLocaleString()} {unavailableResponses === 1
                  ? "response did"
                  : "responses did"} not report fan-out telemetry. They are
                shown as unavailable in response status and excluded from
                fan-out rates, so missing provider data is not counted as zero.
              </span>
            </div>
          ) : null}
          <div className="operator-insight-grid operator-fanout-activity-grid">
            <FanOutResponseStatusChart
              data={data?.activity ?? []}
              pending={report.isPending}
            />
            <FanOutActivityChart
              data={data?.activity ?? []}
              description="Average unique fan-out queries per response with reported telemetry. Explicit zeroes are included; gaps mean no telemetry was reported that day."
              metric="fanOutsPerResponse"
              pending={report.isPending}
              title="Fan-outs per response"
            />
          </div>
          <FanOutSignalExplorer
            activity={data?.activity ?? []}
            group={group}
            metric={metric}
            onGroupChange={(value) => update({ group: value })}
            pending={report.isPending}
            signals={data?.signals ?? {
              site: [],
              official: [],
              government: [],
              education: [],
              pricing: [],
              reviews: [],
              best: [],
              top: [],
              comparison: [],
              vs: [],
            }}
            yearSignals={data?.yearSignals ?? []}
          />
        </>
      )}
    </div>
  );
}
