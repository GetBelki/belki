import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { NoProject, PageHeader } from "../components/layout";
import { CountryFlag } from "../components/country-flag";
import {
  CompletedRunsIcon,
  SourcesIcon,
} from "../components/navigation-icons";
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
import { compact, dateTime, formText, percent, pluralize } from "../lib/utils";
import type { RunStatus } from "../../shared/contracts";

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
  summary: {
    completed_runs: number;
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
  topProducts: OverviewProduct[];
  recentProducts: OverviewProduct[];
}

function KpiCard({
  label,
  value,
  detail,
  icon,
  tone = "violet",
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  tone?: "violet" | "blue" | "green" | "amber";
}) {
  return (
    <Card className="kpi-card">
      <div className={`kpi-icon ${tone}`}>{icon}</div>
      <div className="kpi-meta"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
    </Card>
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

export function OverviewPage() {
  const { projectId, currentProject } = useApp();
  const overview = useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => api<Overview>(`/analytics/overview?projectId=${projectId}`),
    enabled: Boolean(projectId),
  });
  if (!projectId) return <NoProject />;
  const visibilitySeries = (overview.data?.series ?? []).map((point) => ({
    ...point,
    citationRate: point.completed_runs
      ? (point.cited_runs / point.completed_runs) * 100
      : 0,
    brandMentionRate: point.completed_runs
      ? (point.brand_mentioned_runs / point.completed_runs) * 100
      : 0,
  }));
  const citationSources = overview.data?.citationSourceTrends.sources ?? [];
  const citationSourceSeries = (
    overview.data?.citationSourceTrends.series ?? []
  ).map((point) => ({
    metric_date: point.metric_date,
    ...Object.fromEntries(
      citationSources.map((source, index) => [
        `source_${index}`,
        point.rates[source.domain] ?? 0,
      ]),
    ),
  }));
  return (
    <div className="page">
      <PageHeader
        eyebrow="Last 30 days"
        title="Visibility overview"
        description={`How ${currentProject?.name ?? "your brand"} appears across monitored ChatGPT web results.`}
        action={<Button variant="secondary" onClick={() => void overview.refetch()}><RefreshCw size={15} /> Refresh</Button>}
      />
      {overview.isPending ? (
        <div className="kpi-grid">{Array.from({ length: 4 }, (_, i) => <Skeleton className="kpi-skeleton" key={i} />)}</div>
      ) : (
        <div className="kpi-grid">
          <KpiCard label="Citation rate" value={percent(overview.data?.summary.citationRate ?? 0)} detail={pluralize(overview.data?.summary.cited_runs ?? 0, "cited run")} icon={<SourcesIcon size={19} />} />
          <KpiCard label="Brand mention rate" value={percent(overview.data?.summary.brandMentionRate ?? 0)} detail={pluralize(overview.data?.summary.brand_mentioned_runs ?? 0, "mention")} icon={<Sparkles size={19} />} tone="blue" />
          <KpiCard
            label="Product prompt coverage"
            value={percent(overview.data?.summary.productPromptCoverage ?? 0)}
            detail={`${overview.data?.summary.productPromptCount ?? 0} of ${overview.data?.summary.trackedPromptCount ?? 0} tracked prompts`}
            icon={<ShoppingBag size={19} />}
            tone="green"
          />
          <KpiCard label="Completed runs" value={compact(overview.data?.summary.completed_runs ?? 0)} detail={`${pluralize(overview.data?.summary.total_citations ?? 0, "citation")} captured`} icon={<CompletedRunsIcon size={19} />} tone="amber" />
        </div>
      )}
      <div className="overview-dashboard">
        <div className="overview-charts-row">
          <Card className="chart-card">
            <CardHeader title="Visibility trend" description="Daily citation and brand-mention rates" />
            <div className="chart">
              {overview.isPending ? (
                <Skeleton className="chart-skeleton" />
              ) : visibilitySeries.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <AreaChart
                    data={visibilitySeries}
                    margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                  >
                    <defs>
                      <linearGradient id="citation" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#18181b" stopOpacity={0.12}/><stop offset="95%" stopColor="#18181b" stopOpacity={0}/></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" />
                    <XAxis dataKey="metric_date" tickLine={false} axisLine={false} tick={{ fill: "#71717a", fontSize: 11 }} />
                    <YAxis
                      width={42}
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                      tickFormatter={(value) => `${value}%`}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: "#71717a", fontSize: 11 }}
                    />
                    <Tooltip
                      formatter={(value) => percent(Number(value))}
                      contentStyle={{ borderRadius: 6, border: "1px solid #d4d4d8", boxShadow: "none" }}
                    />
                    <Area type="monotone" dataKey="citationRate" name="Citation rate" stroke="#18181b" strokeWidth={2} fill="url(#citation)" />
                    <Area type="monotone" dataKey="brandMentionRate" name="Brand mention rate" stroke="#71717a" strokeWidth={2} fill="transparent" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <EmptyState title="No trend data yet" description="Your first completed tracking run will appear here." />}
            </div>
          </Card>

          <Card className="chart-card source-comparison-card">
            <CardHeader
              title="Citation source trend"
              description="Daily share of completed runs citing each leading source"
            />
            {citationSources.length > 0 && (
              <div className="source-comparison-legend">
                {citationSources.map((source, index) => (
                  <Link
                    key={source.domain}
                    to={`/citations/${encodeURIComponent(source.domain)}`}
                  >
                    <span
                      className="source-comparison-swatch"
                      style={{
                        background:
                          SOURCE_TREND_COLORS[
                            source.isProjectDomain
                              ? SOURCE_TREND_COLORS.length - 1
                              : index % (SOURCE_TREND_COLORS.length - 1)
                          ],
                      }}
                    />
                    {source.domain}
                    {source.isProjectDomain && <small>Project</small>}
                  </Link>
                ))}
              </div>
            )}
            <div className="chart source-comparison-chart">
              {overview.isPending ? (
                <Skeleton className="chart-skeleton" />
              ) : citationSources.length > 0 &&
                citationSourceSeries.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <LineChart
                    data={citationSourceSeries}
                    margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" />
                    <XAxis dataKey="metric_date" tickLine={false} axisLine={false} tick={{ fill: "#71717a", fontSize: 11 }} />
                    <YAxis
                      width={42}
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                      tickFormatter={(value) => `${value}%`}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: "#71717a", fontSize: 11 }}
                    />
                    <Tooltip
                      formatter={(value) => percent(Number(value))}
                      contentStyle={{ borderRadius: 6, border: "1px solid #d4d4d8", boxShadow: "none" }}
                    />
                    {citationSources.map((source, index) => (
                      <Line
                        connectNulls
                        dataKey={`source_${index}`}
                        dot={{ r: 2 }}
                        key={source.domain}
                        name={source.domain}
                        stroke={
                          SOURCE_TREND_COLORS[
                            source.isProjectDomain
                              ? SOURCE_TREND_COLORS.length - 1
                              : index % (SOURCE_TREND_COLORS.length - 1)
                          ]
                        }
                        strokeWidth={source.isProjectDomain ? 2.5 : 2}
                        type="monotone"
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState
                  title="No citation source data yet"
                  description="Leading sources will appear after completed runs contain citations."
                />
              )}
            </div>
          </Card>
        </div>

        <div className="overview-products-row">
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
        </div>
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

export function PromptsPage() {
  const { projectId, session } = useApp();
  const canEdit = session.user.role !== "viewer";
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState<{
    createdCount: number;
    skippedCount: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [tagError, setTagError] = useState("");
  const [createTags, setCreateTags] = useState<string[]>([]);
  const [promptSelection, setPromptSelection] = useState<{
    scope: string;
    ids: Set<string>;
  }>(
    () => ({ scope: "", ids: new Set() }),
  );
  const [locationCode, setLocationCode] = useState("2840");
  const [languageCode, setLanguageCode] = useState("en");
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
  const pageScope = [projectId, search, country, language, tagKey].join("\u0000");
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
  const reportParams = new URLSearchParams({ projectId: projectId ?? "" });
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
    mutationFn: (queryId: string) => post(`/queries/${queryId}/runs`, { captureHtml: false }),
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
  if (!projectId) return <NoProject />;
  const openPromptDialog = () => {
    setError("");
    setBulkResult(null);
    setDialogOpen(true);
  };
  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setBulkMode(false);
      setBulkText("");
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
    <div className="page">
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
                actions: <div className="table-actions">
                  <Button
                    className="prompt-action-button"
                    variant="secondary"
                    disabled={isToggling}
                    onClick={() =>
                      toggle.mutate({
                        id: query.id,
                        isActive: !query.isActive,
                      })
                    }
                  >
                    {query.isActive ? <Pause size={13} /> : <Play size={13} />}
                    {isToggling ? "Saving…" : query.isActive ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    className="prompt-action-button"
                    variant="secondary"
                    disabled={isStarting || runInProgress}
                    onClick={() => manualRun.mutate(query.id)}
                  >
                    <RefreshCw size={13} />
                    {isStarting ? "Queued…" : runStatusLabel(query.latestRunStatus)}
                  </Button>
                </div>,
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
