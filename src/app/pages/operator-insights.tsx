import { Combobox } from "@base-ui/react/combobox";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Area,
  AreaChart,
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
import {
  Card,
  CardHeader,
  EmptyState,
  Select,
  Skeleton,
} from "../components/ui";
import { api } from "../lib/api";
import {
  TRACKING_SOURCE_LABELS,
  TRACKING_SOURCES,
  type TrackingSource,
} from "../../shared/tracking-sources";

type InsightPeriod = "7d" | "30d" | "90d";
type InsightSource = TrackingSource | "all";

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

interface FanOutTrendReport {
  period: InsightPeriod;
  source: InsightSource;
  indexing: boolean;
  remainingSnapshots: number;
  estimatedMinutes: number;
  total: TrendPoint[];
  siteOperator: TrendPoint[];
  reviews: TrendPoint[];
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
            <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id={`operator-${title.replaceAll(" ", "-")}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="#18181b" stopOpacity={0.12} />
                  <stop offset="95%" stopColor="#18181b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#e4e4e7" strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="date"
                minTickGap={24}
                tick={{ fill: "#71717a", fontSize: 11 }}
                tickFormatter={dateLabel}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                domain={[0, 100]}
                tick={{ fill: "#71717a", fontSize: 11 }}
                tickFormatter={(value) => `${value}%`}
                tickLine={false}
                ticks={[0, 25, 50, 75, 100]}
                width={42}
              />
              <Tooltip content={TrendTooltip} />
              <Area
                dataKey="share"
                dot={{ fill: "#fff", r: 2.5, stroke: "#18181b", strokeWidth: 2 }}
                fill={`url(#operator-${title.replaceAll(" ", "-")})`}
                isAnimationActive={false}
                name="Share"
                stroke="#18181b"
                strokeWidth={2.25}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

function YearsChart({
  years,
  pending,
}: {
  years: FanOutTrendReport["years"];
  pending: boolean;
}) {
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
        description="Share of completed responses with related queries containing each standalone year from 2025 onward."
      />
      <div className="operator-insight-chart">
        {pending ? (
          <Skeleton className="operator-insight-chart-skeleton" />
        ) : !years.length ? (
          <EmptyState
            title="No year queries"
            description="Related queries containing years from 2025 onward will appear here."
          />
        ) : (
          <ResponsiveContainer height="100%" minWidth={0} width="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
              <CartesianGrid stroke="#e4e4e7" strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="date"
                minTickGap={24}
                tick={{ fill: "#71717a", fontSize: 11 }}
                tickFormatter={dateLabel}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                domain={[0, 100]}
                tick={{ fill: "#71717a", fontSize: 11 }}
                tickFormatter={(value) => `${value}%`}
                tickLine={false}
                ticks={[0, 25, 50, 75, 100]}
                width={42}
              />
              <Tooltip
                contentStyle={{ border: "1px solid #d4d4d8", borderRadius: 8 }}
                formatter={(value, name) => [percent(Number(value)), String(name)]}
                labelFormatter={tooltipDateLabel}
              />
              <Legend />
              {years.map(({ year }, index) => (
                <Line
                  dataKey={String(year)}
                  dot={{ r: 2 }}
                  isAnimationActive={false}
                  key={year}
                  name={String(year)}
                  stroke={YEAR_COLORS[index % YEAR_COLORS.length]}
                  strokeWidth={2.25}
                  type="monotone"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
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
  const { period, source, update } = useInsightFilters();
  const params = new URLSearchParams({ period, source });
  const report = useQuery({
    queryKey: ["operator-fan-out-trends", period, source],
    queryFn: () =>
      api<FanOutTrendReport>(`/operator/insights/fan-out?${params}`),
    refetchInterval: (query) => query.state.data?.indexing ? 15_000 : false,
  });
  const data = report.data;
  const indexing = data?.indexing ?? false;
  const remainingSnapshots = data?.remainingSnapshots ?? 0;
  const estimatedMinutes = data?.estimatedMinutes ?? 0;
  return (
    <div className="page operator-insights-page">
      <PageHeader
        title="Fan-out query trends"
        description="Daily related-query share aggregated across every retained project."
      />
      <Filters
        onPeriodChange={(value) => update({ period: value })}
        onSourceChange={(value) => update({ source: value })}
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
        <div className="operator-insight-grid">
          <TrendChart
            data={data?.total ?? []}
            description="Share of completed responses containing at least one related query."
            pending={report.isPending}
            title="Total fan-out"
          />
          <TrendChart
            data={data?.siteOperator ?? []}
            description="Share of completed responses with at least one related query using site:."
            pending={report.isPending}
            title="Site operator"
          />
          <TrendChart
            data={data?.reviews ?? []}
            description="Share of completed responses with related queries containing review or reviews."
            pending={report.isPending}
            title="Reviews"
          />
          <YearsChart pending={report.isPending} years={data?.years ?? []} />
        </div>
      )}
    </div>
  );
}
