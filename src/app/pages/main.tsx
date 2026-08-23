import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChartPie,
  Eye,
  ExternalLink,
  Plus,
  RefreshCw,
  Scale,
  Search,
  ShoppingBag,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ReferenceLine,
  type TooltipPayload,
} from "recharts";
import { NoProject, PageHeader } from "../components/layout";
import { CountryFlag } from "../components/country-flag";
import { CompletedRunsIcon } from "../components/navigation-icons";
import {
  BelkiTrendChart,
  TrendChartInsight,
  TrendChartLegend,
  type TrendSeriesDefinition,
} from "../components/trend-chart";
import { TrackingSourceMark } from "../components/tracking-source-mark";
import { PromptRowActions } from "../components/prompt-row-actions";
import {
  TagChip,
  TagPicker,
  tagForName,
  type PromptTag,
} from "../components/prompt-tags";
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
  TableSkeleton,
} from "../components/ui";
import { useApp } from "../context";
import { api, apiPage, patch, post } from "../lib/api";
import {
  LOCATION_OPTIONS,
  languagesForLocation,
} from "../lib/locale-catalog";
import { isRunInProgress, runStatusLabel } from "../lib/run-status";
import {
  formatPrice,
  productAnalyticsKey,
  productDestination,
} from "../lib/snapshot-evidence";
import {
  alignPromptSetEvents,
  clusterPromptSetEvents,
  hasOverviewProducts,
  promptSetEventDescription,
  promptSetEventLabel,
  type AlignedPromptSetEvent,
} from "../lib/overview";
import {
  mobileHiddenTrendSeries,
  previousTrendValue,
  shortChartDate,
  toggleTrendSeries,
  trendWindowSummary,
  weightedTrendWindowSummary,
  type TrendDatum,
} from "../lib/trend-chart";
import { compact, dateTime, formText, percent, pluralize } from "../lib/utils";
import type { RunStatus } from "../../shared/contracts";
import {
  TRACKING_SOURCE_LABELS,
  type TrackingSource,
} from "../../shared/tracking-sources";

interface OverviewProduct {
  id: string;
  provider_product_id: string | null;
  title: string | null;
  merchants: string | null;
  registrable_domain: string | null;
  price: number | null;
  currency: string | null;
  canonical_url: string | null;
  raw_url: string | null;
  images: string[];
  product_ids: unknown[];
  latestSeen: string;
  appearances?: number;
}

interface Overview {
  trackingSource: TrackingSource | "all";
  includedSources: TrackingSource[];
  platformBreakdown: Array<{
    trackingSource: TrackingSource;
    completedRuns: number;
    surfacePresentRuns: number;
    totalCitations: number;
    visibility: number | null;
    shareOfVoice: number | null;
  }>;
  summary: {
    completed_runs: number;
    surface_present_runs: number;
    cited_runs: number;
    brand_mentioned_runs: number;
    product_runs: number;
    total_citations: number;
    citationRate: number;
    brandMentionRate: number;
    productBlockRate: number;
    trackedPromptCount: number;
    productPromptCount: number;
    productPromptCoverage: number;
  };
  series: Array<{
    metric_date: string;
    completed_runs: number;
    cited_runs: number;
    brand_mentioned_runs: number;
    product_runs: number;
  }>;
  citationSourceTrends: {
    sources: Array<{
      domain: string;
      isProjectDomain: boolean;
      totalCitations: number;
    }>;
    series: Array<{
      metric_date: string;
      rates: Record<string, number>;
    }>;
  };
  brandComparison: {
    positionStatus: "ready" | "backfilling" | "failed";
    summary: {
      ownedMentionedResponses: number;
      ownedAppearances: number;
      ownedVisibility: number;
      ownedShareOfVoice: number | null;
      ownedAveragePosition: number | null;
      ownedPositionSamples: number;
      totalBrandAppearances: number;
      trackedCompetitorCount: number;
      competitiveGap: {
        competitorId: string;
        competitorName: string;
        competitorVisibility: number;
        differencePercentagePoints: number;
      } | null;
    };
    brands: Array<{
      key: string;
      id: string | null;
      name: string;
      kind: "owned" | "competitor";
      mentionedResponses: number;
      appearances: number;
      visibility: number;
      shareOfVoice: number | null;
      averagePosition: number | null;
      positionSamples: number;
    }>;
    series: Array<{
      metric_date: string;
      completedRuns: number;
      totalBrandAppearances: number;
      metrics: Record<
        string,
        {
          mentionedResponses: number;
          appearances: number;
          visibility: number;
          shareOfVoice: number | null;
          averagePosition: number | null;
          positionSamples: number;
        }
      >;
    }>;
  };
  promptSetEvents: Array<{
    metric_date: string;
    addedCount: number;
    removedCount: number;
  }>;
  topProducts: OverviewProduct[];
  recentProducts: OverviewProduct[];
}

function OverviewKpi({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="overview-kpi">
      <div className="overview-kpi-icon">{icon}</div>
      <div className="overview-kpi-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
    </div>
  );
}

function OverviewProductList({
  products,
  mode,
}: {
  products: OverviewProduct[];
  mode: "top" | "recent";
}) {
  return (
    <div className="recent-products-list">
      {products.map((product) => (
        <div className="recent-product-row" key={product.id}>
          <Link
            aria-label={`View performance for ${product.title ?? "product"}`}
            className="recent-product-details"
            to={`/shopping/${productAnalyticsKey(product)}`}
          >
            <span className="recent-product-image">
              {product.images[0] ? (
                <img src={product.images[0]} alt="" loading="lazy" />
              ) : (
                <ShoppingBag size={17} />
              )}
            </span>
            <span className="recent-product-copy">
              <strong>{product.title ?? "Untitled product"}</strong>
              <span>
                {product.merchants ??
                  product.registrable_domain ??
                  "Merchant unavailable"}
              </span>
              <small>
                {mode === "top"
                  ? pluralize(product.appearances ?? 0, "appearance")
                  : dateTime(product.latestSeen)}
              </small>
            </span>
          </Link>
          <span className="recent-product-meta">
            <strong>
              {formatPrice(product.price, product.currency) ??
                "Price unavailable"}
            </strong>
            <a
              aria-label={`Open ${product.title ?? "product"} externally`}
              className="recent-product-external"
              href={productDestination(product)}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink size={13} />
            </a>
          </span>
        </div>
      ))}
    </div>
  );
}

const SOURCE_TREND_COLORS = [
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#9333ea",
  "#dc2626",
  "#18181b",
];

const BRAND_TREND_COLORS = [
  "#18181b",
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#9333ea",
];

function percentagePoints(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatted} pp`;
}

const PROMPT_EVENT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function useMobileChartLayout(): boolean {
  const query = "(max-width: 620px)";
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return matches;
}

function PromptSetEventMarker({
  event,
  viewBox,
}: {
  event: AlignedPromptSetEvent;
  viewBox?: { x?: number; y?: number };
}) {
  const x = viewBox?.x;
  const y = viewBox?.y;
  if (x === undefined || y === undefined) return null;
  const description = promptSetEventDescription(event);
  const label = event.addedCount && event.removedCount
    ? `±${event.addedCount + event.removedCount}`
    : event.addedCount
      ? `+${event.addedCount}`
      : `−${event.removedCount}`;
  const width = Math.max(24, label.length * 6 + 10);
  return (
    <g
      aria-label={description}
      className="prompt-set-event-marker"
      role="img"
      tabIndex={0}
    >
      <title>{description}</title>
      <rect
        className="prompt-set-event-hit-area"
        height={24}
        rx={12}
        width={width + 8}
        x={x - (width + 8) / 2}
        y={y - 10}
      />
      <rect
        className="prompt-set-event-flag"
        height={16}
        rx={8}
        width={width}
        x={x - width / 2}
        y={y - 6}
      />
      <text className="prompt-set-event-label" textAnchor="middle" x={x} y={y + 5}>
        {label}
      </text>
    </g>
  );
}

function promptEventReferenceLines(
  events: readonly AlignedPromptSetEvent[],
) {
  return events.map((event) => (
    <ReferenceLine
      ifOverflow="visible"
      key={`${event.chartDate}-${event.label}`}
      label={<PromptSetEventMarker event={event} />}
      stroke="#a1a1aa"
      strokeDasharray="2 4"
      strokeOpacity={0.7}
      strokeWidth={1}
      x={event.chartDate}
    />
  ));
}

function OverviewChartTooltip({
  active,
  label,
  payload,
  promptEvents,
  data,
  metric = "percentage",
}: {
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayload;
  promptEvents: readonly AlignedPromptSetEvent[];
  data: readonly TrendDatum[];
  metric?: "percentage" | "rank";
}) {
  if (!active || label === undefined) return null;
  const chartDate = String(label);
  const promptEvent = promptEvents.find(
    (event) => event.chartDate === chartDate,
  );
  const showEventBreakdown =
    promptEvent &&
    (promptEvent.sourceEvents.length > 1 ||
      promptEvent.sourceEvents.some(
        (source) => source.metric_date !== chartDate,
      ));
  const entries = [...(payload ?? [])]
    .filter((entry) => entry.value !== undefined)
    .sort((left, right) =>
      metric === "rank"
        ? Number(left.value) - Number(right.value)
        : Number(right.value) - Number(left.value),
    );
  const responseCount = data.find(
    (point) => point.metric_date === chartDate,
  )?.completedRuns;
  return (
    <div className="overview-chart-tooltip">
      <strong>{shortChartDate(chartDate)}</strong>
      {promptEvent && (
        <div className="overview-chart-tooltip-event">
          <span>
            Prompt changes <b>{promptEvent.label}</b>
          </span>
          {showEventBreakdown && promptEvent.sourceEvents.map((source, index) => (
            <small key={`${source.metric_date}-${index}`}>
              {PROMPT_EVENT_DATE_FORMAT.format(
                new Date(`${source.metric_date}T00:00:00.000Z`),
              )}
              : {promptSetEventLabel(source)}
            </small>
          ))}
        </div>
      )}
      <div className="overview-chart-tooltip-series">
        {entries.map((entry, index) => {
          const seriesKey = String(entry.dataKey ?? "");
          const previousValue = previousTrendValue(data, chartDate, seriesKey);
          const change = previousValue === null
            ? null
            : Number(entry.value) - previousValue;
          const positionSamples = data.find(
            (point) => point.metric_date === chartDate,
          )?.[`${seriesKey}__positionSamples`];
          return (
            <div key={`${String(entry.dataKey ?? entry.name)}-${index}`}>
              <i style={{ background: entry.color ?? entry.stroke }} />
              <span>{entry.name ?? String(entry.dataKey)}</span>
              <b>{metric === "rank"
                ? `#${Number(entry.value).toFixed(Number(entry.value) % 1 === 0 ? 0 : 1)}`
                : percent(Number(entry.value))}</b>
              {change === null ? null : (
                <small>
                  {change > 0 ? "+" : change < 0 ? "−" : ""}{Math.abs(change).toFixed(1)}{metric === "rank" ? " positions" : " pp"}
                </small>
              )}
              {metric === "rank" && typeof positionSamples === "number" ? (
                <small>{pluralize(positionSamples, "ranked response")}</small>
              ) : null}
            </div>
          );
        })}
      </div>
      {typeof responseCount === "number" ? (
        <small className="overview-chart-tooltip-responses">
          {pluralize(responseCount, "completed response")}
        </small>
      ) : null}
    </div>
  );
}

export function OverviewPage() {
  const {
    projectId,
    currentProject,
    trackingSources,
    setTrackingSource,
  } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSource = searchParams.get("source");
  const overviewSource: TrackingSource | "all" =
    requestedSource === "all" ||
    trackingSources.includes(requestedSource as TrackingSource)
      ? (requestedSource as TrackingSource | "all")
      : "all";
  const isConsolidated = overviewSource === "all";
  const [brandMetric, setBrandMetric] = useState<
    "visibility" | "shareOfVoice" | "averagePosition"
  >("visibility");
  const isMobileChartLayout = useMobileChartLayout();
  const [brandSeriesVisibility, setBrandSeriesVisibility] = useState<{
    context: string;
    hidden: Set<string>;
  }>(() => ({ context: "", hidden: new Set() }));
  const [citationSeriesVisibility, setCitationSeriesVisibility] = useState<{
    context: string;
    hidden: Set<string>;
  }>(() => ({ context: "", hidden: new Set() }));
  const [highlightedBrandSeries, setHighlightedBrandSeries] = useState<string | null>(null);
  const [highlightedCitationSeries, setHighlightedCitationSeries] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ["overview", projectId, overviewSource],
    queryFn: () => api<Overview>(`/analytics/overview?projectId=${projectId}&source=${overviewSource}`),
    enabled: Boolean(projectId),
  });
  const selectOverviewSource = (source: TrackingSource | "all") => {
    const next = new URLSearchParams(searchParams);
    next.set("source", source);
    setSearchParams(next, { replace: true });
    if (source !== "all") setTrackingSource(source);
  };
  const brandComparison = overview.data?.brandComparison;
  const positionReady = brandComparison?.positionStatus === "ready";
  const displayedBrandMetric =
    !positionReady && brandMetric === "averagePosition"
      ? "visibility"
      : brandMetric;
  const comparisonSummary = brandComparison?.summary;
  const comparisonBrands = useMemo(
    () => brandComparison?.brands ?? [],
    [brandComparison?.brands],
  );
  const ownedBrandName =
    comparisonBrands.find((brand) => brand.kind === "owned")?.name ??
    currentProject?.name ??
    "Your brand";
  const brandComparisonSeries = useMemo(
    () => (brandComparison?.series ?? []).map((point) => ({
      metric_date: point.metric_date,
      completedRuns: point.completedRuns,
      ...Object.fromEntries(comparisonBrands.flatMap((brand) => [
        [brand.key, point.metrics[brand.key]?.[displayedBrandMetric] ?? null],
        [
          `${brand.key}__positionSamples`,
          point.metrics[brand.key]?.positionSamples ?? 0,
        ],
      ])),
    })),
    [brandComparison?.series, displayedBrandMetric, comparisonBrands],
  );
  const brandTrendSeries = useMemo<TrendSeriesDefinition[]>(
    () => comparisonBrands.map((brand, index) => ({
      key: brand.key,
      label: brand.name,
      color: BRAND_TREND_COLORS[index % BRAND_TREND_COLORS.length] ?? "#18181b",
      primary: brand.kind === "owned",
      badge: brand.kind === "owned" ? "Your brand" : undefined,
    })),
    [comparisonBrands],
  );
  const citationSources = useMemo(
    () => overview.data?.citationSourceTrends.sources ?? [],
    [overview.data?.citationSourceTrends.sources],
  );
  const citationSourceSeries = useMemo(
    () => {
      const completedRuns = new Map(
        (overview.data?.series ?? []).map((point) => [
          point.metric_date,
          point.completed_runs,
        ]),
      );
      return (overview.data?.citationSourceTrends.series ?? []).map((point) => ({
        metric_date: point.metric_date,
        completedRuns: completedRuns.get(point.metric_date),
        ...Object.fromEntries(
          citationSources.map((source, index) => [
            `source_${index}`,
            point.rates[source.domain] ?? 0,
          ]),
        ),
      }));
    },
    [citationSources, overview.data?.citationSourceTrends.series, overview.data?.series],
  );
  const citationTrendSeries = useMemo<TrendSeriesDefinition[]>(
    () => citationSources.map((source, index) => ({
      key: `source_${index}`,
      label: source.domain,
      color: SOURCE_TREND_COLORS[
        source.isProjectDomain
          ? SOURCE_TREND_COLORS.length - 1
          : index % (SOURCE_TREND_COLORS.length - 1)
      ] ?? "#18181b",
      primary: source.isProjectDomain,
      badge: source.isProjectDomain ? "Project" : undefined,
      detailHref: isConsolidated
        ? undefined
        : `/citations/${encodeURIComponent(source.domain)}`,
      connectNulls: true,
    })),
    [citationSources, isConsolidated],
  );
  const mobileBrandHiddenSeries = useMemo(
    () => mobileHiddenTrendSeries(brandTrendSeries),
    [brandTrendSeries],
  );
  const mobileCitationHiddenSeries = useMemo(
    () => mobileHiddenTrendSeries(citationTrendSeries),
    [citationTrendSeries],
  );
  const brandVisibilityContext = `${isMobileChartLayout}:${brandTrendSeries.map(({ key }) => key).join("|")}`;
  const citationVisibilityContext = `${isMobileChartLayout}:${citationTrendSeries.map(({ key }) => key).join("|")}`;
  const hiddenBrandSeries = brandSeriesVisibility.context === brandVisibilityContext
    ? brandSeriesVisibility.hidden
    : isMobileChartLayout
      ? mobileBrandHiddenSeries
      : new Set<string>();
  const hiddenCitationSeries = citationSeriesVisibility.context === citationVisibilityContext
    ? citationSeriesVisibility.hidden
    : isMobileChartLayout
      ? mobileCitationHiddenSeries
      : new Set<string>();
  const visibleBrandTrendSeries = brandTrendSeries.filter(
    ({ key }) => !hiddenBrandSeries.has(key),
  );
  const visibleCitationTrendSeries = citationTrendSeries.filter(
    ({ key }) => !hiddenCitationSeries.has(key),
  );
  const ownedTrendSeries = brandTrendSeries.find(({ primary }) => primary);
  const brandTrendSummary = ownedTrendSeries
    ? displayedBrandMetric === "averagePosition"
      ? weightedTrendWindowSummary(
          brandComparisonSeries,
          ownedTrendSeries.key,
          `${ownedTrendSeries.key}__positionSamples`,
        )
      : trendWindowSummary(brandComparisonSeries, ownedTrendSeries.key)
    : null;
  const leadingCitationTrend = citationTrendSeries
    .map((definition) => ({
      definition,
      summary: trendWindowSummary(citationSourceSeries, definition.key),
    }))
    .filter((entry) => entry.summary !== null)
    .sort((left, right) => (right.summary?.value ?? 0) - (left.summary?.value ?? 0))[0];
  const chartDates = (overview.data?.series ?? []).map(
    (point) => point.metric_date,
  );
  const promptSetEvents = clusterPromptSetEvents(
    alignPromptSetEvents(overview.data?.promptSetEvents ?? [], chartDates),
    chartDates,
  );
  if (!projectId) return <NoProject />;
  return (
    <div className="page overview-page">
      <div className="overview-source-filter" aria-label="AI platform" role="tablist">
        <button
          aria-selected={isConsolidated}
          className={isConsolidated ? "active" : undefined}
          onClick={() => selectOverviewSource("all")}
          role="tab"
          type="button"
        >
          All platforms
        </button>
        {trackingSources.map((source) => (
          <button
            aria-selected={overviewSource === source}
            className={overviewSource === source ? "active" : undefined}
            key={source}
            onClick={() => selectOverviewSource(source)}
            role="tab"
            type="button"
          >
            {TRACKING_SOURCE_LABELS[source]}
          </button>
        ))}
      </div>
      <PageHeader
        eyebrow="Last 30 days"
        title="Visibility overview"
        description={isConsolidated
          ? `A combined view of ${currentProject?.name ?? "your brand"} across every enabled AI platform.`
          : `How ${currentProject?.name ?? "your brand"} appears across monitored ${TRACKING_SOURCE_LABELS[overviewSource]} results.`}
        action={<Button variant="secondary" onClick={() => void overview.refetch()}><RefreshCw size={15} /> Refresh</Button>}
      />
      {overview.isPending ? (
        <div className="overview-kpi-strip">{Array.from({ length: 4 }, (_, i) => <Skeleton className="overview-kpi-skeleton" key={i} />)}</div>
      ) : (
        <div className="overview-kpi-strip">
          <OverviewKpi
            label="Visibility"
            value={percent(comparisonSummary?.ownedVisibility ?? 0)}
            detail={`${comparisonSummary?.ownedMentionedResponses ?? 0} of ${overview.data?.summary.completed_runs ?? 0} responses`}
            icon={<Eye size={19} />}
          />
          <OverviewKpi
            label="Share of Voice"
            value={comparisonSummary?.ownedShareOfVoice === null || comparisonSummary?.ownedShareOfVoice === undefined ? "—" : percent(comparisonSummary.ownedShareOfVoice)}
            detail={comparisonSummary?.trackedCompetitorCount
              ? `${comparisonSummary.ownedAppearances} of ${comparisonSummary.totalBrandAppearances} brand appearances`
              : "Track a competitor to compare"}
            icon={<ChartPie size={19} />}
          />
          <OverviewKpi
            label="Visibility gap"
            value={percentagePoints(comparisonSummary?.competitiveGap?.differencePercentagePoints)}
            detail={comparisonSummary?.competitiveGap
              ? `${ownedBrandName} ${percent(comparisonSummary.ownedVisibility)} · ${comparisonSummary.competitiveGap.competitorName} ${percent(comparisonSummary.competitiveGap.competitorVisibility)}`
              : "Track a competitor to compare"}
            icon={<Scale size={19} />}
          />
          <OverviewKpi
            label={overviewSource === "google_ai_overview" ? "AI Overviews found" : "Responses captured"}
            value={compact(overviewSource === "google_ai_overview"
              ? overview.data?.summary.surface_present_runs ?? 0
              : overview.data?.summary.completed_runs ?? 0)}
            detail={overviewSource === "google_ai_overview"
              ? `${overview.data?.summary.completed_runs ?? 0} prompts tracked`
              : isConsolidated
                ? `${overview.data?.includedSources.length ?? trackingSources.length} enabled platforms`
                : `${pluralize(overview.data?.summary.total_citations ?? 0, "citation")} captured`}
            icon={<CompletedRunsIcon size={19} />}
          />
        </div>
      )}
      <div className="overview-dashboard">
        <div className="overview-charts-row">
          <Card className="chart-card brand-comparison-card">
            <CardHeader
              title={displayedBrandMetric === "visibility"
                ? "Brand visibility vs competitors"
                : displayedBrandMetric === "shareOfVoice"
                  ? "Share of Voice vs competitors"
                  : "Average position vs competitors"}
              description={displayedBrandMetric === "visibility"
                ? "Daily share of completed responses mentioning each brand"
                : displayedBrandMetric === "shareOfVoice"
                  ? "Daily share of appearances across all tracked brands"
                  : "First-mention order when a tracked brand appears; lower is better"}
              action={(
                <div className="metric-toggle" aria-label="Comparison metric">
                  <button
                    className={displayedBrandMetric === "visibility" ? "is-active" : undefined}
                    onClick={() => setBrandMetric("visibility")}
                    type="button"
                  >
                    Visibility
                  </button>
                  <button
                    className={displayedBrandMetric === "shareOfVoice" ? "is-active" : undefined}
                    onClick={() => setBrandMetric("shareOfVoice")}
                    type="button"
                  >
                    Share of Voice
                  </button>
                  <button
                    className={displayedBrandMetric === "averagePosition" ? "is-active" : undefined}
                    disabled={!positionReady}
                    onClick={() => setBrandMetric("averagePosition")}
                    title={positionReady
                      ? "Show average first-mention position"
                      : brandComparison?.positionStatus === "failed"
                        ? "Position history is temporarily unavailable"
                        : "Position history is being prepared"}
                    type="button"
                  >
                    Average position
                  </button>
                </div>
              )}
            />
            <TrendChartInsight
              change={brandTrendSummary?.change}
              detail={ownedTrendSeries?.label}
              label={displayedBrandMetric === "averagePosition"
                ? "7-day weighted average"
                : "7-day average"}
              metric={displayedBrandMetric === "averagePosition" ? "rank" : "percentage"}
              value={brandTrendSummary?.value}
            />
            {comparisonSummary?.trackedCompetitorCount ? (
              <>
                <TrendChartLegend
                  highlightedKey={highlightedBrandSeries}
                  hiddenKeys={hiddenBrandSeries}
                  items={brandTrendSeries}
                  onHighlightedKeyChange={setHighlightedBrandSeries}
                  onToggle={(key) => setBrandSeriesVisibility({
                    context: brandVisibilityContext,
                    hidden: toggleTrendSeries(
                      hiddenBrandSeries,
                      key,
                      brandTrendSeries.map((item) => item.key),
                    ),
                  })}
                />
                <p className="brand-comparison-note">
                  {brandComparison?.positionStatus === "backfilling"
                    ? "Average position history is being prepared in the background. "
                    : brandComparison?.positionStatus === "failed"
                      ? "Average position history is temporarily unavailable. "
                      : displayedBrandMetric === "averagePosition"
                        ? "Position is conditional on a brand being mentioned; lower is better. "
                        : ""}
                  Select a brand to show or hide it. Share of Voice and position include all {comparisonSummary.trackedCompetitorCount} tracked {comparisonSummary.trackedCompetitorCount === 1 ? "competitor" : "competitors"}{comparisonSummary.trackedCompetitorCount > 4 ? "; the chart shows the top four." : "."}
                </p>
              </>
            ) : null}
            <div className="chart brand-comparison-chart">
              {overview.isPending ? (
                <Skeleton className="chart-skeleton" />
              ) : !comparisonSummary?.trackedCompetitorCount ? (
                <EmptyState
                  title="No competitors tracked yet"
                  description="Track competitors from Entities to compare visibility and Share of Voice."
                  action={<Button asChild variant="secondary"><Link to="/entities">Manage competitors</Link></Button>}
                />
              ) : brandComparisonSeries.length > 0 ? (
                <BelkiTrendChart
                  annotations={promptEventReferenceLines(promptSetEvents)}
                  ariaLabel={`${displayedBrandMetric === "visibility"
                    ? "Visibility"
                    : displayedBrandMetric === "shareOfVoice"
                      ? "Share of Voice"
                      : "Average position"} trend for ${ownedBrandName} and tracked competitors`}
                  data={brandComparisonSeries}
                  highlightedKey={highlightedBrandSeries}
                  metric={displayedBrandMetric === "averagePosition" ? "rank" : "percentage"}
                  series={visibleBrandTrendSeries}
                  tooltipContent={(props) => (
                    <OverviewChartTooltip
                      active={props.active}
                      data={brandComparisonSeries}
                      label={props.label}
                      payload={props.payload}
                      promptEvents={promptSetEvents}
                      metric={displayedBrandMetric === "averagePosition" ? "rank" : "percentage"}
                    />
                  )}
                />
              ) : <EmptyState title="No trend data yet" description="Your first completed tracking run will appear here." />}
            </div>
          </Card>

          <Card className="chart-card source-comparison-card">
            <CardHeader
              title="Citation source trend"
              description="Daily share of completed runs citing each leading source"
            />
            <TrendChartInsight
              change={leadingCitationTrend?.summary?.change}
              detail={leadingCitationTrend?.definition.label}
              label="Leading source · 7-day average"
              value={leadingCitationTrend?.summary?.value}
            />
            {citationSources.length > 0 ? (
              <TrendChartLegend
                highlightedKey={highlightedCitationSeries}
                hiddenKeys={hiddenCitationSeries}
                items={citationTrendSeries}
                onHighlightedKeyChange={setHighlightedCitationSeries}
                onToggle={(key) => setCitationSeriesVisibility({
                  context: citationVisibilityContext,
                  hidden: toggleTrendSeries(
                    hiddenCitationSeries,
                    key,
                    citationTrendSeries.map((item) => item.key),
                  ),
                })}
              />
            ) : null}
            <div className="chart source-comparison-chart">
              {overview.isPending ? (
                <Skeleton className="chart-skeleton" />
              ) : citationSources.length > 0 &&
                citationSourceSeries.length > 0 ? (
                <BelkiTrendChart
                  annotations={promptEventReferenceLines(promptSetEvents)}
                  ariaLabel="Citation frequency trend for leading sources"
                  data={citationSourceSeries}
                  highlightedKey={highlightedCitationSeries}
                  series={visibleCitationTrendSeries}
                  tooltipContent={(props) => (
                    <OverviewChartTooltip
                      active={props.active}
                      data={citationSourceSeries}
                      label={props.label}
                      payload={props.payload}
                      promptEvents={promptSetEvents}
                    />
                  )}
                />
              ) : (
                <EmptyState
                  title="No citation source data yet"
                  description="Leading sources will appear after completed runs contain citations."
                />
              )}
            </div>
          </Card>
        </div>

        {isConsolidated && (
          <section className="platform-comparison" aria-labelledby="platform-comparison-title">
            <header>
              <div>
                <h2 id="platform-comparison-title">Platform comparison</h2>
                <p>See where your brand is strongest, then open a platform for its detailed report.</p>
              </div>
            </header>
            {overview.isPending ? (
              <Skeleton className="platform-comparison-skeleton" />
            ) : (
              <div className="platform-comparison-table" role="table">
                <div className="platform-comparison-head" role="row">
                  <span role="columnheader">Platform</span>
                  <span role="columnheader">Visibility</span>
                  <span role="columnheader">Share of Voice</span>
                  <span role="columnheader">Citations</span>
                </div>
                {overview.data?.platformBreakdown.map((platform) => {
                  return (
                    <button
                      className="platform-comparison-row"
                      key={platform.trackingSource}
                      onClick={() => selectOverviewSource(platform.trackingSource)}
                      role="row"
                      type="button"
                    >
                      <span className="platform-comparison-name" role="cell">
                        <span className="platform-comparison-mark">
                          <TrackingSourceMark source={platform.trackingSource} />
                        </span>
                        <span>
                          <strong>{TRACKING_SOURCE_LABELS[platform.trackingSource]}</strong>
                          <small>{platform.completedRuns ? "View detailed report" : "No results yet"}</small>
                        </span>
                      </span>
                      <span data-label="Visibility" role="cell">
                        {platform.visibility === null ? "—" : percent(platform.visibility)}
                      </span>
                      <span data-label="Share of Voice" role="cell">
                        {platform.shareOfVoice === null ? "—" : percent(platform.shareOfVoice)}
                      </span>
                      <span data-label="Citations" role="cell">
                        {compact(platform.totalCitations)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {!isConsolidated && (overview.isPending || hasOverviewProducts(overview.data)) && <div className="overview-products-row">
          <Card className="recent-products-card">
            <CardHeader
              title="Top products"
              description="Most frequently surfaced products in the last 30 days"
            />
            {overview.isPending ? (
              <TableSkeleton rows={5} columns={2} />
            ) : overview.data?.topProducts.length ? (
              <OverviewProductList products={overview.data.topProducts} mode="top" />
            ) : (
              <EmptyState
                title="No products detected yet"
                description="Top products will appear when tracked answers contain shopping blocks."
              />
            )}
          </Card>

          <Card className="recent-products-card">
            <CardHeader
              title="Recently detected products"
              description="Latest products surfaced in tracked AI answers"
            />
            {overview.isPending ? (
              <TableSkeleton rows={5} columns={2} />
            ) : overview.data?.recentProducts.length ? (
              <OverviewProductList
                products={overview.data.recentProducts}
                mode="recent"
              />
            ) : (
              <EmptyState
                title="No products detected yet"
                description="Products will appear when a tracked answer contains a shopping block."
              />
            )}
          </Card>
        </div>}
      </div>
    </div>
  );
}

interface QueryRow {
  id: string;
  queryText: string;
  locationCode: number;
  languageCode: string;
  isActive: boolean;
  latestSnapshotId: string | null;
  latestCapturedAt: string | null;
  snapshotCount: number;
  latestRunStatus: RunStatus | null;
  sourceCount: number | null;
  mentionCount: number | null;
  mentionRate: number | null;
  citationCount: number | null;
  mentionChange: number | null;
  tags: PromptTag[];
}

interface CreatePromptsResult {
  id?: string;
  ids?: string[];
  createdCount?: number;
  skippedCount?: number;
}

interface PurgePromptsResult {
  acceptedCount: number;
  queryIds: string[];
  status: "queued";
}

export function PromptsPage() {
  const { projectId, session, trackingSource } = useApp();
  const canEdit = session.user.role !== "viewer";
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const suggestedPrompt = canEdit ? searchParams.get("add") ?? "" : "";
  const suggestedLocation = searchParams.get("addLocation");
  const initialLocationCode =
    suggestedLocation &&
    LOCATION_OPTIONS.some((option) => option.value === suggestedLocation)
      ? suggestedLocation
      : "2840";
  const suggestedLanguage = searchParams.get("addLanguage");
  const initialLanguageCode =
    suggestedLanguage &&
    languagesForLocation(initialLocationCode).some(
      (language) => language.value === suggestedLanguage,
    )
      ? suggestedLanguage
      : languagesForLocation(initialLocationCode)[0]?.value ?? "en";
  const [dialogOpen, setDialogOpen] = useState(Boolean(projectId && suggestedPrompt));
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [singlePromptText, setSinglePromptText] = useState(
    suggestedPrompt.slice(0, 2_000),
  );
  const [bulkResult, setBulkResult] = useState<{
    createdCount: number;
    skippedCount: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [tagError, setTagError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteTargets, setDeleteTargets] = useState<QueryRow[]>([]);
  const [deleteNotice, setDeleteNotice] = useState(0);
  const [createTags, setCreateTags] = useState<string[]>([]);
  const [promptSelection, setPromptSelection] = useState<{
    scope: string;
    ids: Set<string>;
  }>(
    () => ({ scope: "", ids: new Set() }),
  );
  const [locationCode, setLocationCode] = useState(initialLocationCode);
  const [languageCode, setLanguageCode] = useState(initialLanguageCode);
  const languageOptions = languagesForLocation(locationCode);
  const bulkPromptCount = bulkText
    .split(/\r?\n/)
    .filter((line) => line.trim()).length;
  const search = searchParams.get("search") ?? "";
  const country = searchParams.get("country") ?? "";
  const language = searchParams.get("language") ?? "";
  const selectedTagIds = (searchParams.get("tags") ?? "")
    .split(",")
    .filter(Boolean);
  const tagKey = selectedTagIds.join(",");
  const pageSize = 50;
  const pageScope = [projectId, trackingSource, search, country, language, tagKey].join("\u0000");
  const [promptPagination, setPromptPagination] = useState<{
    scope: string;
    cursors: string[];
  }>(() => ({ scope: "", cursors: [] }));
  const promptCursors =
    promptPagination.scope === pageScope ? promptPagination.cursors : [];
  const promptCursor = promptCursors.at(-1);
  const pageOffset = promptCursors.length * pageSize;
  const selectionScope = [projectId, search, country, language, tagKey].join("\u0000");
  const selectedPromptIds =
    promptSelection.scope === selectionScope
      ? promptSelection.ids
      : new Set<string>();
  const setSelectedPromptIds = (
    value: Set<string> | ((current: Set<string>) => Set<string>),
  ) => {
    setPromptSelection((current) => {
      const currentIds =
        current.scope === selectionScope ? current.ids : new Set<string>();
      return {
        scope: selectionScope,
        ids: typeof value === "function" ? value(currentIds) : value,
      };
    });
  };
  const tags = useQuery({
    queryKey: ["prompt-tags", projectId],
    queryFn: () => api<PromptTag[]>(`/projects/${projectId}/tags`),
    enabled: Boolean(projectId),
  });
  const reportParams = new URLSearchParams({
    projectId: projectId ?? "",
    source: trackingSource,
  });
  if (search) reportParams.set("search", search);
  if (country) reportParams.set("locationCode", country);
  if (language) reportParams.set("languageCode", language);
  if (selectedTagIds.length) reportParams.set("tagIds", tagKey);
  if (promptCursor) reportParams.set("cursor", promptCursor);
  reportParams.set("limit", String(pageSize));
  const queries = useQuery({
    queryKey: [
      "prompts",
      projectId,
      trackingSource,
      search,
      country,
      language,
      tagKey,
      promptCursor ?? "",
    ],
    queryFn: () => apiPage<QueryRow[]>(`/analytics/prompts?${reportParams}`),
    enabled: Boolean(projectId),
    refetchInterval: (current) =>
      current.state.data?.data.some((query) =>
        isRunInProgress(query.latestRunStatus),
      )
        ? 3_000
        : false,
  });
  const promptRows = queries.data?.data ?? [];
  const totalPrompts = queries.data?.page.total ?? 0;
  const visibleSelectedIds = promptRows
    .map((query) => query.id)
    .filter((id) => selectedPromptIds.has(id));
  const selectedRows = promptRows.filter((query) =>
    selectedPromptIds.has(query.id),
  );
  const selectedFilterTags = selectedTagIds
    .map((id) => tags.data?.find((tag) => tag.id === id))
    .filter((tag): tag is PromptTag => Boolean(tag));
  const createQuery = useMutation({
    mutationFn: ({
      body,
      bulk,
    }: {
      body: Record<string, unknown>;
      bulk: boolean;
    }) =>
      post<CreatePromptsResult>(
        `/projects/${projectId}/queries${bulk ? "/bulk" : ""}`,
        body,
      ),
    onSuccess: async (result, variables) => {
      setBulkResult(
        variables.bulk
          ? {
              createdCount: result.createdCount ?? 0,
              skippedCount: result.skippedCount ?? 0,
            }
          : null,
      );
      setDialogOpen(false);
      setBulkMode(false);
      setBulkText("");
      setCreateTags([]);
      setError("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompts", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-tags", projectId] }),
      ]);
    },
    onError: (value: Error) => setError(value.message),
  });
  const manualRun = useMutation({
    mutationFn: (queryId: string) => post(`/queries/${queryId}/runs`, {
      captureHtml: false,
      source: trackingSource,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prompts", projectId] }),
  });
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      patch(`/queries/${id}/status`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prompts", projectId] }),
  });
  const updateTags = useMutation({
    mutationFn: ({
      queryIds,
      tagNames,
      mode,
    }: {
      queryIds: string[];
      tagNames: string[];
      mode: "add" | "remove";
      clearSelection?: boolean;
    }) =>
      patch(`/projects/${projectId}/queries/tags`, {
        queryIds,
        tagNames,
        mode,
      }),
    onMutate: () => setTagError(""),
    onSuccess: async (_, variables) => {
      if (variables.clearSelection) setSelectedPromptIds(new Set());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompts", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-tags", projectId] }),
      ]);
    },
    onError: (value: Error) => setTagError(value.message),
  });
  const purgePrompts = useMutation({
    mutationFn: (queryIds: string[]) =>
      post<PurgePromptsResult>(`/projects/${projectId}/queries/purge`, {
        queryIds,
      }),
    onMutate: () => setDeleteError(""),
    onSuccess: async (result) => {
      setDeleteNotice(result.acceptedCount);
      setDeleteTargets([]);
      setSelectedPromptIds(new Set());
      setPromptPagination({ scope: pageScope, cursors: [] });
      await queryClient.invalidateQueries();
    },
    onError: (value: Error) => setDeleteError(value.message),
  });
  if (!projectId) return <NoProject />;
  const openPromptDialog = () => {
    setError("");
    setBulkResult(null);
    setSinglePromptText("");
    setDialogOpen(true);
  };
  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setBulkMode(false);
      setBulkText("");
      setSinglePromptText("");
      setCreateTags([]);
      setError("");
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    const cadence = formText(data, "cadence");
    const sharedSettings = {
      locationCode: Number(locationCode),
      languageCode,
      forceWebSearch: true,
      schedule: cadence === "weekly"
        ? { cadence, weekday: Number(data.get("weekday")), time: data.get("time"), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        : { cadence, time: data.get("time"), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      tags: createTags,
    };
    if (bulkMode) {
      const queryTexts = bulkText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (queryTexts.length === 0) {
        setError("Paste at least one prompt.");
        return;
      }
      if (queryTexts.length > 50) {
        setError("Bulk uploads are limited to 50 prompts at a time.");
        return;
      }
      const longPrompt = queryTexts.find((queryText) => queryText.length > 2_000);
      if (longPrompt) {
        setError("Each prompt must be 2,000 characters or fewer.");
        return;
      }
      createQuery.mutate({
        bulk: true,
        body: { ...sharedSettings, queryTexts },
      });
      return;
    }
    createQuery.mutate({
      bulk: false,
      body: {
        ...sharedSettings,
        queryText: formText(data, "queryText"),
      },
    });
  };
  return (
    <div className="page prompts-page page-flow">
      <PageHeader title="Prompts" description="Prompts monitored against ChatGPT web Search mode." action={
        <div className="button-group">
          <Button asChild variant="secondary">
            <Link to="/prompts/library"><Sparkles size={16} /> Browse library</Link>
          </Button>
          <Button onClick={openPromptDialog}><Plus size={16} /> Add prompt</Button>
        </div>
      } />
      <div className="report-filters">
        <div className="search-filter">
          <Search size={15} />
          <Input
            aria-label="Search prompts"
            placeholder="Search prompts"
            value={search}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              if (event.target.value) next.set("search", event.target.value);
              else next.delete("search");
              setSearchParams(next, { replace: true });
            }}
          />
        </div>
        <Select
          value={country || "all"}
          onValueChange={(value) => {
            const next = new URLSearchParams(searchParams);
            if (value === "all") next.delete("country");
            else next.set("country", value);
            setSearchParams(next, { replace: true });
          }}
          options={[{ value: "all", label: "All countries" }, ...LOCATION_OPTIONS]}
        />
        <Select
          value={language || "all"}
          onValueChange={(value) => {
            const next = new URLSearchParams(searchParams);
            if (value === "all") next.delete("language");
            else next.set("language", value);
            setSearchParams(next, { replace: true });
          }}
          options={[
            { value: "all", label: "All languages" },
            ...Array.from(
              new Map(
                LOCATION_OPTIONS.flatMap((option) =>
                  languagesForLocation(option.value).map((item) => [item.value, item]),
                ),
              ).values(),
            ),
          ]}
        />
        <TagPicker
          className="tag-filter-trigger"
          disabled={tags.isPending || !tags.data?.length}
          label={selectedTagIds.length ? "Filtered tags" : "All tags"}
          onToggle={(name, selected) => {
            const tag = tags.data?.find(
              (item) => item.name.toLowerCase() === name.toLowerCase(),
            );
            if (!tag) return;
            const nextIds = selected
              ? [...new Set([...selectedTagIds, tag.id])]
              : selectedTagIds.filter((id) => id !== tag.id);
            const next = new URLSearchParams(searchParams);
            if (nextIds.length) next.set("tags", nextIds.join(","));
            else next.delete("tags");
            setSearchParams(next, { replace: true });
          }}
          selectedNames={selectedFilterTags.map((tag) => tag.name)}
          tags={tags.data ?? []}
        />
      </div>
      {selectedFilterTags.length ? (
        <div className="active-tag-filters">
          <span>Matching every tag:</span>
          {selectedFilterTags.map((tag) => (
            <TagChip
              key={tag.id}
              onRemove={() => {
                const next = new URLSearchParams(searchParams);
                const nextIds = selectedTagIds.filter((id) => id !== tag.id);
                if (nextIds.length) next.set("tags", nextIds.join(","));
                else next.delete("tags");
                setSearchParams(next, { replace: true });
              }}
              tag={tag}
            />
          ))}
          <button
            className="clear-tag-filters"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("tags");
              setSearchParams(next, { replace: true });
            }}
            type="button"
          >
            Clear
          </button>
        </div>
      ) : null}
      {bulkResult ? (
        <div className="bulk-upload-result" role="status">
          <strong>{pluralize(bulkResult.createdCount, "prompt")} added</strong>
          {bulkResult.skippedCount ? (
            <span>
              {pluralize(bulkResult.skippedCount, "duplicate")} skipped.
            </span>
          ) : null}
        </div>
      ) : null}
      {deleteNotice ? (
        <div className="bulk-upload-result" role="status">
          <strong>{pluralize(deleteNotice, "prompt")} deleted</strong>
          <span>Associated captures and evidence are being permanently purged.</span>
        </div>
      ) : null}
      <Card className="prompts-table-card">
        <CardHeader title={queries.isPending ? "Prompts" : pluralize(totalPrompts, "prompt")} description="Latest capture metrics with a rolling 30-day owned-brand mention rate." />
        {visibleSelectedIds.length ? (
          <div className="prompt-bulk-toolbar">
            <strong>{pluralize(visibleSelectedIds.length, "prompt")} selected</strong>
            <TagPicker
              allowCreate
              disabled={updateTags.isPending}
              label="Add tags"
              onToggle={(name, selected) => {
                if (!selected) return;
                updateTags.mutate({
                  queryIds: visibleSelectedIds,
                  tagNames: [name],
                  mode: "add",
                  clearSelection: true,
                });
              }}
              selectedNames={[]}
              tags={tags.data ?? []}
            />
            <TagPicker
              disabled={updateTags.isPending}
              label="Remove tags"
              onToggle={(name) =>
                updateTags.mutate({
                  queryIds: visibleSelectedIds,
                  tagNames: [name],
                  mode: "remove",
                  clearSelection: true,
                })
              }
              selectedNames={[]}
              tags={[
                ...new Map(
                  selectedRows
                    .flatMap((query) => query.tags)
                    .map((tag) => [tag.id, tag]),
                ).values(),
              ]}
            />
            <Button
              disabled={purgePrompts.isPending}
              onClick={() => {
                setDeleteError("");
                setDeleteTargets(selectedRows);
              }}
              variant="danger"
            >
              <Trash2 size={14} /> Delete selected
            </Button>
            <button
              className="plain-button prompt-selection-clear"
              onClick={() => setSelectedPromptIds(new Set())}
              type="button"
            >
              Clear selection
            </button>
          </div>
        ) : null}
        {tagError ? <p className="prompt-tag-error">{tagError}</p> : null}
        {queries.isPending ? (
          <TableSkeleton rows={6} columns={5} />
        ) : promptRows.length ? (
          <>
            <DataTable
              columns={[
              ...(canEdit
                ? [{
                    key: "select",
                    label: (
                      <input
                        aria-label="Select all visible prompts"
                        checked={
                          Boolean(promptRows.length) &&
                          visibleSelectedIds.length === promptRows.length
                        }
                        onChange={(event) =>
                          setSelectedPromptIds(
                            event.target.checked
                              ? new Set(promptRows.map((query) => query.id))
                              : new Set(),
                          )
                        }
                        type="checkbox"
                      />
                    ),
                    className: "prompt-select-column",
                  }]
                : []),
              { key: "query", label: "Prompt", className: "prompt-column" }, { key: "country", label: "Country" },
              { key: "sources", label: "Sources" }, { key: "mentions", label: "Mentions" },
              { key: "rate", label: "Mention rate" }, { key: "citations", label: "Citations" },
              { key: "change", label: "Mention change" },
              { key: "actions", label: "Actions", className: "actions-column" },
              ]}
              rows={promptRows.map((query) => {
              const runInProgress = isRunInProgress(query.latestRunStatus);
              const isStarting =
                manualRun.isPending && manualRun.variables === query.id;
              const isToggling =
                toggle.isPending && toggle.variables?.id === query.id;
              const destination = query.latestSnapshotId
                ? `/prompts/${query.id}/snapshots/${query.latestSnapshotId}`
                : `/prompts/${query.id}`;
              return {
                id: query.id,
                ...(canEdit
                  ? {
                      select: (
                        <input
                          aria-label={`Select ${query.queryText}`}
                          checked={selectedPromptIds.has(query.id)}
                          onChange={(event) =>
                            setSelectedPromptIds((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(query.id);
                              else next.delete(query.id);
                              return next;
                            })
                          }
                          type="checkbox"
                        />
                      ),
                    }
                  : {}),
                query: (
                  <div className="prompt-cell">
                    <Link className="primary-cell table-query-link" to={destination}>
                      <strong>{query.queryText}</strong>
                      <span>{dateTime(query.latestCapturedAt)} · {pluralize(query.snapshotCount, "capture")}</span>
                    </Link>
                    <div className="prompt-row-tags">
                      {query.tags.slice(0, 4).map((tag) => (
                        <TagChip compact key={tag.id} tag={tag} />
                      ))}
                      {query.tags.length > 4 ? (
                        <span className="prompt-tag-overflow">+{query.tags.length - 4}</span>
                      ) : null}
                      {canEdit ? (
                        <TagPicker
                          allowCreate
                          className="prompt-row-tag-trigger"
                          disabled={updateTags.isPending}
                          label={query.tags.length ? "Edit" : "Add tag"}
                          onToggle={(name, selected) =>
                            updateTags.mutate({
                              queryIds: [query.id],
                              tagNames: [name],
                              mode: selected ? "add" : "remove",
                            })
                          }
                          selectedNames={query.tags.map((tag) => tag.name)}
                          tags={tags.data ?? []}
                        />
                      ) : null}
                    </div>
                  </div>
                ),
                country: <CountryFlag locationCode={query.locationCode} languageCode={query.languageCode} />,
                sources: query.sourceCount ?? "—",
                mentions: query.mentionCount ?? "—",
                rate: query.mentionRate === null ? "—" : percent(query.mentionRate),
                citations: query.citationCount ?? "—",
                change: query.mentionChange === null
                  ? "—"
                  : <span className={query.mentionChange > 0 ? "metric-up" : query.mentionChange < 0 ? "metric-down" : ""}>
                      {query.mentionChange > 0 ? <ArrowUp size={13} /> : query.mentionChange < 0 ? <ArrowDown size={13} /> : null}
                      {query.mentionChange > 0 ? `+${query.mentionChange}` : query.mentionChange}
                    </span>,
                actions: (
                  <PromptRowActions
                    canDelete={canEdit}
                    canRun={session.workspace.plan_key === "self_hosted"}
                    deleteDisabled={purgePrompts.isPending}
                    isActive={query.isActive}
                    onDelete={() => {
                      setDeleteError("");
                      setDeleteTargets([query]);
                    }}
                    onRun={() => manualRun.mutate(query.id)}
                    onToggle={() =>
                      toggle.mutate({
                        id: query.id,
                        isActive: !query.isActive,
                      })
                    }
                    promptName={query.queryText}
                    runDisabled={isStarting || runInProgress}
                    runLabel={
                      isStarting
                        ? "Queued…"
                        : runStatusLabel(query.latestRunStatus)
                    }
                    toggleDisabled={isToggling}
                  />
                ),
              };
              })}
            />
            {totalPrompts > pageSize ? (
              <div className="table-pagination">
                <span>
                  {pageOffset + 1}–{Math.min(pageOffset + promptRows.length, totalPrompts)} of{" "}
                  {totalPrompts} prompts
                </span>
                <div>
                  <Button
                    disabled={!promptCursors.length || queries.isFetching}
                    onClick={() =>
                      setPromptPagination({
                        scope: pageScope,
                        cursors: promptCursors.slice(0, -1),
                      })
                    }
                    variant="secondary"
                  >
                    Previous
                  </Button>
                  <Button
                    disabled={!queries.data?.page.nextCursor || queries.isFetching}
                    onClick={() => {
                      const nextCursor = queries.data?.page.nextCursor;
                      if (!nextCursor) return;
                      setPromptPagination({
                        scope: pageScope,
                        cursors: [...promptCursors, nextCursor],
                      });
                    }}
                    variant="secondary"
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : <EmptyState title="No prompts found" description="Add the prompts your audience asks ChatGPT or adjust the filters." action={<Button onClick={openPromptDialog}><Plus size={15} /> Add prompt</Button>} />}
      </Card>
      <Dialog
        open={deleteTargets.length > 0}
        onOpenChange={(open) => {
          if (!open && !purgePrompts.isPending) {
            setDeleteTargets([]);
            setDeleteError("");
          }
        }}
        title={
          deleteTargets.length === 1
            ? "Delete prompt?"
            : `Delete ${deleteTargets.length} prompts?`
        }
        description="This action cannot be undone."
      >
        <div className="form-stack">
          {deleteTargets.length === 1 ? (
            <p className="prompt-delete-preview">{deleteTargets[0]?.queryText}</p>
          ) : null}
          <p>
            This permanently deletes the selected prompt
            {deleteTargets.length === 1 ? "" : "s"}, every capture, source record,
            alert, evidence file, and affected stored export. Anonymous provider usage
            totals remain for accurate billing and quotas.
          </p>
          {deleteError ? <p className="prompt-tag-error" role="alert">{deleteError}</p> : null}
          <div className="dialog-actions">
            <Button
              disabled={purgePrompts.isPending}
              onClick={() => setDeleteTargets([])}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={purgePrompts.isPending}
              onClick={() => purgePrompts.mutate(deleteTargets.map((query) => query.id))}
              type="button"
              variant="danger"
            >
              <Trash2 size={15} />
              {purgePrompts.isPending
                ? "Deleting…"
                : deleteTargets.length === 1
                  ? "Delete prompt"
                  : `Delete ${deleteTargets.length} prompts`}
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        title={bulkMode ? "Add tracked prompts" : "Add tracked prompt"}
        description={
          bulkMode
            ? "Paste prompts in bulk and apply one shared tracking schedule."
            : "Schedule a web-grounded ChatGPT result capture."
        }
      >
        <form className="form-stack" onSubmit={submit}>
          <div className="prompt-input-heading">
            <Label>{bulkMode ? "Prompts" : "Prompt"}</Label>
            <button
              className="plain-button bulk-mode-toggle"
              type="button"
              onClick={() => {
                setBulkMode((current) => !current);
                setBulkText("");
                setError("");
              }}
            >
              {bulkMode ? "Add a single prompt" : "Bulk upload"}
            </button>
          </div>
          {bulkMode ? (
            <>
              <textarea
                className="textarea bulk-prompt-textarea"
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
                placeholder={"What are the best project management tools?\nWhich tools are best for remote teams?\nWhat is the best free project management tool?"}
                required
              />
              <p className="bulk-prompt-hint">
                One prompt per line · {bulkPromptCount} of 50 prompts
              </p>
            </>
          ) : (
            <textarea
              className="textarea"
              name="queryText"
              value={singlePromptText}
              onChange={(event) => setSinglePromptText(event.target.value)}
              required
              maxLength={2000}
              placeholder="What are the best project management tools for remote teams?"
            />
          )}
          <div className="create-prompt-tags">
            <Label>Tags</Label>
            <div className="create-prompt-tag-row">
              {createTags.map((name) => (
                <TagChip
                  key={name.toLowerCase()}
                  onRemove={() =>
                    setCreateTags((current) =>
                      current.filter(
                        (item) =>
                          item.toLowerCase() !== name.toLowerCase(),
                      ),
                    )
                  }
                  tag={tagForName(name)}
                />
              ))}
              <TagPicker
                allowCreate
                label={createTags.length ? "Add another" : "Add tags"}
                onToggle={(name, selected) =>
                  setCreateTags((current) =>
                    selected
                      ? [...new Set([...current, name])]
                      : current.filter(
                          (item) =>
                            item.toLowerCase() !== name.toLowerCase(),
                        ),
                  )
                }
                selectedNames={createTags}
                tags={tags.data ?? []}
              />
            </div>
            <p className="prompt-tags-hint">
              {bulkMode
                ? "These tags apply to every pasted prompt, including matching prompts already in the project."
                : "Use tags to group and filter this prompt."}
            </p>
          </div>
          <div className="form-grid">
            <div>
              <Label>Location</Label>
              <Select
                value={locationCode}
                onValueChange={(value) => {
                  setLocationCode(value);
                  const nextLanguages = languagesForLocation(value);
                  if (!nextLanguages.some((language) => language.value === languageCode)) {
                    setLanguageCode(nextLanguages[0]?.value ?? "en");
                  }
                }}
                options={LOCATION_OPTIONS}
                placeholder="Select a country"
              />
            </div>
            <div>
              <Label>Language</Label>
              <Select
                value={languageCode}
                onValueChange={setLanguageCode}
                options={languageOptions}
                placeholder="Select a language"
              />
            </div>
          </div>
          <div className="form-grid">
            <div><Label>Cadence</Label><select className="input" name="cadence" defaultValue="daily"><option value="daily">Daily</option><option value="weekly">Weekly</option></select></div>
            <div><Label>Time</Label><Input type="time" name="time" defaultValue="09:00" required /></div>
          </div>
          <input type="hidden" name="weekday" value="1" />
          {error ? <p className="form-error">{error}</p> : null}
          <div className="dialog-actions">
            <Button type="button" variant="ghost" onClick={() => handleDialogOpenChange(false)}>Cancel</Button>
            <Button disabled={createQuery.isPending}>
              {createQuery.isPending
                ? "Adding…"
                : bulkMode
                  ? `Add ${pluralize(bulkPromptCount, "prompt")}`
                  : "Add prompt"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

export const QueriesPage = PromptsPage;
