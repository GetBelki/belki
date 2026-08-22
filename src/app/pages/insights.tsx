import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ChartNoAxesColumn,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Eye,
  ExternalLink,
  FileDown,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ServerCog,
  ShoppingBag,
  Sparkles,
  Star,
  Store,
  Target,
  Trash2,
  Trophy,
  UserPlus,
  Webhook,
} from "lucide-react";
import {
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
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
import { WORKSPACE_INVITATION_TTL_DAYS } from "../../shared/invitations";
import { NoProject, PageHeader } from "../components/layout";
import { CountryFlag } from "../components/country-flag";
import { DomainFavicon } from "../components/domain-favicon";
import {
  TagChip,
  TagPicker,
  type PromptTag,
} from "../components/prompt-tags";
import {
  Badge,
  Button,
  Card,
  CardContent,
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
import { api, apiPage, patch, post, remove, type Project } from "../lib/api";
import { ENTITY_GROUPS, entityGroup, type EntityGroupKey } from "../lib/entity-groups";
import { LOCATION_OPTIONS } from "../lib/locale-catalog";
import { productDetailRows } from "../lib/product-analytics";
import { formatPrice, formatProviderCost, productDestination } from "../lib/snapshot-evidence";
import { chartDateLabel, shortChartDate } from "../lib/trend-chart";
import { compact, dateTime, formText, percent, pluralize } from "../lib/utils";

function useProjectAnalytics<T>(name: string) {
  const { projectId, trackingSource } = useApp();
  return useQuery({
    queryKey: [name, projectId, trackingSource],
    queryFn: () => api<T>(`/analytics/${name}?projectId=${projectId}&source=${trackingSource}`),
    enabled: Boolean(projectId),
  });
}

export function DomainsPage() {
  const { projectId } = useApp();
  const query = useProjectAnalytics<Array<Record<string, string | number>>>("domains");
  if (!projectId) return <NoProject />;
  return (
    <div className="page">
      <PageHeader title="Domain visibility" description="Cited sources and retrieved search results remain intentionally separate." />
      <Card>
        <CardHeader title="Top domains" description="Distinct visibility aggregated over the last 30 days." />
        {query.isPending ? <TableSkeleton /> : query.data?.length ? <DataTable columns={[
          { key: "domain", label: "Domain" }, { key: "cited", label: "Cited snapshots" },
          { key: "citations", label: "Citations" }, { key: "retrieved", label: "Retrieved" },
          { key: "products", label: "Products" },
        ]} rows={query.data.map((domain) => ({
          id: domain.domain,
          domain: <div className="domain-cell"><DomainFavicon domain={String(domain.domain)} /><strong>{domain.domain}</strong></div>,
          cited: compact(Number(domain.cited_snapshot_count)),
          citations: <strong>{compact(Number(domain.citation_count))}</strong>,
          retrieved: compact(Number(domain.retrieval_count)),
          products: compact(Number(domain.product_count)),
        }))} /> : <EmptyState title="No domain data" description="Domain metrics appear after snapshots finish normalizing." />}
      </Card>
    </div>
  );
}

interface CitationSourceRow {
  domain: string;
  citationRate: number;
  totalUrls: number;
  totalCitations: number;
  citedSnapshots: number;
}

function tableRowId(row: Record<string, React.ReactNode>): string {
  return typeof row.id === "string" || typeof row.id === "number"
    ? String(row.id)
    : "";
}

function CitationRateCell({ value }: { value: number }) {
  const rate = Math.max(0, Math.min(100, value));
  return (
    <div className="citation-rate-cell" aria-label={`${percent(rate)} citation rate`}>
      <span
        aria-hidden="true"
        className="citation-rate-ring"
        style={
          {
            "--citation-progress": `${rate * 3.6}deg`,
          } as React.CSSProperties
        }
      />
      <strong>{percent(rate)}</strong>
    </div>
  );
}

export function CitationSourcesPage() {
  const { projectId, trackingSource } = useApp();
  const navigate = useNavigate();
  const pageSize = 10;
  const [pagination, setPagination] = useState({
    projectId,
    cursors: [] as string[],
  });
  const cursors =
    pagination.projectId === projectId ? pagination.cursors : [];
  const cursor = cursors.at(-1);
  const pageOffset = cursors.length * pageSize;
  const query = useQuery({
    queryKey: ["citation-sources", projectId, trackingSource, cursor ?? ""],
    queryFn: () =>
      apiPage<CitationSourceRow[]>(
        `/analytics/citation-sources?projectId=${projectId}&source=${trackingSource}&limit=${pageSize}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      ),
    enabled: Boolean(projectId),
  });
  if (!projectId) return <NoProject />;
  const sources = query.data?.data ?? [];
  const total = query.data?.page.total ?? 0;
  const firstItem = total ? pageOffset + 1 : 0;
  const lastItem = Math.min(pageOffset + sources.length, total);
  return (
    <div className="page">
      <PageHeader
        eyebrow="Last 30 days"
        title="Citation sources"
        description="Domains explicitly cited in captured answers. Retrieved but uncited sources are excluded."
      />
      <Card>
        <CardHeader
          title="Source visibility"
          description="Citation rate is the share of completed captures that cited each domain."
          action={
            !query.isPending && total ? (
              <span className="table-total">{pluralize(total, "source")}</span>
            ) : undefined
          }
        />
        {query.isPending ? (
          <TableSkeleton rows={pageSize} />
        ) : sources.length ? (
          <>
            <DataTable
              columns={[
                { key: "domain", label: "Domain" },
                { key: "rate", label: "Citation rate" },
                { key: "urls", label: "URLs" },
                { key: "citations", label: "Total citations" },
                { key: "action", label: "", className: "source-row-action" },
              ]}
              rows={sources.map((source) => ({
                id: source.domain,
                domain: (
                  <div className="domain-cell">
                    <DomainFavicon domain={source.domain} />
                    <strong>{source.domain}</strong>
                  </div>
                ),
                rate: <CitationRateCell value={source.citationRate} />,
                urls: compact(source.totalUrls),
                citations: compact(source.totalCitations),
                action: <ChevronRight className="source-row-chevron" size={16} />,
              }))}
              onRowClick={(row) => {
                const sourceDomain = tableRowId(row);
                if (sourceDomain) {
                  void navigate(
                    `/citations/${encodeURIComponent(sourceDomain)}`,
                  );
                }
              }}
              rowAriaLabel={(row) =>
                `Open citation details for ${tableRowId(row)}`
              }
            />
            <div className="table-pagination">
              <span>{firstItem}–{lastItem} of {total}</span>
              <div>
                <Button
                  variant="secondary"
                  disabled={!cursors.length || query.isFetching}
                  onClick={() =>
                    setPagination({
                      projectId,
                      cursors: cursors.slice(0, -1),
                    })
                  }
                >
                  <ChevronLeft size={14} /> Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={!query.data?.page.nextCursor || query.isFetching}
                  onClick={() => {
                    const nextCursor = query.data?.page.nextCursor;
                    if (!nextCursor) return;
                    setPagination({
                      projectId,
                      cursors: [...cursors, nextCursor],
                    });
                  }}
                >
                  Next <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            title="No citation sources"
            description="Explicitly cited domains will appear after a capture completes."
          />
        )}
      </Card>
    </div>
  );
}

interface CitationSourceDetail {
  domain: string;
  summary: {
    completedRuns: number;
    citedSnapshots: number;
    totalCitations: number;
    totalUrls: number;
    totalPrompts: number;
    citationRate: number;
  };
  trend: Array<{
    date: string;
    completedRuns: number;
    citedSnapshots: number;
    citationCount: number;
    citationRate: number;
  }>;
  prompts: Array<{
    queryId: string;
    prompt: string;
    locationCode: number;
    languageCode: string;
    citationCount: number;
    citedSnapshots: number;
    citedUrls: number;
    latestSnapshotId: string;
    lastCitedAt: string;
  }>;
  urls: Array<{
    url: string;
    title: string | null;
    sourceName: string | null;
    citationCount: number;
    citedSnapshots: number;
    lastCitedAt: string;
  }>;
}

function urlPathLabel(value: string): string {
  try {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}`;
    return path === "/" ? url.hostname : path;
  } catch {
    return value;
  }
}

export function CitationSourceDetailPage() {
  const { projectId, trackingSource } = useApp();
  const { domain: routeDomain = "" } = useParams();
  const domain = routeDomain.trim().toLowerCase();
  const pageSize = 10;
  const pageKey = `${projectId ?? ""}:${domain}`;
  const [pagination, setPagination] = useState({
    pageKey,
    cursors: [] as string[],
  });
  const [promptPagination, setPromptPagination] = useState({
    pageKey,
    offset: 0,
  });
  const cursors =
    pagination.pageKey === pageKey ? pagination.cursors : [];
  const cursor = cursors.at(-1);
  const pageOffset = cursors.length * pageSize;
  const promptOffset =
    promptPagination.pageKey === pageKey ? promptPagination.offset : 0;
  const query = useQuery({
    queryKey: ["citation-source", projectId, trackingSource, domain, cursor ?? ""],
    queryFn: () =>
      apiPage<CitationSourceDetail>(
        `/analytics/citation-sources/${encodeURIComponent(domain)}?projectId=${projectId}&source=${trackingSource}&limit=${pageSize}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      ),
    enabled: Boolean(projectId && domain),
  });
  if (!projectId) return <NoProject />;
  const detail = query.data?.data;
  const total = query.data?.page.total ?? 0;
  const firstItem = total ? pageOffset + 1 : 0;
  const lastItem = Math.min(pageOffset + (detail?.urls.length ?? 0), total);
  const promptRows =
    detail?.prompts.slice(promptOffset, promptOffset + pageSize) ?? [];

  return (
    <div className="page citation-source-detail-page">
      <Link className="back-link" to="/citations">
        <ArrowLeft size={14} /> Citation sources
      </Link>
      <PageHeader
        eyebrow="Last 30 days"
        title={
          <span className="citation-source-title">
            <DomainFavicon domain={domain} size={32} />
            <span>{domain || "Citation source"}</span>
          </span>
        }
        description="Citation performance, trend, citing prompts, and cited pages for this source."
      />
      {query.isPending ? (
        <>
          <div className="source-summary-grid">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton className="source-summary-skeleton" key={index} />
            ))}
          </div>
          <Skeleton className="source-trend-skeleton" />
          <Card><TableSkeleton rows={pageSize} /></Card>
        </>
      ) : detail ? (
        <>
          <div className="source-summary-grid">
            <Card className="source-summary-card">
              <span>Citation rate</span>
              <strong>{percent(detail.summary.citationRate)}</strong>
              <small>Share of completed captures</small>
            </Card>
            <Card className="source-summary-card">
              <span>Total citations</span>
              <strong>{compact(detail.summary.totalCitations)}</strong>
              <small>Across the selected period</small>
            </Card>
            <Card className="source-summary-card">
              <span>Cited captures</span>
              <strong>{compact(detail.summary.citedSnapshots)}</strong>
              <small>of {compact(detail.summary.completedRuns)} completed</small>
            </Card>
            <Card className="source-summary-card">
              <span>Cited URLs</span>
              <strong>{compact(detail.summary.totalUrls)}</strong>
              <small>Distinct pages from this domain</small>
            </Card>
          </div>

          <Card className="source-trend-card">
            <CardHeader
              title="Citation trend"
              description="Daily share of completed captures that cited this source."
            />
            <div className="source-trend-chart">
              {detail.trend.length ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <AreaChart
                    accessibilityLayer
                    data={detail.trend}
                    margin={{ top: 12, right: 10, bottom: 2, left: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="sourceCitationRate"
                        x1="0"
                        x2="0"
                        y1="0"
                        y2="1"
                      >
                        <stop offset="5%" stopColor="#18181b" stopOpacity={0.12} />
                        <stop offset="95%" stopColor="#18181b" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      stroke="#ececf0"
                      vertical={false}
                    />
                    <XAxis
                      axisLine={false}
                      dataKey="date"
                      interval="preserveStartEnd"
                      minTickGap={38}
                      tick={{ fill: "#71717a", fontSize: 10 }}
                      tickFormatter={shortChartDate}
                      tickLine={false}
                    />
                    <YAxis
                      axisLine={false}
                      domain={[0, 100]}
                      tick={{ fill: "#71717a", fontSize: 10 }}
                      tickFormatter={(value) => `${value}%`}
                      tickLine={false}
                      ticks={[0, 25, 50, 75, 100]}
                      width={42}
                    />
                    <Tooltip
                      cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }}
                      formatter={(value) => [
                        percent(Number(value)),
                        "Citation rate",
                      ]}
                      isAnimationActive={false}
                      labelFormatter={chartDateLabel}
                    />
                    <Area
                      activeDot={{ fill: "#fff", r: 4, stroke: "#18181b", strokeWidth: 2 }}
                      dataKey="citationRate"
                      dot={false}
                      fill="url(#sourceCitationRate)"
                      isAnimationActive={false}
                      name="Citation rate"
                      stroke="#18181b"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      type="linear"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState
                  title="No trend data"
                  description="Citation history will appear after responses are captured."
                />
              )}
            </div>
          </Card>

          <Card className="product-detail-table">
            <CardHeader
              title="Prompts citing this source"
              description="Tracked prompts whose captured answers explicitly cited this domain."
              action={
                detail.summary.totalPrompts ? (
                  <span className="table-total">
                    {pluralize(detail.summary.totalPrompts, "prompt")}
                  </span>
                ) : undefined
              }
            />
            {promptRows.length ? (
              <>
                <DataTable
                  columns={[
                    { key: "prompt", label: "Prompt" },
                    { key: "country", label: "Country" },
                    { key: "citations", label: "Citations" },
                    { key: "captures", label: "Cited captures" },
                    { key: "urls", label: "Cited URLs" },
                    { key: "lastCited", label: "Last cited" },
                    { key: "open", label: "" },
                  ]}
                  rows={promptRows.map((prompt) => {
                    const responsePath = `/prompts/${prompt.queryId}/snapshots/${prompt.latestSnapshotId}`;
                    return {
                      id: prompt.queryId,
                      prompt: (
                        <Link className="product-prompt-link" to={responsePath}>
                          {prompt.prompt}
                        </Link>
                      ),
                      country: (
                        <CountryFlag
                          languageCode={prompt.languageCode}
                          locationCode={prompt.locationCode}
                        />
                      ),
                      citations: <strong>{compact(prompt.citationCount)}</strong>,
                      captures: compact(prompt.citedSnapshots),
                      urls: compact(prompt.citedUrls),
                      lastCited: dateTime(prompt.lastCitedAt),
                      open: (
                        <Button
                          asChild
                          className="product-response-button"
                          variant="secondary"
                        >
                          <Link to={responsePath}>View response</Link>
                        </Button>
                      ),
                    };
                  })}
                />
                {detail.prompts.length > pageSize ? (
                  <div className="table-pagination">
                    <span>
                      {promptOffset + 1}–
                      {Math.min(
                        promptOffset + promptRows.length,
                        detail.prompts.length,
                      )}{" "}
                      of {detail.prompts.length}
                    </span>
                    <div>
                      <Button
                        variant="secondary"
                        disabled={promptOffset === 0}
                        onClick={() =>
                          setPromptPagination({
                            pageKey,
                            offset: Math.max(0, promptOffset - pageSize),
                          })
                        }
                      >
                        <ChevronLeft size={14} /> Previous
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={
                          promptOffset + pageSize >= detail.prompts.length
                        }
                        onClick={() =>
                          setPromptPagination({
                            pageKey,
                            offset: promptOffset + pageSize,
                          })
                        }
                      >
                        Next <ChevronRight size={14} />
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState
                title="No citing prompts"
                description="Prompts will appear here after a captured answer cites this source."
              />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Cited pages"
              description="Pages from this domain explicitly referenced in captured answers."
              action={
                total ? (
                  <span className="table-total">{pluralize(total, "URL")}</span>
                ) : undefined
              }
            />
            {detail.urls.length ? (
              <>
                <DataTable
                  columns={[
                    { key: "page", label: "Page" },
                    { key: "citations", label: "Citations" },
                    { key: "captures", label: "Cited captures" },
                    { key: "lastCited", label: "Last cited" },
                    { key: "open", label: "", className: "source-url-action" },
                  ]}
                  rows={detail.urls.map((source) => ({
                    id: source.url,
                    page: (
                      <div className="source-url-cell">
                        <strong>{source.title || urlPathLabel(source.url)}</strong>
                        <span>
                          {source.sourceName
                            ? `${source.sourceName} · ${urlPathLabel(source.url)}`
                            : urlPathLabel(source.url)}
                        </span>
                      </div>
                    ),
                    citations: <strong>{compact(source.citationCount)}</strong>,
                    captures: compact(source.citedSnapshots),
                    lastCited: dateTime(source.lastCitedAt),
                    open: (
                      <a
                        aria-label={`Open ${source.title || source.url}`}
                        className="source-url-link"
                        href={source.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink size={15} />
                      </a>
                    ),
                  }))}
                />
                <div className="table-pagination">
                  <span>{firstItem}–{lastItem} of {total}</span>
                  <div>
                    <Button
                      variant="secondary"
                      disabled={!cursors.length || query.isFetching}
                      onClick={() =>
                        setPagination({
                          pageKey,
                          cursors: cursors.slice(0, -1),
                        })
                      }
                    >
                      <ChevronLeft size={14} /> Previous
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!query.data?.page.nextCursor || query.isFetching}
                      onClick={() => {
                        const nextCursor = query.data?.page.nextCursor;
                        if (!nextCursor) return;
                        setPagination({
                          pageKey,
                          cursors: [...cursors, nextCursor],
                        });
                      }}
                    >
                      Next <ChevronRight size={14} />
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <EmptyState
                title="No cited pages"
                description="This source has no cited URLs in the selected period."
              />
            )}
          </Card>
        </>
      ) : (
        <Card>
          <EmptyState
            title="Source unavailable"
            description="Citation details for this source could not be loaded."
          />
        </Card>
      )}
    </div>
  );
}

function entityRelationshipReason(reason: string): string {
  const labels: Record<string, string> = {
    owned_brand: "Configured owned brand",
    tracked_competitor: "Configured competitor",
    explicit_comparison: "Explicitly compared in the answer",
    alternative_or_substitute: "Presented as an alternative or substitute",
    explicit_rival: "Described as a rival",
    same_recommendation_set: "Recommended in the same option set",
    incidental_mention: "Mentioned without a competitive relationship",
    insufficient_context: "Relationship needs review",
    legacy_classifier: "Detected by the legacy extractor",
  };
  return labels[reason] ?? "Relationship needs review";
}

function entitySourceLabel(source: string): string {
  const labels: Record<string, string> = {
    workers_ai: "context model",
    dataforseo_entity: "provider entity",
    observed_domain: "observed domain",
    tracked_brand: "tracked identity",
  };
  return labels[source] ?? source;
}

function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debouncedValue;
}

interface TrackedEntityRow {
  id: string;
  name: string;
  kind: "owned" | "competitor";
  mentioned_snapshot_count: number;
}

interface DiscoveredEntityRow {
  id: string;
  canonical_name: string;
  entity_type: string;
  relationship: string;
  status: "candidate" | "ignored";
  period_snapshot_count: number;
  period_prompt_count: number;
  confidence: number | null;
  provider_corroborated: number;
  domain_corroborated: number;
  evidenceTier: "strong" | "moderate" | "weak";
  relationshipReason: string | null;
  latestSources: string[];
  latestEvidence: string[];
}

export function BrandsPage() {
  const { projectId, session, trackingSource } = useApp();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"tracked" | "discovered">("tracked");
  const [trackedSearch, setTrackedSearch] = useState("");
  const [trackedKind, setTrackedKind] = useState("all");
  const [discoveredSearch, setDiscoveredSearch] = useState("");
  const [discoveredGroup, setDiscoveredGroup] = useState<"all" | EntityGroupKey>("all");
  const [discoveredStatus, setDiscoveredStatus] = useState("candidate");
  const pageSize = 25;
  const debouncedTrackedSearch = useDebouncedValue(trackedSearch.trim());
  const debouncedDiscoveredSearch = useDebouncedValue(discoveredSearch.trim());
  const trackedScope = [
    projectId,
    trackingSource,
    debouncedTrackedSearch,
    trackedKind,
  ].join("\u0000");
  const discoveredScope = [
    projectId,
    trackingSource,
    debouncedDiscoveredSearch,
    discoveredGroup,
    discoveredStatus,
  ].join("\u0000");
  const [trackedPagination, setTrackedPagination] = useState({
    scope: "",
    cursors: [] as string[],
  });
  const [discoveredPagination, setDiscoveredPagination] = useState({
    scope: "",
    cursors: [] as string[],
  });
  const trackedCursors =
    trackedPagination.scope === trackedScope ? trackedPagination.cursors : [];
  const discoveredCursors =
    discoveredPagination.scope === discoveredScope
      ? discoveredPagination.cursors
      : [];
  const trackedCursor = trackedCursors.at(-1);
  const discoveredCursor = discoveredCursors.at(-1);
  const trackedParams = new URLSearchParams({
    projectId: projectId ?? "",
    source: trackingSource,
    limit: String(pageSize),
  });
  if (debouncedTrackedSearch) trackedParams.set("search", debouncedTrackedSearch);
  if (trackedKind !== "all") trackedParams.set("kind", trackedKind);
  if (trackedCursor) trackedParams.set("cursor", trackedCursor);
  const discoveredParams = new URLSearchParams({
    projectId: projectId ?? "",
    source: trackingSource,
    limit: String(pageSize),
    status: discoveredStatus,
  });
  if (debouncedDiscoveredSearch) {
    discoveredParams.set("search", debouncedDiscoveredSearch);
  }
  if (discoveredGroup !== "all") discoveredParams.set("group", discoveredGroup);
  if (discoveredCursor) discoveredParams.set("cursor", discoveredCursor);
  const canEdit = session.user.role !== "viewer";
  const query = useQuery({
    queryKey: [
      "brands",
      projectId,
      trackingSource,
      debouncedTrackedSearch,
      trackedKind,
      trackedCursor ?? "",
    ],
    queryFn: () => apiPage<TrackedEntityRow[]>(`/analytics/brands?${trackedParams}`),
    enabled: Boolean(projectId),
  });
  const discovered = useQuery({
    queryKey: [
      "entities",
      projectId,
      trackingSource,
      debouncedDiscoveredSearch,
      discoveredGroup,
      discoveredStatus,
      discoveredCursor ?? "",
    ],
    queryFn: () =>
      apiPage<DiscoveredEntityRow[]>(`/analytics/entities?${discoveredParams}`),
    enabled: Boolean(projectId),
  });
  const updateEntity = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "track" | "ignore" | "restore" }) =>
      patch(`/entities/${id}`, { action }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["brands", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["entities", projectId] }),
      ]);
    },
  });
  if (!projectId) return <NoProject />;
  const tracked = query.data?.data ?? [];
  const candidates = discovered.data?.data ?? [];
  const trackedTotal = query.data?.page.total ?? 0;
  const discoveredTotal = discovered.data?.page.total ?? 0;
  const trackedOffset = trackedCursors.length * pageSize;
  const discoveredOffset = discoveredCursors.length * pageSize;
  const groupedCandidates = ENTITY_GROUPS.map((group) => ({
    ...group,
    entities: candidates.filter(
      (entity) => entityGroup(entity.entity_type) === group.key,
    ),
  })).filter((group) => group.entities.length);
  return (
    <div className="page">
      <PageHeader
        title="Entities"
        description="Track owned brands and competitors, and review entities discovered contextually in captured answers."
        action={
          <Button
            variant="secondary"
            disabled={query.isFetching || discovered.isFetching}
            onClick={() => void Promise.all([query.refetch(), discovered.refetch()])}
          >
            <RefreshCw size={14} />
            {query.isFetching || discovered.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
      <div className="entity-tabs" role="tablist" aria-label="Entity views">
        <button aria-selected={view === "tracked"} className={view === "tracked" ? "active" : undefined} onClick={() => setView("tracked")} role="tab" type="button">Tracked <span>{trackedTotal}</span></button>
        <button aria-selected={view === "discovered"} className={view === "discovered" ? "active" : undefined} onClick={() => setView("discovered")} role="tab" type="button">Discovered <span>{discoveredTotal}</span></button>
      </div>
      {view === "tracked" ? (
        <Card className="tracked-entities-card">
          <CardHeader title="Tracked entities" description="Owned brands and competitors included in visibility reporting." />
          <div className="entity-filter-bar">
            <Input
              aria-label="Search tracked entities"
              maxLength={200}
              onChange={(event) => setTrackedSearch(event.target.value)}
              placeholder="Search entities"
              type="search"
              value={trackedSearch}
            />
            <Select
              ariaLabel="Filter tracked entities by role"
              onValueChange={setTrackedKind}
              options={[
                { value: "all", label: "All roles" },
                { value: "owned", label: "Owned" },
                { value: "competitor", label: "Competitors" },
              ]}
              value={trackedKind}
            />
          </div>
          {query.isPending ? <TableSkeleton rows={pageSize} columns={3} /> : tracked.length ? (
            <>
              <DataTable
                columns={[
                  { key: "entity", label: "Entity" },
                  { key: "role", label: "Role" },
                  { key: "mentions", label: "Mentioning snapshots" },
                ]}
                rows={tracked.map((brand) => ({
                  id: brand.id,
                  entity: <strong>{brand.name}</strong>,
                  role: <Badge tone={brand.kind === "owned" ? "info" : "neutral"}>{brand.kind === "owned" ? "Owned" : "Competitor"}</Badge>,
                  mentions: <strong>{compact(Number(brand.mentioned_snapshot_count))}</strong>,
                }))}
              />
              {trackedTotal > pageSize ? (
                <div className="table-pagination">
                  <span>{trackedOffset + 1}–{Math.min(trackedOffset + tracked.length, trackedTotal)} of {trackedTotal} entities</span>
                  <div>
                    <Button
                      disabled={!trackedCursors.length || query.isFetching}
                      onClick={() => setTrackedPagination({
                        scope: trackedScope,
                        cursors: trackedCursors.slice(0, -1),
                      })}
                      variant="secondary"
                    >
                      <ChevronLeft size={14} /> Previous
                    </Button>
                    <Button
                      disabled={!query.data?.page.nextCursor || query.isFetching}
                      onClick={() => {
                        const nextCursor = query.data?.page.nextCursor;
                        if (!nextCursor) return;
                        setTrackedPagination({
                          scope: trackedScope,
                          cursors: [...trackedCursors, nextCursor],
                        });
                      }}
                      variant="secondary"
                    >
                      Next <ChevronRight size={14} />
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : trackedSearch.trim() || trackedKind !== "all" ? (
            <EmptyState title="No matching entities" description="Adjust the search or role filter." />
          ) : (
            <EmptyState title="No tracked entities" description="Configure an owned brand or track a discovered competitor." />
          )}
        </Card>
      ) : (
        <Card className="entity-discovery-card">
          <CardHeader title="Discovered entities" description="Names extracted from captured responses. Brands appear first because they are the most likely competitor candidates." />
          <div className="entity-filter-bar entity-discovery-filters">
            <Input
              aria-label="Search discovered entities"
              maxLength={200}
              onChange={(event) => setDiscoveredSearch(event.target.value)}
              placeholder="Search entities"
              type="search"
              value={discoveredSearch}
            />
            <Select
              ariaLabel="Filter discovered entities by type"
              onValueChange={(value) => setDiscoveredGroup(value as "all" | EntityGroupKey)}
              options={[{ value: "all", label: "All types" }, ...ENTITY_GROUPS.map((group) => ({ value: group.key, label: group.label }))]}
              value={discoveredGroup}
            />
            <Select
              ariaLabel="Filter discovered entities by status"
              onValueChange={setDiscoveredStatus}
              options={[
                { value: "candidate", label: "Candidates" },
                { value: "ignored", label: "Ignored" },
                { value: "all", label: "All statuses" },
              ]}
              value={discoveredStatus}
            />
          </div>
          {discovered.isPending ? <TableSkeleton rows={pageSize} /> : groupedCandidates.length ? (
            <>
              <div className="entity-discovery-groups">
                {groupedCandidates.map((group) => (
                  <section className="entity-discovery-group" key={group.key}>
                    <header><h4>{group.label}</h4><span>{group.entities.length} on this page</span></header>
                    <div className="entity-discovery-list">
                      {group.entities.map((entity) => (
                      <div className={entity.status === "ignored" ? "ignored" : undefined} key={entity.id}>
                        <div className="entity-discovery-copy">
                          <div>
                            <strong>{entity.canonical_name}</strong>
                            <Badge tone={entity.relationship === "competitor" ? "warning" : "neutral"}>
                              {entity.relationship === "competitor"
                                ? entity.evidenceTier === "strong" ? "Likely competitor" : "Possible competitor"
                                : entity.relationship}
                            </Badge>
                            <Badge tone={entity.evidenceTier === "strong" ? "success" : "neutral"}>
                              {entity.evidenceTier === "strong"
                                ? "Strong evidence"
                                : entity.evidenceTier === "moderate" ? "Corroborated" : "Needs review"}
                            </Badge>
                            {entity.status === "ignored" ? <Badge>Ignored</Badge> : null}
                          </div>
                          <span>{compact(entity.period_snapshot_count)} responses · {compact(entity.period_prompt_count)} prompts</span>
                          {entity.relationshipReason ? (
                            <span>{entityRelationshipReason(entity.relationshipReason)}{entity.latestSources.length ? ` · ${entity.latestSources.map(entitySourceLabel).join(", ")}` : ""}</span>
                          ) : null}
                          {entity.latestEvidence[0] ? (
                            <details className="entity-evidence">
                              <summary>Show evidence</summary>
                              <p>“{entity.latestEvidence[0]}”</p>
                            </details>
                          ) : null}
                        </div>
                        {canEdit ? <div className="entity-discovery-actions">
                          {entity.status === "ignored" ? (
                            <Button disabled={updateEntity.isPending} onClick={() => updateEntity.mutate({ id: entity.id, action: "restore" })} variant="secondary">Restore</Button>
                          ) : (
                            <>
                              {group.key === "brands" || group.key === "companies" ? <Button disabled={updateEntity.isPending} onClick={() => updateEntity.mutate({ id: entity.id, action: "track" })}>Track competitor</Button> : null}
                              <Button disabled={updateEntity.isPending} onClick={() => updateEntity.mutate({ id: entity.id, action: "ignore" })} variant="ghost">Ignore</Button>
                            </>
                          )}
                        </div> : null}
                      </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
              {discoveredTotal > pageSize ? (
                <div className="table-pagination">
                  <span>{discoveredOffset + 1}–{Math.min(discoveredOffset + candidates.length, discoveredTotal)} of {discoveredTotal} entities</span>
                  <div>
                    <Button
                      disabled={!discoveredCursors.length || discovered.isFetching}
                      onClick={() => setDiscoveredPagination({
                        scope: discoveredScope,
                        cursors: discoveredCursors.slice(0, -1),
                      })}
                      variant="secondary"
                    >
                      <ChevronLeft size={14} /> Previous
                    </Button>
                    <Button
                      disabled={!discovered.data?.page.nextCursor || discovered.isFetching}
                      onClick={() => {
                        const nextCursor = discovered.data?.page.nextCursor;
                        if (!nextCursor) return;
                        setDiscoveredPagination({
                          scope: discoveredScope,
                          cursors: [...discoveredCursors, nextCursor],
                        });
                      }}
                      variant="secondary"
                    >
                      Next <ChevronRight size={14} />
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : debouncedDiscoveredSearch || discoveredGroup !== "all" ? (
            <EmptyState title="No matching entities" description="Adjust the search, type, or status filters." />
          ) : discoveredStatus === "ignored" ? (
            <EmptyState title="No ignored entities" description="Entities you ignore will appear here." />
          ) : discoveredStatus === "candidate" ? (
            <EmptyState title="No candidate entities" description="Newly discovered entities will appear after extraction completes." />
          ) : <EmptyState title="No discovered entities yet" description="Entity extraction runs asynchronously after captured responses are normalized." />}
        </Card>
      )}
    </div>
  );
}

export function ProductsPage() {
  const { projectId } = useApp();
  const query = useProjectAnalytics<Array<Record<string, string | number | null>>>("products");
  if (!projectId) return <NoProject />;
  return (
    <div className="page">
      <PageHeader title="Product appearances" description="Products and merchants surfaced in ChatGPT shopping blocks." />
      <div className="products-grid">
        {query.isPending ? Array.from({ length: 4 }, (_, index) => (
          <Skeleton className="product-card-skeleton" key={index} />
        )) : query.data?.length ? query.data.map((product) => {
          let image: string | null = null;
          try {
            const images = JSON.parse(String(product.images_json ?? "[]")) as string[];
            image = images[0] ?? null;
          } catch {
            // Provider image metadata is optional and may be malformed.
          }
          return (
            <Card className="product-card" key={String(product.id)}>
              <div className="product-image">{image ? <img src={image} alt="" loading="lazy" /> : <ShoppingBag />}</div>
              <div className="product-body"><span>{product.registrable_domain}</span><h3>{product.title}</h3><p>{product.tag}</p><div><strong>{product.price ? `${product.price} ${product.currency ?? ""}` : "Price unavailable"}</strong>{product.raw_url ? <a href={String(product.raw_url)} target="_blank" rel="noreferrer"><ExternalLink size={15}/></a> : null}</div></div>
            </Card>
          );
        }) : <Card><EmptyState title="No products found" description="Product blocks will be catalogued when ChatGPT returns them." /></Card>}
      </div>
    </div>
  );
}

interface ShoppingRow {
  id: string;
  productKey: string;
  title: string | null;
  merchants: string | null;
  registrable_domain: string | null;
  price: number | null;
  currency: string | null;
  canonical_url: string | null;
  raw_url: string | null;
  rating_value: number | null;
  rating_votes_count: number | null;
  images: string[];
  product_ids: unknown[];
  appearances: number;
  latestSeen: string;
  enriched: boolean;
}

function EnrichedProductIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M20.1765 12.5113C19.8261 9.50898 19.3142 7.25784 18.8394 5.65851C18.4501 4.34711 18.2554 3.69141 17.4572 3.0957C16.659 2.5 15.8431 2.5 14.2113 2.5H8.78876C7.15697 2.5 6.34107 2.5 5.54283 3.0957C4.74459 3.69141 4.54994 4.34711 4.16063 5.65851C3.68586 7.25784 3.1739 9.50898 2.82352 12.5113C2.41058 16.0497 2.20411 17.8189 3.39731 19.1594C4.59052 20.5 6.52422 20.5 10.3916 20.5H11.6084" />
      <path d="M8.5 6.5C8.5 8.15685 9.84315 9.5 11.5 9.5C13.1569 9.5 14.5 8.15685 14.5 6.5" />
      <path d="M14.5 19.5C14.5 19.5 15.5 19.5 16.5 21.5C16.5 21.5 18.6765 16.5 21.5 15.5" />
    </svg>
  );
}

export function ShoppingPage() {
  const { projectId, trackingSource } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("search") ?? "";
  const country = searchParams.get("country") ?? "";
  const enrichmentParam = searchParams.get("enrichment");
  const enrichment =
    enrichmentParam === "enriched" || enrichmentParam === "not_enriched"
      ? enrichmentParam
      : "";
  const selectedTagIds = (searchParams.get("tags") ?? "")
    .split(",")
    .filter(Boolean);
  const tagKey = selectedTagIds.join(",");
  const pageSize = 10;
  const pageScope = [projectId, trackingSource, search, country, tagKey, enrichment].join("\u0000");
  const [pagination, setPagination] = useState({
    scope: "",
    cursors: [] as string[],
  });
  const cursors = pagination.scope === pageScope ? pagination.cursors : [];
  const cursor = cursors.at(-1);
  const pageOffset = cursors.length * pageSize;
  const tags = useQuery({
    queryKey: ["prompt-tags", projectId],
    queryFn: () => api<PromptTag[]>(`/projects/${projectId}/tags`),
    enabled: Boolean(projectId),
  });
  const selectedFilterTags = selectedTagIds
    .map((id) => tags.data?.find((tag) => tag.id === id))
    .filter((tag): tag is PromptTag => Boolean(tag));
  const reportParams = new URLSearchParams({
    projectId: projectId ?? "",
    source: trackingSource,
    limit: String(pageSize),
  });
  if (cursor) reportParams.set("cursor", cursor);
  if (search) reportParams.set("search", search);
  if (country) reportParams.set("locationCode", country);
  if (selectedTagIds.length) reportParams.set("tagIds", tagKey);
  if (enrichment) reportParams.set("enrichment", enrichment);
  const query = useQuery({
    queryKey: [
      "shopping",
      projectId,
      trackingSource,
      search,
      country,
      tagKey,
      enrichment,
      cursor ?? "",
    ],
    queryFn: () =>
      apiPage<ShoppingRow[]>(
        `/analytics/shopping?${reportParams}`,
      ),
    enabled: Boolean(projectId),
    placeholderData: (previous) => previous,
  });
  if (!projectId) return <NoProject />;
  const products = query.data?.data ?? [];
  const total = query.data?.page.total ?? 0;
  const firstItem = total ? pageOffset + 1 : 0;
  const lastItem = Math.min(pageOffset + products.length, total);
  return (
    <div className="page">
      <PageHeader
        eyebrow="Last 30 days"
        title="Shopping"
        description="Deduplicated products surfaced in captured shopping blocks."
      />
      <div className="report-filters shopping-report-filters">
        <div className="search-filter">
          <Search size={15} />
          <Input
            aria-label="Search products"
            placeholder="Search products or merchants"
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
          options={[
            { value: "all", label: "All countries" },
            ...LOCATION_OPTIONS,
          ]}
        />
        <Select
          value={enrichment || "all"}
          onValueChange={(value) => {
            const next = new URLSearchParams(searchParams);
            if (value === "all") next.delete("enrichment");
            else next.set("enrichment", value);
            setSearchParams(next, { replace: true });
          }}
          options={[
            { value: "all", label: "All product data" },
            {
              value: "enriched",
              label: "Enriched",
              icon: <EnrichedProductIcon />,
            },
            { value: "not_enriched", label: "Not enriched" },
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
          <span>Products from prompts matching every tag:</span>
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
      <Card>
        <CardHeader
          title={query.isPending ? "Products" : pluralize(total, "product")}
          description="The latest product details are shown; appearances count every captured occurrence."
        />
        {query.isPending ? (
          <TableSkeleton rows={pageSize} columns={5} />
        ) : products.length ? (
          <>
            <DataTable
              columns={[
                { key: "product", label: "Product" },
                { key: "merchant", label: "Merchant" },
                { key: "price", label: "Latest price" },
                { key: "rating", label: "Rating" },
                { key: "appearances", label: "Appearances" },
                { key: "seen", label: "Latest seen" },
                { key: "action", label: "" },
              ]}
              rows={products.map((product) => {
                return {
                  id: product.productKey,
                  name: product.title ?? "Untitled product",
                  product: (
                    <div className="shopping-table-product">
                      <span className="shopping-table-image">
                        {product.images[0] ? (
                          <img src={product.images[0]} alt="" loading="lazy" />
                        ) : (
                          <ShoppingBag size={17} />
                        )}
                      </span>
                      <span className="shopping-table-product-title">
                        <strong>{product.title ?? "Untitled product"}</strong>
                        {product.enriched ? (
                          <span
                            className="enriched-product-icon"
                            title="Enriched product data available"
                          >
                            <EnrichedProductIcon size={15} />
                          </span>
                        ) : null}
                      </span>
                    </div>
                  ),
                  merchant: product.merchants ?? product.registrable_domain ?? "—",
                  price:
                    product.price === null
                      ? "—"
                      : <strong>{product.price} {product.currency ?? ""}</strong>,
                  rating:
                    product.rating_value === null
                      ? "—"
                      : `${product.rating_value}${product.rating_votes_count ? ` · ${compact(product.rating_votes_count)} reviews` : ""}`,
                  appearances: <strong>{compact(product.appearances)}</strong>,
                  seen: dateTime(product.latestSeen),
                  action: <ChevronRight className="source-row-chevron" size={16} />,
                };
              })}
              onRowClick={(row) => {
                const key = tableRowId(row);
                if (key) void navigate(`/shopping/${key}`);
              }}
              rowAriaLabel={(row) =>
                `Open product analytics for ${
                  typeof row.name === "string" ? row.name : "product"
                }`
              }
            />
            <div className="table-pagination">
              <span>{firstItem}–{lastItem} of {total}</span>
              <div>
                <Button
                  variant="secondary"
                  disabled={!cursors.length || query.isFetching}
                  onClick={() =>
                    setPagination({
                      scope: pageScope,
                      cursors: cursors.slice(0, -1),
                    })
                  }
                >
                  <ChevronLeft size={14} /> Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={!query.data?.page.nextCursor || query.isFetching}
                  onClick={() => {
                    const nextCursor = query.data?.page.nextCursor;
                    if (!nextCursor) return;
                    setPagination({
                      scope: pageScope,
                      cursors: [...cursors, nextCursor],
                    });
                  }}
                >
                  Next <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            title={
              search || country || selectedTagIds.length || enrichment
                ? "No matching products"
                : "No shopping products"
            }
            description={
              search || country || selectedTagIds.length || enrichment
                ? "Try changing or clearing the product filters."
                : "Products will appear when a captured answer contains a shopping block."
            }
          />
        )}
      </Card>
    </div>
  );
}

interface ProductAnalyticsDetail {
  product: ShoppingRow & {
    ordinal: number;
    rating_max: number | null;
  };
  range: {
    from: string;
    to: string;
    period: "7d" | "30d" | "90d" | "365d";
  };
  summary: {
    completedRuns: number;
    appearingCaptures: number;
    winningCaptures: number;
    appearanceRate: number;
    winRate: number;
    appearances: number;
    prompts: number;
    merchants: number;
    firstSeen: string;
    latestSeen: string;
    latestPosition: number;
    averagePosition: number | null;
    price: {
      currency: string | null;
      latest: number | null;
      minimum: number;
      maximum: number;
      change: number | null;
      changePercent: number | null;
    } | null;
    rating: {
      value: number | null;
      maximum: number | null;
      reviews: number | null;
      reviewChange: number | null;
      ratingChange: number | null;
    } | null;
    comparison: {
      range: { from: string; to: string };
      appearanceRate: { previous: number | null; delta: number | null };
      winRate: { previous: number | null; delta: number | null };
      averagePosition: { previous: number | null; delta: number | null };
      appearances: { previous: number; delta: number };
      price: {
        currency: string | null;
        previous: number | null;
        delta: number | null;
        deltaPercent: number | null;
      } | null;
      rating: {
        previousValue: number | null;
        valueDelta: number | null;
        previousReviews: number | null;
        reviewsDelta: number | null;
      } | null;
    };
  };
  visibilityTrend: Array<{
    date: string;
    completedRuns: number;
    appearingCaptures: number;
    winningCaptures: number;
    appearances: number;
    appearanceRate: number;
    winRate: number | null;
    averagePosition: number | null;
  }>;
  priceTrend: Array<{
    date: string;
    currency: string | null;
    latest: number;
    minimum: number;
    maximum: number;
  }>;
  reviewTrend: Array<{
    date: string;
    rating: number | null;
    ratingMaximum: number | null;
    reviews: number | null;
  }>;
  prompts: Array<{
    queryId: string;
    prompt: string;
    locationCode: number;
    languageCode: string;
    appearances: number;
    captures: number;
    latestSeen: string;
    latestSnapshotId: string;
    latestPosition: number;
    latestPrice: number | null;
    latestCurrency: string | null;
  }>;
  merchants: Array<{
    merchant: string;
    appearances: number;
    latestSeen: string;
    latestRating: number | null;
    latestReviews: number | null;
    prices: Array<{
      currency: string | null;
      latest: number;
      minimum: number;
      maximum: number;
    }>;
  }>;
  occurrences: Array<{
    id: string;
    snapshotId: string;
    queryId: string;
    prompt: string;
    locationCode: number;
    languageCode: string;
    capturedAt: string;
    merchant: string | null;
    position: number;
    rankAbsolute: number | null;
    price: number | null;
    currency: string | null;
    rating: number | null;
    ratingMaximum: number | null;
    reviews: number | null;
  }>;
  competition: {
    current: PositionDistribution | null;
    coFeatured: Array<{
      product: ShoppingRow & { ordinal: number; rating_max: number | null };
      appearances: number;
      coFeaturedCaptures: number;
      coFeatureRate: number;
      winningCaptures: number;
      winRate: number;
      averagePosition: number | null;
      distribution: PositionDistribution | null;
    }>;
  };
  market: {
    locales: Array<{
      locationCode: number;
      languageCode: string;
      status: string;
    }>;
    selectedLocale: {
      locationCode: number;
      languageCode: string;
    } | null;
    policy: {
      projectEnabled: boolean;
      automaticRefreshEnabled: boolean;
    };
    refresh: {
      targetId: string | null;
      status: string;
      pending: boolean;
      supported: boolean;
      lastCompletedAt: string | null;
      nextEligibleAt: string | null;
      lastError: string | null;
    };
    profile: {
      title: string | null;
      description: string | null;
      tags: string[];
      images: string[];
      features: string[];
      specifications: Array<Record<string, unknown>>;
      variations: Array<Record<string, unknown>>;
      productUrl: string | null;
      sourceDomain: string | null;
      capturedAt: string;
      rating: {
        value: number | null;
        maximum: number | null;
        reviews: number | null;
      };
    } | null;
    summary: {
      sellerCount: number;
      inStockCount: number;
      prices: Array<{
        currency: string | null;
        minimum: number;
        median: number;
        maximum: number;
      }>;
      ownedOffer: {
        seller: string | null;
        price: number | null;
        currency: string | null;
        differenceFromLowest: number | null;
      } | null;
    } | null;
    priceTrend: Array<{
      date: string;
      currency: string | null;
      minimum: number;
      median: number;
      maximum: number;
    }>;
    offerTrend: Array<{
      date: string;
      sellers: number;
      inStock: number;
    }>;
    offers: Array<{
      id: string;
      seller: string | null;
      url: string | null;
      domain: string | null;
      rating: number | null;
      ratingMaximum: number | null;
      reviews: number | null;
      price: number | null;
      regularPrice: number | null;
      maximumPrice: number | null;
      currency: string | null;
      isPriceRange: boolean;
      displayedPrice: string | null;
      delivery: string | null;
      availability: string | null;
      owned: boolean;
    }>;
  };
}

interface PositionDistribution {
  count: number;
  minimum: number;
  firstQuartile: number;
  median: number;
  thirdQuartile: number;
  maximum: number;
}

function observedPrice(
  value: number | null,
  currency: string | null,
): string | null {
  if (value === null) return null;
  if (currency) return formatPrice(value, currency);
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

function priceRangeLabel(
  prices: ProductAnalyticsDetail["merchants"][number]["prices"],
): string {
  if (!prices.length) return "—";
  return prices
    .map((price) => {
      const minimum = observedPrice(price.minimum, price.currency) ?? "—";
      const maximum = observedPrice(price.maximum, price.currency) ?? "—";
      return price.minimum === price.maximum ? minimum : `${minimum}–${maximum}`;
    })
    .join(" · ");
}

function ProductSectionHeading({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="product-detail-section-heading">
      <div className="product-detail-section-title">
        <span className="product-detail-section-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

export function ProductMetricCard({
  icon,
  label,
  value,
  description,
  help,
  delta,
  deltaTone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  description: string;
  help: string;
  delta: string;
  deltaTone?: "positive" | "negative" | "neutral";
}) {
  return (
    <article className="product-metric-card">
      <div className="product-metric-label">
        <span>{icon}{label}</span>
        <span aria-label={help} className="product-metric-help" title={help}>
          <CircleHelp size={13} />
        </span>
      </div>
      <strong>{value}</strong>
      <span className={`product-metric-delta is-${deltaTone}`}>{delta}</span>
      <small>{description}</small>
    </article>
  );
}

function percentagePointDelta(value: number | null): string {
  if (value === null) return "No previous-period data";
  if (Math.abs(value) < 0.05) return "No change vs previous period";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)} pp vs previous period`;
}

function deltaTone(
  value: number | null,
  invert = false,
): "positive" | "negative" | "neutral" {
  if (value === null || Math.abs(value) < 0.0001) return "neutral";
  return (invert ? value < 0 : value > 0) ? "positive" : "negative";
}

function positionDelta(value: number | null): string {
  if (value === null) return "No previous-period data";
  if (Math.abs(value) < 0.05) return "No change vs previous period";
  return `${Math.abs(value).toFixed(1)} ${value < 0 ? "better" : "worse"} vs previous period`;
}

export function RankComparisonChart({
  product,
  competition,
}: {
  product: ProductAnalyticsDetail["product"];
  competition: ProductAnalyticsDetail["competition"];
}) {
  const items: Array<{
    key: string;
    title: string;
    image: string | null;
    current: boolean;
    distribution: PositionDistribution;
  }> = [];
  if (competition.current) {
    items.push({
      key: product.productKey,
      title: product.title ?? "Current product",
      image: product.images[0] ?? null,
      current: true,
      distribution: competition.current,
    });
  }
  for (const competitor of competition.coFeatured.slice(0, 4)) {
    if (!competitor.distribution) continue;
    items.push({
      key: competitor.product.productKey,
      title: competitor.product.title ?? "Untitled product",
      image: competitor.product.images[0] ?? null,
      current: false,
      distribution: competitor.distribution,
    });
  }
  if (!items.length) {
    return <EmptyState title="No rank comparison yet" description="Rank distributions appear after this product is captured with other recommendations." />;
  }
  const maximum = Math.max(
    2,
    ...items.map((item) => item.distribution.maximum),
  );
  const scale = (position: number) =>
    ((position - 1) / Math.max(1, maximum - 1)) * 100;
  return (
    <div className="product-rank-chart" style={{ "--rank-columns": items.length } as CSSProperties}>
      <div className="product-rank-axis" aria-hidden="true">
        <span>#1</span>
        <span>#{Math.max(2, Math.ceil(maximum / 2))}</span>
        <span>#{maximum}</span>
      </div>
      <div className="product-rank-series">
        {items.map((item, index) => {
          const distribution = item.distribution;
          const color = item.current
            ? "#1e73be"
            : ["#38a169", "#e58b32", "#2f80ed", "#d45d5d"][index - 1] ?? "#71717a";
          const title = `${item.title}: median #${distribution.median.toFixed(1)}, range #${distribution.minimum}–#${distribution.maximum}, ${pluralize(distribution.count, "capture")}`;
          return (
            <div className="product-rank-column" key={item.key} title={title}>
              <div className="product-rank-track" style={{ color }}>
                {distribution.count === 1 ? (
                  <span className="product-rank-point" style={{ top: `${scale(distribution.median)}%` }} />
                ) : (
                  <>
                    <span className="product-rank-whisker" style={{ height: `${scale(distribution.maximum) - scale(distribution.minimum)}%`, top: `${scale(distribution.minimum)}%` }} />
                    <span className="product-rank-cap" style={{ top: `${scale(distribution.minimum)}%` }} />
                    <span className="product-rank-cap" style={{ top: `${scale(distribution.maximum)}%` }} />
                    <span className="product-rank-box" style={{ height: `${Math.max(1.5, scale(distribution.thirdQuartile) - scale(distribution.firstQuartile))}%`, top: `${scale(distribution.firstQuartile)}%` }} />
                    <span className="product-rank-median" style={{ top: `${scale(distribution.median)}%` }} />
                  </>
                )}
              </div>
              <div className="product-rank-label">
                <span className="product-rank-image">
                  {item.image ? <img alt="" src={item.image} /> : <ShoppingBag size={14} />}
                </span>
                <strong>{item.title}</strong>
                {item.current ? <Badge>This product</Badge> : null}
                <small>Median #{distribution.median.toFixed(1)} · {pluralize(distribution.count, "capture")}</small>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ProductMarket = ProductAnalyticsDetail["market"];

function productMarketLocaleLabel(locationCode: number, languageCode: string) {
  const location = LOCATION_OPTIONS.find(
    (option) => option.value === String(locationCode),
  )?.label;
  return `${location ?? `Location ${locationCode}`} · ${languageCode.toUpperCase()}`;
}

function ProductMarketSection({
  market,
  productTitle,
  canEdit,
  refreshPending,
  policyPending,
  onLocaleChange,
  onRefresh,
  onPolicyChange,
}: {
  market: ProductMarket;
  productTitle: string | null;
  canEdit: boolean;
  refreshPending: boolean;
  policyPending: boolean;
  onLocaleChange: (value: string) => void;
  onRefresh: () => void;
  onPolicyChange: (enabled: boolean) => void;
}) {
  const enrichmentUnavailable = !market.refresh.supported;
  const refreshStatusLabel = market.refresh.pending
    ? "Refreshing"
    : market.refresh.status === "available"
      ? "Current"
      : enrichmentUnavailable
        ? "Unavailable"
        : market.refresh.status;
  const currency = market.summary?.prices[0]?.currency ?? null;
  const priceTrend = currency
    ? market.priceTrend.filter((point) => point.currency === currency)
    : [];
  const locale = market.selectedLocale
    ? productMarketLocaleLabel(
        market.selectedLocale.locationCode,
        market.selectedLocale.languageCode,
      )
    : "selected market";
  const specificationRows = productDetailRows(market.profile?.specifications ?? []);
  const variationRows = productDetailRows(market.profile?.variations ?? []);
  return (
    <>
      <Card className="product-market-control">
        <div className="product-market-control-copy">
          <div className="product-section-heading">
            <span>Enrichment status</span>
            <Badge
              tone={market.refresh.status === "available" ? "success" : market.refresh.status === "failed" ? "danger" : market.refresh.pending ? "warning" : "neutral"}
            >
              {refreshStatusLabel}
            </Badge>
          </div>
          <p>Product specifications, seller offers, availability, and market pricing for one Google Shopping locale.</p>
          <span>
            {market.refresh.lastCompletedAt
              ? `Updated ${dateTime(market.refresh.lastCompletedAt)}${market.refresh.nextEligibleAt ? ` · Next automatic refresh ${dateTime(market.refresh.nextEligibleAt)}` : ""}`
              : "The first enrichment is queued when this product is viewed."}
          </span>
          {market.refresh.lastError ? <span className="product-market-error">{market.refresh.lastError}</span> : null}
        </div>
        <div className="product-market-controls">
          <Select
            value={market.selectedLocale ? `${market.selectedLocale.locationCode}:${market.selectedLocale.languageCode}` : ""}
            onValueChange={onLocaleChange}
            options={market.locales.map((item) => ({
              value: `${item.locationCode}:${item.languageCode}`,
              label: productMarketLocaleLabel(item.locationCode, item.languageCode),
            }))}
          />
          <Button
            variant="secondary"
            disabled={!canEdit || !market.policy.projectEnabled || !market.selectedLocale || enrichmentUnavailable || refreshPending}
            onClick={onRefresh}
            title={enrichmentUnavailable
              ? "This capture did not include a Google Shopping product identifier."
              : undefined}
          >
            <RefreshCw size={14} /> {refreshPending ? "Queueing…" : "Refresh now"}
          </Button>
          {canEdit ? (
            <label className="product-market-auto">
              <input
                checked={market.policy.automaticRefreshEnabled}
                disabled={policyPending}
                onChange={(event) => onPolicyChange(event.target.checked)}
                type="checkbox"
              />
              Weekly auto-refresh
            </label>
          ) : null}
        </div>
        {!market.policy.projectEnabled ? (
          <div className="product-market-paused"><AlertTriangle size={14} /><span>Product enrichment is paused for this project.</span>{canEdit ? <Link to="/settings">Open settings <ChevronRight size={12} /></Link> : null}</div>
        ) : null}
        {market.policy.projectEnabled && enrichmentUnavailable ? (
          <div className="product-market-paused">
            <AlertTriangle size={14} /> Google Shopping data is unavailable because captured responses did not include a compatible product identifier. A future eligible capture will enable enrichment automatically.
          </div>
        ) : null}
      </Card>

      {market.profile && market.summary ? (
        <>
          <div className="product-market-summary-grid">
            <Card className="source-summary-card">
              <span>Market price</span>
              <strong>{market.summary.prices[0] ? observedPrice(market.summary.prices[0].median, market.summary.prices[0].currency) : "—"}</strong>
              <small>{market.summary.prices[0] ? `${observedPrice(market.summary.prices[0].minimum, market.summary.prices[0].currency)}–${observedPrice(market.summary.prices[0].maximum, market.summary.prices[0].currency)} across offers` : "No comparable offer prices"}</small>
            </Card>
            <Card className="source-summary-card">
              <span>Sellers</span><strong>{compact(market.summary.sellerCount)}</strong><small>{compact(market.summary.inStockCount)} reporting in stock</small>
            </Card>
            <Card className="source-summary-card">
              <span>Google product rating</span>
              <strong>{market.profile.rating.value ?? "—"}{market.profile.rating.maximum ? `/${market.profile.rating.maximum}` : ""}</strong>
              <small>{market.profile.rating.reviews === null ? "Review count unavailable" : `${compact(market.profile.rating.reviews)} ratings`}</small>
            </Card>
            <Card className="source-summary-card">
              <span>Owned seller position</span>
              <strong>{market.summary.ownedOffer?.price !== null && market.summary.ownedOffer ? observedPrice(market.summary.ownedOffer.price, market.summary.ownedOffer.currency) : "Not found"}</strong>
              <small>{!market.summary.ownedOffer || market.summary.ownedOffer.differenceFromLowest === null ? "No owned offer comparison" : market.summary.ownedOffer.differenceFromLowest === 0 ? "Matches the lowest offer" : `${observedPrice(market.summary.ownedOffer.differenceFromLowest, market.summary.ownedOffer.currency)} above the lowest offer`}</small>
            </Card>
          </div>

          <div className="product-market-grid">
            <Card className="product-market-profile">
              <CardHeader
                title="Product profile"
                description={`Provider snapshot from ${dateTime(market.profile.capturedAt)}`}
                action={market.profile.productUrl ? <Button asChild variant="secondary"><a href={market.profile.productUrl} target="_blank" rel="noreferrer">Google listing <ExternalLink size={13} /></a></Button> : null}
              />
              <CardContent>
                <div className="product-market-profile-body">
                  {market.profile.images.length ? <div className="product-market-images">{market.profile.images.slice(0, 6).map((image) => <img alt="" key={image} loading="lazy" src={image} />)}</div> : null}
                  <div className="product-market-profile-copy">
                    <strong>{market.profile.title ?? productTitle}</strong>
                    {market.profile.description ? <p>{market.profile.description}</p> : null}
                    {market.profile.tags.length ? <div className="product-market-tags">{market.profile.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</div> : null}
                    {market.profile.features.length ? <ul>{market.profile.features.map((feature) => <li key={feature}>{feature}</li>)}</ul> : null}
                  </div>
                </div>
                {specificationRows.length || variationRows.length ? (
                  <details className="product-market-details">
                    <summary>Specifications and variations</summary>
                    <div className="product-market-detail-groups">
                      {specificationRows.length ? (
                        <div><h4>Specifications</h4><dl>{specificationRows.map((row, index) => <div key={`${row.label}-${index}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></div>
                      ) : null}
                      {variationRows.length ? (
                        <div><h4>Variations</h4><dl>{variationRows.map((row, index) => <div key={`${row.label}-${index}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </CardContent>
            </Card>
            <Card className="product-chart-card">
              <CardHeader title="Market price range" description={currency ? `Offer minimum, median, and maximum in ${currency}.` : "Comparable offer prices over time."} />
              <div className="product-chart">
                {priceTrend.length ? (
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <LineChart accessibilityLayer data={priceTrend} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
                      <CartesianGrid stroke="#ececf0" vertical={false} />
                      <XAxis axisLine={false} dataKey="date" interval="preserveStartEnd" minTickGap={38} tick={{ fill: "#71717a", fontSize: 10 }} tickFormatter={shortChartDate} tickLine={false} />
                      <YAxis axisLine={false} tick={{ fill: "#71717a", fontSize: 10 }} tickLine={false} width={45} />
                      <Tooltip cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }} formatter={(value, name) => [observedPrice(Number(value), currency), String(name)]} isAnimationActive={false} labelFormatter={chartDateLabel} />
                      <Line activeDot={{ fill: "#fff", r: 3.5, strokeWidth: 2 }} dataKey="minimum" dot={false} isAnimationActive={false} name="Minimum" stroke="#a1a1aa" strokeLinecap="round" strokeLinejoin="round" type="linear" />
                      <Line activeDot={{ fill: "#fff", r: 4, strokeWidth: 2 }} dataKey="median" dot={false} isAnimationActive={false} name="Median" stroke="#7c3aed" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} type="linear" />
                      <Line activeDot={{ fill: "#fff", r: 3.5, strokeWidth: 2 }} dataKey="maximum" dot={false} isAnimationActive={false} name="Maximum" stroke="#18181b" strokeLinecap="round" strokeLinejoin="round" type="linear" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : <EmptyState title="No market history yet" description="The first completed enrichment will establish the price baseline." />}
              </div>
            </Card>
          </div>

          <Card className="product-detail-table product-market-offers">
            <CardHeader title="Seller offers" description={`Current seller, price, delivery, and availability in ${locale}.`} action={<span className="table-total">{pluralize(market.offers.length, "offer")}</span>} />
            {market.offers.length ? (
              <DataTable
                columns={[{ key: "seller", label: "Seller" }, { key: "price", label: "Price" }, { key: "availability", label: "Availability" }, { key: "delivery", label: "Delivery" }, { key: "rating", label: "Seller rating" }, { key: "open", label: "" }]}
                rows={market.offers.map((offer) => ({
                  id: offer.id,
                  seller: (
                    <div className="primary-cell seller-cell">
                      <div className="seller-name-row">
                        <strong>{offer.seller ?? offer.domain ?? "Unknown seller"}</strong>
                        {offer.owned ? (
                          <span className="owned-seller-badge" title="This seller belongs to your workspace">
                            <CheckCircle2 aria-hidden="true" size={11} />
                            Owned
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ),
                  price: offer.displayedPrice ?? observedPrice(offer.price, offer.currency) ?? "—",
                  availability: <Badge tone={offer.availability === "in_stock" ? "success" : "neutral"}>{offer.availability?.replaceAll("_", " ") ?? "Unknown"}</Badge>,
                  delivery: offer.delivery ?? "—",
                  rating: offer.rating === null ? "—" : `${offer.rating}${offer.ratingMaximum ? `/${offer.ratingMaximum}` : ""}${offer.reviews ? ` · ${compact(offer.reviews)}` : ""}`,
                  open: offer.url ? <Button asChild variant="secondary"><a href={offer.url} target="_blank" rel="noreferrer">Visit <ExternalLink size={12} /></a></Button> : null,
                }))}
              />
            ) : <EmptyState title="No seller offers" description="Google did not return offers for this market snapshot." />}
          </Card>
        </>
      ) : (
        <Card className="product-market-empty"><EmptyState title={market.refresh.pending ? "Product details are being enriched" : "No Google Shopping profile yet"} description={market.refresh.pending ? "This page updates after the provider result is normalized." : "Open or refresh this product to queue its first market snapshot."} /></Card>
      )}

    </>
  );
}

export function ProductAnalyticsPage() {
  const { projectId, session, trackingSource } = useApp();
  const queryClient = useQueryClient();
  const { productKey: routeProductKey = "" } = useParams();
  const productKey = routeProductKey.trim();
  const [marketLocale, setMarketLocale] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPeriod = searchParams.get("period");
  const period =
    requestedPeriod === "30d" ||
    requestedPeriod === "90d" ||
    requestedPeriod === "365d"
      ? requestedPeriod
      : "7d";
  const pageSize = 10;
  const pageScope = `${projectId ?? ""}:${trackingSource}:${productKey}:${period}`;
  const [pagination, setPagination] = useState({
    scope: pageScope,
    occurrenceCursors: [] as string[],
    promptOffset: 0,
    merchantOffset: 0,
  });
  const occurrenceCursors =
    pagination.scope === pageScope ? pagination.occurrenceCursors : [];
  const occurrenceCursor = occurrenceCursors.at(-1);
  const occurrenceOffset = occurrenceCursors.length * pageSize;
  const promptOffset =
    pagination.scope === pageScope ? pagination.promptOffset : 0;
  const merchantOffset =
    pagination.scope === pageScope ? pagination.merchantOffset : 0;
  const query = useQuery({
    queryKey: [
      "shopping-product",
      projectId,
      trackingSource,
      productKey,
      period,
      occurrenceCursor ?? "",
      marketLocale,
    ],
    queryFn: () =>
      apiPage<ProductAnalyticsDetail>(
        `/analytics/shopping/${encodeURIComponent(productKey)}?projectId=${projectId}&source=${trackingSource}&period=${period}&limit=${pageSize}${
          occurrenceCursor
            ? `&cursor=${encodeURIComponent(occurrenceCursor)}`
            : ""
        }${marketLocale ? `&marketLocationCode=${marketLocale.split(":")[0]}&marketLanguageCode=${encodeURIComponent(marketLocale.split(":")[1] ?? "")}` : ""}`,
      ),
    enabled: Boolean(projectId && productKey),
    refetchInterval: (result) =>
      result.state.data?.data.market.refresh.pending ? 5_000 : false,
  });
  const touchMarket = useMutation({
    mutationFn: (locale: { locationCode: number; languageCode: string }) =>
      post(`/analytics/shopping/${encodeURIComponent(productKey)}/enrichment/touch`, {
        projectId,
        ...locale,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["shopping-product", projectId, productKey],
      }),
  });
  const refreshMarket = useMutation({
    mutationFn: (locale: { locationCode: number; languageCode: string }) =>
      post(`/analytics/shopping/${encodeURIComponent(productKey)}/enrichment/refresh`, {
        projectId,
        ...locale,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["shopping-product", projectId, productKey],
      }),
  });
  const updateMarketPolicy = useMutation({
    mutationFn: (automaticRefreshEnabled: boolean) =>
      patch(`/analytics/shopping/${encodeURIComponent(productKey)}/enrichment`, {
        projectId,
        automaticRefreshEnabled,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["shopping-product", projectId, productKey],
      }),
  });
  const selectedMarketLocale = query.data?.data.market.selectedLocale;
  useEffect(() => {
    if (!projectId || !productKey || !selectedMarketLocale) return;
    touchMarket.mutate(selectedMarketLocale);
    // The backend deduplicates a view-triggered refresh per product and locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, productKey, selectedMarketLocale?.locationCode, selectedMarketLocale?.languageCode]);
  if (!projectId) return <NoProject />;
  const detail = query.data?.data;
  const occurrenceTotal = query.data?.page.total ?? 0;
  const promptRows =
    detail?.prompts.slice(promptOffset, promptOffset + pageSize) ?? [];
  const merchantRows =
    detail?.merchants.slice(merchantOffset, merchantOffset + pageSize) ?? [];
  const priceCurrencies = [
    ...new Set(
      detail?.priceTrend.map((point) => point.currency ?? "Price") ?? [],
    ),
  ];
  const priceChartData = [
    ...new Set(detail?.priceTrend.map((point) => point.date) ?? []),
  ].map((date) => {
    const row: Record<string, string | number> = { date };
    for (const point of detail?.priceTrend.filter(
      (candidate) => candidate.date === date,
    ) ?? []) {
      row[point.currency ?? "Price"] = point.latest;
    }
    return row;
  });
  const productHref = detail
    ? productDestination(detail.product)
    : undefined;
  const productImage = detail?.product.images[0];
  const market = detail?.market;
  const canEditEnrichment = session.user.role !== "viewer";
  const updateSectionOffset = (
    key: "promptOffset" | "merchantOffset",
    value: number,
  ) =>
    setPagination((current) => ({
      scope: pageScope,
      occurrenceCursors:
        current.scope === pageScope ? current.occurrenceCursors : [],
      promptOffset: current.scope === pageScope ? current.promptOffset : 0,
      merchantOffset: current.scope === pageScope ? current.merchantOffset : 0,
      [key]: value,
    }));
  const updatePeriod = (value: "7d" | "30d" | "90d" | "365d") => {
    const next = new URLSearchParams(searchParams);
    if (value === "7d") next.delete("period");
    else next.set("period", value);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="page product-analytics-page">
      <Link className="back-link" to="/shopping">
        <ArrowLeft size={14} /> Shopping
      </Link>
      <header className="product-detail-hero">
        <div className="product-detail-identity">
          <span className="product-detail-hero-image">
            {productImage ? <img src={productImage} alt="" /> : <ShoppingBag size={28} />}
          </span>
          <div className="product-detail-hero-copy">
            <span className="product-detail-eyebrow"><Sparkles size={13} /> AI product performance</span>
            <h1>{detail?.product.title ?? "Product analytics"}</h1>
            <div className="product-detail-status-row">
              {market?.profile ? <Badge tone="success">Enriched market data</Badge> : market?.refresh.pending ? <Badge tone="warning">Enrichment running</Badge> : <Badge>Observed product</Badge>}
              <span>{detail?.product.merchants ?? detail?.product.registrable_domain ?? "Merchant unavailable"}</span>
            </div>
            {detail ? (
              <p>First seen {dateTime(detail.summary.firstSeen)} <span aria-hidden="true">·</span> Latest {dateTime(detail.summary.latestSeen)}</p>
            ) : <p>Visibility, ranking, competitive context, and market intelligence.</p>}
          </div>
        </div>
        {productHref ? (
          <Button asChild variant="secondary">
            <a href={productHref} target="_blank" rel="noreferrer">Open product <ExternalLink size={13} /></a>
          </Button>
        ) : null}
      </header>
      <div className="product-detail-toolbar">
        <nav aria-label="Product detail sections">
          <a href="#overview">Overview</a>
          <a href="#competition">Competition</a>
          <a href="#market-data">Market data</a>
          <a href="#observations">Observations</a>
        </nav>
        <div
          className="product-period-toggle"
          data-period={period}
          role="group"
          aria-label="Report period"
        >
          <span className="product-period-indicator" aria-hidden="true" />
          {(["7d", "30d", "90d", "365d"] as const).map((value) => (
            <button
              aria-pressed={period === value}
              className={period === value ? "active" : undefined}
              key={value}
              onClick={() => updatePeriod(value)}
              type="button"
            >
              {value.replace("d", " days")}
            </button>
          ))}
        </div>
      </div>
      {query.isPending ? (
        <>
          <div className="product-metric-grid">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton className="source-summary-skeleton" key={index} />
            ))}
          </div>
          <div className="product-performance-grid">
            {Array.from({ length: 2 }, (_, index) => (
              <Skeleton className="product-chart-skeleton" key={index} />
            ))}
          </div>
          <Card><TableSkeleton rows={pageSize} /></Card>
        </>
      ) : detail ? (
        <>
          <section className="product-detail-section" id="overview">
            <ProductSectionHeading
              icon={<Eye size={17} />}
              title="AI performance"
              description={`How this product performed across monitored recommendations in the last ${period.replace("d", "")} days.`}
            />
            <div className="product-metric-grid">
              <ProductMetricCard
                icon={<Eye size={14} />}
                label="Visibility"
                value={percent(detail.summary.appearanceRate)}
                help="The share of completed monitored captures that contained this product."
                delta={percentagePointDelta(detail.summary.comparison.appearanceRate.delta)}
                deltaTone={deltaTone(detail.summary.comparison.appearanceRate.delta)}
                description={`${compact(detail.summary.appearingCaptures)} of ${compact(detail.summary.completedRuns)} captures`}
              />
              <ProductMetricCard
                icon={<Trophy size={14} />}
                label="Win rate"
                value={percent(detail.summary.winRate)}
                help="The share of product-containing captures where this product was recommendation #1."
                delta={percentagePointDelta(detail.summary.comparison.winRate.delta)}
                deltaTone={deltaTone(detail.summary.comparison.winRate.delta)}
                description={`${compact(detail.summary.winningCaptures)} #1 wins from ${compact(detail.summary.appearingCaptures)} appearances`}
              />
              <ProductMetricCard
                icon={<Target size={14} />}
                label="Average position"
                value={detail.summary.averagePosition === null ? "—" : `#${detail.summary.averagePosition.toFixed(1)}`}
                help="The product's average recommendation position, counted once per captured response. Lower is better."
                delta={positionDelta(detail.summary.comparison.averagePosition.delta)}
                deltaTone={deltaTone(detail.summary.comparison.averagePosition.delta, true)}
                description={`Latest position #${detail.summary.latestPosition}`}
              />
              <ProductMetricCard
                icon={<ChartNoAxesColumn size={14} />}
                label="Appearances"
                value={compact(detail.summary.appearances)}
                help="Every captured occurrence of this product in monitored shopping recommendations."
                delta={`${detail.summary.comparison.appearances.delta > 0 ? "+" : ""}${compact(detail.summary.comparison.appearances.delta)} vs previous period`}
                deltaTone={deltaTone(detail.summary.comparison.appearances.delta)}
                description={`${pluralize(detail.summary.prompts, "prompt")} · ${pluralize(detail.summary.merchants, "merchant label")}`}
              />
              <ProductMetricCard
                icon={<Store size={14} />}
                label="Observed price"
                value={detail.summary.price ? observedPrice(detail.summary.price.latest, detail.summary.price.currency) : "—"}
                help="The latest price shown in a monitored AI response, which may differ from the enriched market price."
                delta={detail.summary.comparison.price?.delta === null || detail.summary.comparison.price?.delta === undefined ? "No comparable previous price" : `${detail.summary.comparison.price.delta > 0 ? "+" : ""}${observedPrice(detail.summary.comparison.price.delta, detail.summary.comparison.price.currency)} vs previous period`}
                deltaTone="neutral"
                description={detail.summary.price ? `Range ${observedPrice(detail.summary.price.minimum, detail.summary.price.currency)}–${observedPrice(detail.summary.price.maximum, detail.summary.price.currency)}` : "Price was not included in captured responses"}
              />
              <ProductMetricCard
                icon={<Star size={14} />}
                label="Rating and reviews"
                value={detail.summary.rating?.value === null || detail.summary.rating?.value === undefined ? "—" : `${detail.summary.rating.value}${detail.summary.rating.maximum ? `/${detail.summary.rating.maximum}` : ""}`}
                help="The latest rating and review count observed in monitored AI responses."
                delta={detail.summary.comparison.rating?.reviewsDelta === null || detail.summary.comparison.rating?.reviewsDelta === undefined ? "No previous review count" : `${detail.summary.comparison.rating.reviewsDelta > 0 ? "+" : ""}${compact(detail.summary.comparison.rating.reviewsDelta)} reviews vs previous period`}
                deltaTone={deltaTone(detail.summary.comparison.rating?.reviewsDelta ?? null)}
                description={detail.summary.rating?.reviews === null || detail.summary.rating?.reviews === undefined ? "Review count unavailable" : `${compact(detail.summary.rating.reviews)} reviews`}
              />
            </div>

            <div className="product-performance-grid">
              <Card className="product-chart-card product-visibility-card">
                <CardHeader title="Visibility and win rate" description="Visibility measures reach; win rate measures how often the product ranked #1 when shown." />
                <div className="product-chart-legend" aria-hidden="true"><span className="is-visibility">Visibility</span><span className="is-win">Win rate</span></div>
                <div className="product-chart product-performance-chart">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <LineChart accessibilityLayer data={detail.visibilityTrend} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
                      <CartesianGrid stroke="#ececf0" vertical={false} />
                      <XAxis axisLine={false} dataKey="date" interval="preserveStartEnd" minTickGap={38} tick={{ fill: "#71717a", fontSize: 10 }} tickFormatter={shortChartDate} tickLine={false} />
                      <YAxis axisLine={false} domain={[0, 100]} tick={{ fill: "#71717a", fontSize: 10 }} tickFormatter={(value) => `${value}%`} tickLine={false} ticks={[0, 25, 50, 75, 100]} width={40} />
                      <Tooltip cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }} formatter={(value, name) => [percent(Number(value)), String(name)]} isAnimationActive={false} labelFormatter={chartDateLabel} />
                      <Line activeDot={{ fill: "#fff", r: 4, strokeWidth: 2 }} dataKey="appearanceRate" dot={false} isAnimationActive={false} name="Visibility" stroke="#1e73be" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} type="linear" />
                      <Line activeDot={{ fill: "#fff", r: 4, strokeWidth: 2 }} connectNulls={false} dataKey="winRate" dot={false} isAnimationActive={false} name="Win rate" stroke="#1f9d70" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} type="linear" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card className="product-cofeatured-card">
                <CardHeader title="Co-featured products" description="Products appearing in the same AI responses as this product." action={<span className="table-total">{pluralize(detail.competition.coFeatured.length, "product")}</span>} />
                {detail.competition.coFeatured.length ? (
                  <div className="product-cofeatured-list">
                    {detail.competition.coFeatured.map((competitor) => (
                      <Link className="product-cofeatured-row" key={competitor.product.productKey} to={`/shopping/${competitor.product.productKey}?period=${period}`}>
                        <span className="product-cofeatured-image">{competitor.product.images[0] ? <img alt="" src={competitor.product.images[0]} /> : <ShoppingBag size={15} />}</span>
                        <span className="product-cofeatured-copy">
                          <strong>{competitor.product.title ?? "Untitled product"}</strong>
                          <span><i style={{ width: `${Math.max(3, competitor.coFeatureRate)}%` }} /></span>
                          <small>{compact(competitor.coFeaturedCaptures)} shared captures · {competitor.averagePosition === null ? "Position unavailable" : `#${competitor.averagePosition.toFixed(1)} average`}</small>
                        </span>
                        <b>{percent(competitor.coFeatureRate)}</b>
                        <ChevronRight size={15} />
                      </Link>
                    ))}
                  </div>
                ) : <EmptyState title="No co-featured products" description="No other products appeared alongside this product in the selected period." />}
              </Card>
            </div>
          </section>

          <section className="product-detail-section" id="competition">
            <ProductSectionHeading icon={<Trophy size={17} />} title="Competitive position" description="How consistently this product ranks against recommendations shown in the same AI answers." />
            <Card className="product-rank-card">
              <CardHeader title="Position distribution" description="The box shows the middle 50% of positions; the line marks the median and whiskers show the full observed range." />
              <RankComparisonChart competition={detail.competition} product={detail.product} />
            </Card>
          </section>

          <div className="product-supporting-trends">
            <Card className="product-chart-card">
              <CardHeader
                title="Observed price history"
                description="Latest displayed price each day, separated by currency."
              />
              <div className="product-chart">
                {priceChartData.length ? (
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <LineChart accessibilityLayer data={priceChartData} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
                      <CartesianGrid stroke="#ececf0" vertical={false} />
                      <XAxis axisLine={false} dataKey="date" interval="preserveStartEnd" minTickGap={38} tick={{ fill: "#71717a", fontSize: 10 }} tickFormatter={shortChartDate} tickLine={false} />
                      <YAxis axisLine={false} tick={{ fill: "#71717a", fontSize: 10 }} tickLine={false} width={40} />
                      <Tooltip cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }} formatter={(value, name) => [observedPrice(Number(value), String(name) === "Price" ? null : String(name)), String(name)]} isAnimationActive={false} labelFormatter={chartDateLabel} />
                      {priceCurrencies.map((currency, index) => (
                        <Line
                          connectNulls
                          dataKey={currency}
                          dot={false}
                          isAnimationActive={false}
                          key={currency}
                          activeDot={{ fill: "#fff", r: 3.5, strokeWidth: 2 }}
                          stroke={["#18181b", "#71717a", "#a1a1aa"][index % 3]}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          type="linear"
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState title="No price history" description="No displayed prices were captured in this period." />
                )}
              </div>
            </Card>
            <Card className="product-chart-card">
              <CardHeader
                title="Review trend"
                description="Latest provider-observed review count each day."
              />
              <div className="product-chart">
                {detail.reviewTrend.some((point) => point.reviews !== null) ? (
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <LineChart accessibilityLayer data={detail.reviewTrend} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
                      <CartesianGrid stroke="#ececf0" vertical={false} />
                      <XAxis axisLine={false} dataKey="date" interval="preserveStartEnd" minTickGap={38} tick={{ fill: "#71717a", fontSize: 10 }} tickFormatter={shortChartDate} tickLine={false} />
                      <YAxis axisLine={false} tick={{ fill: "#71717a", fontSize: 10 }} tickFormatter={(value) => compact(Number(value))} tickLine={false} width={40} />
                      <Tooltip cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3", strokeWidth: 1 }} formatter={(value) => [compact(Number(value)), "Reviews"]} isAnimationActive={false} labelFormatter={chartDateLabel} />
                      <Line activeDot={{ fill: "#fff", r: 4, strokeWidth: 2 }} connectNulls dataKey="reviews" dot={false} isAnimationActive={false} name="Reviews" stroke="#18181b" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} type="linear" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState title="No review history" description="No review counts were captured in this period." />
                )}
              </div>
            </Card>
          </div>

          <section className="product-detail-section" id="market-data">
            <ProductSectionHeading icon={<Store size={17} />} title="Google Shopping market data" description="Catalog details, sellers, availability, and market pricing from the selected Google Shopping locale." />
            {market ? (
              <ProductMarketSection
                canEdit={canEditEnrichment}
                market={market}
                onLocaleChange={setMarketLocale}
                onPolicyChange={(enabled) => updateMarketPolicy.mutate(enabled)}
                onRefresh={() => { if (market.selectedLocale) refreshMarket.mutate(market.selectedLocale); }}
                policyPending={updateMarketPolicy.isPending}
                productTitle={detail.product.title}
                refreshPending={refreshMarket.isPending}
              />
            ) : null}
          </section>

          <section className="product-detail-section" id="observations">
            <ProductSectionHeading icon={<ChartNoAxesColumn size={17} />} title="Prompts and observations" description="The monitored prompts, merchant labels, and captured responses behind these metrics." />

          <Card className="product-detail-table">
            <CardHeader
              title="Prompts"
              description="Tracked prompts whose captured answers contained this product."
              action={<span className="table-total">{pluralize(detail.prompts.length, "prompt")}</span>}
            />
            <DataTable
              columns={[
                { key: "prompt", label: "Prompt" },
                { key: "country", label: "Country" },
                { key: "appearances", label: "Appearances" },
                { key: "position", label: "Latest position" },
                { key: "price", label: "Latest price" },
                { key: "seen", label: "Last seen" },
                { key: "open", label: "" },
              ]}
              rows={promptRows.map((prompt) => {
                const responsePath = `/prompts/${prompt.queryId}/snapshots/${prompt.latestSnapshotId}`;
                return {
                  id: prompt.queryId,
                  prompt: (
                    <Link className="product-prompt-link" to={responsePath}>
                      {prompt.prompt}
                    </Link>
                  ),
                  country: <CountryFlag locationCode={prompt.locationCode} languageCode={prompt.languageCode} />,
                  appearances: compact(prompt.appearances),
                  position: `#${prompt.latestPosition}`,
                  price: observedPrice(prompt.latestPrice, prompt.latestCurrency) ?? "—",
                  seen: dateTime(prompt.latestSeen),
                  open: (
                    <Button asChild className="product-response-button" variant="secondary">
                      <Link to={responsePath}>
                      View response
                      </Link>
                    </Button>
                  ),
                };
              })}
            />
            {detail.prompts.length > pageSize ? (
              <div className="table-pagination">
                <span>{promptOffset + 1}–{Math.min(promptOffset + promptRows.length, detail.prompts.length)} of {detail.prompts.length}</span>
                <div>
                  <Button variant="secondary" disabled={promptOffset === 0} onClick={() => updateSectionOffset("promptOffset", Math.max(0, promptOffset - pageSize))}><ChevronLeft size={14} /> Previous</Button>
                  <Button variant="secondary" disabled={promptOffset + pageSize >= detail.prompts.length} onClick={() => updateSectionOffset("promptOffset", promptOffset + pageSize)}>Next <ChevronRight size={14} /></Button>
                </div>
              </div>
            ) : null}
          </Card>

          <Card className="product-detail-table">
            <CardHeader
              title="Merchant observations"
              description="Provider-reported merchant labels, which may include “+ weitere” groupings."
              action={<span className="table-total">{pluralize(detail.merchants.length, "merchant label")}</span>}
            />
            <DataTable
              columns={[
                { key: "merchant", label: "Merchant label" },
                { key: "appearances", label: "Appearances" },
                { key: "prices", label: "Observed price range" },
                { key: "rating", label: "Latest rating" },
                { key: "seen", label: "Last seen" },
              ]}
              rows={merchantRows.map((merchant) => ({
                id: merchant.merchant,
                merchant: <strong>{merchant.merchant}</strong>,
                appearances: compact(merchant.appearances),
                prices: priceRangeLabel(merchant.prices),
                rating: merchant.latestRating === null ? "—" : `${merchant.latestRating}${merchant.latestReviews ? ` · ${compact(merchant.latestReviews)} reviews` : ""}`,
                seen: dateTime(merchant.latestSeen),
              }))}
            />
            {detail.merchants.length > pageSize ? (
              <div className="table-pagination">
                <span>{merchantOffset + 1}–{Math.min(merchantOffset + merchantRows.length, detail.merchants.length)} of {detail.merchants.length}</span>
                <div>
                  <Button variant="secondary" disabled={merchantOffset === 0} onClick={() => updateSectionOffset("merchantOffset", Math.max(0, merchantOffset - pageSize))}><ChevronLeft size={14} /> Previous</Button>
                  <Button variant="secondary" disabled={merchantOffset + pageSize >= detail.merchants.length} onClick={() => updateSectionOffset("merchantOffset", merchantOffset + pageSize)}>Next <ChevronRight size={14} /></Button>
                </div>
              </div>
            ) : null}
          </Card>

          <Card className="product-detail-table">
            <CardHeader
              title="Observation history"
              description="Every captured occurrence in the selected period."
              action={<span className="table-total">{pluralize(occurrenceTotal, "observation")}</span>}
            />
            <DataTable
              columns={[
                { key: "captured", label: "Captured" },
                { key: "prompt", label: "Prompt" },
                { key: "merchant", label: "Merchant" },
                { key: "position", label: "Position" },
                { key: "price", label: "Price" },
                { key: "rating", label: "Rating" },
                { key: "open", label: "" },
              ]}
              rows={detail.occurrences.map((occurrence) => ({
                id: occurrence.id,
                captured: dateTime(occurrence.capturedAt),
                prompt: <span className="product-history-prompt">{occurrence.prompt}</span>,
                merchant: occurrence.merchant ?? "—",
                position: `#${occurrence.position}`,
                price: observedPrice(occurrence.price, occurrence.currency) ?? "—",
                rating: occurrence.rating === null ? "—" : `${occurrence.rating}${occurrence.ratingMaximum ? `/${occurrence.ratingMaximum}` : ""}${occurrence.reviews ? ` · ${compact(occurrence.reviews)}` : ""}`,
                open: (
                  <Button asChild variant="secondary">
                    <Link to={`/prompts/${occurrence.queryId}/snapshots/${occurrence.snapshotId}`}>
                      View response
                    </Link>
                  </Button>
                ),
              }))}
            />
            {occurrenceTotal > pageSize ? (
              <div className="table-pagination">
                <span>{occurrenceOffset + 1}–{Math.min(occurrenceOffset + detail.occurrences.length, occurrenceTotal)} of {occurrenceTotal}</span>
                <div>
                  <Button
                    variant="secondary"
                    disabled={!occurrenceCursors.length || query.isFetching}
                    onClick={() =>
                      setPagination((current) => ({
                        scope: pageScope,
                        occurrenceCursors:
                          current.scope === pageScope
                            ? current.occurrenceCursors.slice(0, -1)
                            : [],
                        promptOffset:
                          current.scope === pageScope ? current.promptOffset : 0,
                        merchantOffset:
                          current.scope === pageScope ? current.merchantOffset : 0,
                      }))
                    }
                  >
                    <ChevronLeft size={14} /> Previous
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!query.data?.page.nextCursor || query.isFetching}
                    onClick={() => {
                      const nextCursor = query.data?.page.nextCursor;
                      if (!nextCursor) return;
                      setPagination((current) => ({
                        scope: pageScope,
                        occurrenceCursors: [
                          ...(current.scope === pageScope
                            ? current.occurrenceCursors
                            : []),
                          nextCursor,
                        ],
                        promptOffset:
                          current.scope === pageScope ? current.promptOffset : 0,
                        merchantOffset:
                          current.scope === pageScope ? current.merchantOffset : 0,
                      }));
                    }}
                  >
                    Next <ChevronRight size={14} />
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>
          </section>
        </>
      ) : (
        <Card>
          <EmptyState
            title="Product unavailable"
            description="This product has no observations in the selected period."
            action={period === "365d" ? undefined : (
              <Button onClick={() => updatePeriod(period === "7d" ? "30d" : period === "30d" ? "90d" : "365d")} variant="secondary">
                Try a wider period
              </Button>
            )}
          />
        </Card>
      )}
    </div>
  );
}

export function AlertsPage() {
  const { projectId, trackingSource } = useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: () => api<Array<Record<string, string | number>>>("/alerts") });
  const rules = useQuery({
    queryKey: ["alert-rules", projectId],
    queryFn: () => api<Array<Record<string, string | number>>>(`/projects/${projectId}/alert-rules`),
    enabled: Boolean(projectId),
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => post(`/projects/${projectId}/alert-rules`, body),
    onSuccess: async () => { setOpen(false); await queryClient.invalidateQueries({ queryKey: ["alert-rules", projectId] }); },
  });
  if (!projectId) return <NoProject />;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({ name: data.get("name"), eventType: data.get("eventType"), threshold: data.get("threshold") ? Number(data.get("threshold")) : null, source: trackingSource, channels: ["in_app", "webhook"] });
  };
  const visibleAlerts = alerts.data?.filter(
    (alert) => alert.tracking_source === trackingSource,
  );
  const visibleRules = rules.data?.filter(
    (rule) => rule.tracking_source === trackingSource,
  );
  return (
    <div className="page">
      <PageHeader title="Alerts" description="Change detection with in-app history and signed webhook delivery." action={<Button onClick={() => setOpen(true)}><Plus size={15}/> Add rule</Button>} />
      <div className="split-grid">
        <Card><CardHeader title="Recent events" description="Newest visibility changes for this source." />{visibleAlerts?.length ? <div className="alert-list">{visibleAlerts.map((alert) => <div className="alert-row" key={String(alert.id)}><span className="alert-icon"><AlertTriangle size={16}/></span><div><strong>{alert.title}</strong><p>{alert.message}</p><span>{dateTime(String(alert.created_at))}</span></div><Badge tone={alert.is_read ? "neutral" : "warning"}>{alert.is_read ? "Read" : "New"}</Badge></div>)}</div> : <EmptyState title="No alerts" description="Configured changes will appear here." />}</Card>
        <Card><CardHeader title="Rules" description={`${visibleRules?.length ?? 0} configured`} />{visibleRules?.length ? <div className="rule-list">{visibleRules.map((rule) => <div key={String(rule.id)}><span className="status-dot"/><div><strong>{rule.name}</strong><span>{String(rule.event_type).replaceAll("_", " ")}</span></div><Badge tone="success">Active</Badge></div>)}</div> : <EmptyState title="No rules" description="Create a rule for the changes that matter." />}</Card>
      </div>
      <Dialog open={open} onOpenChange={setOpen} title="Create alert rule" description="Webhook delivery is used when a destination is configured.">
        <form className="form-stack" onSubmit={submit}><Label>Rule name</Label><Input name="name" required /><Label>Event</Label><select className="input" name="eventType"><option value="own_citation_lost">Owned citation lost</option><option value="brand_mention_lost">Brand mention lost</option><option value="competitor_citation_gained">Competitor gained visibility</option><option value="product_block_changed">Product block changed</option><option value="visibility_drop">Visibility drop</option><option value="run_failed">Run failed</option></select><Label hint="Used for visibility drop">Threshold (percentage points)</Label><Input name="threshold" type="number" min="0" max="100" defaultValue="10" /><div className="dialog-actions"><Button variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button><Button>Create rule</Button></div></form>
      </Dialog>
    </div>
  );
}

export function ExportsPage() {
  const { projectId, trackingSource } = useApp();
  const queryClient = useQueryClient();
  const exportsQuery = useQuery({ queryKey: ["exports"], queryFn: () => api<Array<Record<string, string | number | null>>>("/exports"), refetchInterval: 10_000 });
  const create = useMutation({
    mutationFn: (format: "csv" | "ndjson") => post("/exports", {
      projectId,
      source: trackingSource,
      format,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["exports"] }),
  });
  return (
    <div className="page">
      <PageHeader title="Exports" description="Asynchronous, compressed analytics and captured-response indexes." action={<div className="button-group"><Button variant="secondary" onClick={() => create.mutate("csv")}><FileDown size={15}/> CSV</Button><Button onClick={() => create.mutate("ndjson")}><FileDown size={15}/> NDJSON</Button></div>} />
      <Card>{exportsQuery.data?.length ? <DataTable columns={[{key:"created",label:"Created"},{key:"format",label:"Format"},{key:"rows",label:"Rows"},{key:"status",label:"Status"},{key:"action",label:""}]} rows={exportsQuery.data.map((item) => ({id:item.id,created:dateTime(String(item.created_at)),format:<Badge>{String(item.format).toUpperCase()}</Badge>,rows:item.row_count ? compact(Number(item.row_count)) : "—",status:<Badge tone={item.status === "completed" ? "success" : item.status === "failed" ? "danger" : "warning"}>{item.status}</Badge>,action:item.status === "completed" ? <Button asChild variant="secondary"><a href={`/api/v1/exports/${item.id}/download`}><Download size={14}/> Download</a></Button> : null}))} /> : <EmptyState title="No exports" description="Create a CSV or NDJSON export for the selected project." />}</Card>
    </div>
  );
}

export function UsersPage() {
  const { session } = useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sendInviteEmail, setSendInviteEmail] = useState(true);
  const [pendingAction, setPendingAction] = useState<
    | { kind: "remove"; id: string; label: string }
    | { kind: "revoke"; id: string; label: string }
    | null
  >(null);
  const [invitation, setInvitation] = useState<{
    link: string;
    emailDelivery: "failed" | "not_requested" | "sent";
  } | null>(null);
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api<Array<{
      id: string;
      email: string;
      display_name: string;
      status: string;
      last_login_at: string | null;
      role: "owner" | "admin" | "editor" | "viewer";
      created_at: string;
    }>>("/users"),
  });
  const pendingInvitations = useQuery({
    queryKey: ["invitations"],
    queryFn: () => api<Array<{
      id: string;
      email: string;
      role: "admin" | "editor" | "viewer";
      expires_at: string;
      created_at: string;
    }>>("/auth/invitations"),
  });
  const invite = useMutation({
    mutationFn: (body: { email: string; role: string; sendEmail: boolean }) =>
      post<{
        link: string;
        emailDelivery: "failed" | "not_requested" | "sent";
      }>("/auth/invitations", body),
    onSuccess: (data) => {
      setInvitation(data);
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
    },
  });
  const removeUser = useMutation({
    mutationFn: (id: string) => remove(`/users/${id}`),
    onSuccess: () => {
      setPendingAction(null);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const revokeInvitation = useMutation({
    mutationFn: (id: string) => remove(`/auth/invitations/${id}`),
    onSuccess: () => {
      setPendingAction(null);
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    invite.mutate({
      email: formText(data, "email"),
      role: formText(data, "role"),
      sendEmail: sendInviteEmail,
    });
  };
  return (
    <div className="page users-page">
      <PageHeader title={`${session.workspace.name} users`} description="Role-based access for owners, admins, editors, and viewers." action={<Button onClick={() => { setInvitation(null); setSendInviteEmail(true); invite.reset(); setOpen(true); }}><UserPlus size={15}/> Invite user</Button>} />
      <Card className="workspace-access-card">
        <section className="workspace-access-section">
          <CardHeader title="Members" description="People who currently have access to this workspace." />
          {users.isPending ? <TableSkeleton /> : users.data?.length ? <DataTable columns={[{key:"user",label:"User"},{key:"role",label:"Role"},{key:"status",label:"Status"},{key:"last",label:"Last login"},{key:"action",label:""}]} rows={users.data.map((user) => ({
          id:user.id,
          user:<div className="primary-cell"><strong>{user.display_name}</strong><span>{user.email}</span></div>,
          role:<Badge tone={user.role === "owner" ? "info" : "neutral"}>{user.role}</Badge>,
          status:<Badge tone={user.status === "active" ? "success" : "danger"}>{user.status}</Badge>,
          last:dateTime(user.last_login_at),
          action: session.user.role === "owner" && user.role !== "owner" && user.id !== session.user.id
            ? <div className="table-actions"><Button className="destructive-ghost" variant="ghost" onClick={() => setPendingAction({ kind: "remove", id: user.id, label: user.display_name })}><Trash2 size={14}/> Remove</Button></div>
            : null,
          }))} /> : <EmptyState title="No workspace members" description="Invite someone to give them access." />}
        </section>
        <section className="workspace-access-section">
          <CardHeader title="Pending invitations" description="Invitations waiting to be accepted. Revoking one immediately invalidates its link." />
          {pendingInvitations.isPending ? <TableSkeleton rows={2} columns={4} /> : pendingInvitations.data?.length ? <DataTable columns={[{key:"user",label:"Invitee"},{key:"role",label:"Role"},{key:"status",label:"Status"},{key:"expires",label:"Expires"},{key:"action",label:""}]} rows={pendingInvitations.data.map((item) => ({
          id:item.id,
          user:<div className="primary-cell"><strong>{item.email}</strong><span>Invitation sent {dateTime(item.created_at)}</span></div>,
          role:<Badge>{item.role}</Badge>,
          status:<Badge tone="warning">Pending</Badge>,
          expires:dateTime(item.expires_at),
          action:<div className="table-actions"><Button className="destructive-ghost" variant="ghost" onClick={() => setPendingAction({ kind: "revoke", id: item.id, label: item.email })}><Trash2 size={14}/> Revoke</Button></div>,
        }))} /> : <EmptyState title="No pending invitations" description="New invitations will appear here until they are accepted or expire." />}
        </section>
      </Card>
      <Dialog open={open} onOpenChange={setOpen} title="Invite workspace user" description={`Invite links expire after ${WORKSPACE_INVITATION_TTL_DAYS} days and are always shown once.`}>
        {invitation ? (
          <div className="success-panel">
            <CheckCircle2/>
            <p>
              {invitation.emailDelivery === "sent"
                ? "Invitation email sent. You can also share the link directly."
                : invitation.emailDelivery === "failed"
                  ? "The invitation was created, but its email could not be sent. Share the link directly."
                  : "Invitation created. Share the link directly."}
            </p>
            <code className="invite-link">{invitation.link}</code>
            <Button onClick={() => void navigator.clipboard.writeText(invitation.link)}>Copy link</Button>
          </div>
        ) : (
          <form className="form-stack" onSubmit={submit}>
            <Label>Email</Label>
            <Input name="email" type="email" autoComplete="email" required />
            <Label>Role</Label>
            <select className="input" name="role"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option></select>
            <label className="checkbox-row">
              <input
                checked={sendInviteEmail}
                onChange={(event) => setSendInviteEmail(event.target.checked)}
                type="checkbox"
              />
              Send the invitation by email
            </label>
            {invite.isError ? <p className="form-error">{invite.error.message}</p> : null}
            <Button disabled={invite.isPending}>
              <Send size={15}/> {sendInviteEmail ? "Send invitation" : "Create invitation"}
            </Button>
          </form>
        )}
      </Dialog>
      <Dialog
        open={Boolean(pendingAction)}
        onOpenChange={(isOpen) => { if (!isOpen) setPendingAction(null); }}
        title={pendingAction?.kind === "remove" ? "Remove workspace user?" : "Revoke invitation?"}
        description={pendingAction?.kind === "remove"
          ? `${pendingAction.label} will immediately lose access to ${session.workspace.name}.`
          : `The invitation link for ${pendingAction?.label ?? "this user"} will stop working immediately.`}
      >
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => setPendingAction(null)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={removeUser.isPending || revokeInvitation.isPending}
            onClick={() => {
              if (!pendingAction) return;
              if (pendingAction.kind === "remove") removeUser.mutate(pendingAction.id);
              else revokeInvitation.mutate(pendingAction.id);
            }}
          >
            <Trash2 size={15}/>
            {pendingAction?.kind === "remove" ? "Remove user" : "Revoke invitation"}
          </Button>
        </div>
        {removeUser.isError ? <p className="form-error">{removeUser.error.message}</p> : null}
        {revokeInvitation.isError ? <p className="form-error">{revokeInvitation.error.message}</p> : null}
      </Dialog>
    </div>
  );
}

export function SettingsPage() {
  const { projects, projectId, session } = useApp();
  const queryClient = useQueryClient();
  const [projectOpen, setProjectOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [webhookOpen, setWebhookOpen] = useState(false);
  const [webhookSecret, setWebhookSecret] = useState("");
  const canAdmin = session.user.role === "owner" || session.user.role === "admin";
  const health = useQuery({ queryKey: ["health"], queryFn: () => api<Record<string, unknown>>("/settings/health"), enabled: canAdmin });
  const enrichmentSettings = useQuery({
    queryKey: ["product-enrichment-settings"],
    queryFn: () => api<{
      enabled: boolean;
      monthlyWarningUsd: number;
      monthToDateTasks: number;
      monthToDateCost: number;
      warningExceeded: boolean;
    }>("/settings/product-enrichment"),
    enabled: canAdmin,
  });
  const entitySettings = useQuery({
    queryKey: ["entity-extraction-settings"],
    queryFn: () => api<{
      enabled: boolean;
      autoTrackEnabled: boolean;
      monthlyWarningUsd: number;
      monthToDateTasks: number;
      monthToDateCost: number;
      warningExceeded: boolean;
      costIsEstimated: true;
    }>("/settings/entity-extraction"),
    enabled: canAdmin,
  });
  const updateEnrichmentSettings = useMutation({
    mutationFn: (body: { enabled?: boolean; monthlyWarningUsd?: number }) =>
      patch("/settings/product-enrichment", body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["product-enrichment-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["billing"] }),
        queryClient.invalidateQueries({ queryKey: ["shopping-product"] }),
      ]);
    },
  });
  const updateEntitySettings = useMutation({
    mutationFn: (body: { enabled?: boolean; autoTrackEnabled?: boolean; monthlyWarningUsd?: number }) =>
      patch("/settings/entity-extraction", body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["entity-extraction-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["billing"] }),
        queryClient.invalidateQueries({ queryKey: ["entities"] }),
        queryClient.invalidateQueries({ queryKey: ["brands"] }),
      ]);
    },
  });
  const createProject = useMutation({
    mutationFn: (body: Record<string, unknown>) => post("/projects", body),
    onSuccess: async () => { setProjectOpen(false); await queryClient.invalidateQueries({ queryKey: ["projects"] }); },
  });
  const updateProject = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: {
        name: string;
        primaryDomain: string | null;
        htmlCaptureEnabled: boolean;
      };
    }) => patch(`/projects/${id}`, body),
    onSuccess: async () => {
      setEditingProject(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const createWebhook = useMutation({
    mutationFn: (body: Record<string, string>) => post<{ signingSecret: string }>("/webhook-destinations", body),
    onSuccess: (value) => setWebhookSecret(value.signingSecret),
  });
  const projectSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    createProject.mutate({ name:data.get("name"),primaryDomain:data.get("primaryDomain") || null,ownedBrandName:data.get("brand"),ownedBrandAliases:[],competitorBrands:[],htmlCaptureEnabled:data.get("html") === "on" });
  };
  const projectUpdateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingProject) return;
    const data = new FormData(event.currentTarget);
    updateProject.mutate({
      id: editingProject.id,
      body: {
        name: formText(data, "name"),
        primaryDomain: formText(data, "primaryDomain") || null,
        htmlCaptureEnabled: data.get("html") === "on",
      },
    });
  };
  const webhookSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    createWebhook.mutate({ name: formText(data, "name"), url: formText(data, "url") });
  };
  const enrichmentWarningSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    updateEnrichmentSettings.mutate({
      monthlyWarningUsd: Number(data.get("monthlyWarningUsd")),
    });
  };
  const entityWarningSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    updateEntitySettings.mutate({
      monthlyWarningUsd: Number(data.get("monthlyWarningUsd")),
    });
  };
  return (
    <div className="page">
      <PageHeader title="Settings & diagnostics" description="Manage projects, response capture, delivery, and installation health." action={<Button onClick={() => setProjectOpen(true)}><Plus size={15}/> New project</Button>} />
      <div className="settings-grid">
        <Card>
          <CardHeader
            title="Projects"
            description={`${pluralize(projects.length, "project")} configured`}
          />
          {projects.length ? (
            <div className="settings-list">
              {projects.map((project) => (
                <div key={project.id}>
                  <span className="settings-icon settings-project-favicon">
                    <DomainFavicon domain={project.primary_domain} size={18} />
                  </span>
                  <div>
                    <strong>{project.name}</strong>
                    <span>
                      {project.primary_domain ?? "No primary domain"} ·{" "}
                      {pluralize(project.query_count, "prompt")}
                    </span>
                  </div>
                  <div className="settings-project-actions">
                    <Badge tone={project.html_capture_enabled ? "success" : "neutral"}>
                      HTML {project.html_capture_enabled ? "on" : "off"}
                    </Badge>
                    {project.id === projectId ? <Badge tone="info">Selected</Badge> : null}
                    {session.user.role !== "viewer" ? (
                      <Button
                        variant="secondary"
                        className="settings-edit-button"
                        onClick={() => {
                          updateProject.reset();
                          setEditingProject(project);
                        }}
                      >
                        <Pencil size={13} />
                        Edit
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="Create your first project"
              description="Add an owned brand and domain to start tracking."
            />
          )}
        </Card>
        {canAdmin ? (
          <Card>
            <CardHeader
              title="Product enrichment"
              description="Weekly Google Shopping product and seller snapshots for newly observed products."
              action={enrichmentSettings.data ? (
                <Badge tone={enrichmentSettings.data.enabled ? "success" : "warning"}>
                  {enrichmentSettings.data.enabled ? "Active" : "Paused"}
                </Badge>
              ) : null}
            />
            <CardContent className="product-enrichment-settings">
              {enrichmentSettings.isPending ? (
                <Skeleton className="settings-enrichment-skeleton" />
              ) : enrichmentSettings.data ? (
                <>
                  <label className="checkbox-row evidence-checkbox">
                    <input
                      checked={enrichmentSettings.data.enabled}
                      disabled={updateEnrichmentSettings.isPending}
                      onChange={(event) => updateEnrichmentSettings.mutate({ enabled: event.target.checked })}
                      type="checkbox"
                    />
                    <span>
                      <strong>Enable automatic enrichment</strong>
                      <small>New observations refresh at most once every seven days per product and locale.</small>
                    </span>
                  </label>
                  <div className="settings-enrichment-usage">
                    <div><strong>{formatProviderCost(enrichmentSettings.data.monthToDateCost)}</strong><span>Month-to-date cost</span></div>
                    <div><strong>{compact(enrichmentSettings.data.monthToDateTasks)}</strong><span>Charged tasks</span></div>
                  </div>
                  {enrichmentSettings.data.warningExceeded ? (
                    <div className="settings-enrichment-warning"><AlertTriangle size={14} /> The monthly warning level has been reached.</div>
                  ) : null}
                  <form className="settings-enrichment-threshold" onSubmit={enrichmentWarningSubmit}>
                    <div>
                      <Label hint="Warning only; enrichment keeps running">Monthly cost warning (USD)</Label>
                      <Input
                        defaultValue={enrichmentSettings.data.monthlyWarningUsd}
                        min="0"
                        name="monthlyWarningUsd"
                        step="0.01"
                        type="number"
                      />
                    </div>
                    <Button disabled={updateEnrichmentSettings.isPending} type="submit" variant="secondary">Save warning</Button>
                  </form>
                  <p className="muted product-enrichment-footnote">Changes apply to future work. Existing market snapshots remain available and no historical bulk backfill is started.</p>
                </>
              ) : (
                <p className="muted">Product enrichment settings could not be loaded.</p>
              )}
            </CardContent>
          </Card>
        ) : null}
        {canAdmin ? (
          <Card>
            <CardHeader
              title="Entity extraction"
              description="Cross-industry named entity discovery for every captured response."
              action={entitySettings.data ? (
                <Badge tone={entitySettings.data.enabled ? "success" : "warning"}>
                  {entitySettings.data.enabled ? "Active" : "Paused"}
                </Badge>
              ) : null}
            />
            <CardContent className="product-enrichment-settings">
              {entitySettings.isPending ? (
                <Skeleton className="settings-enrichment-skeleton" />
              ) : entitySettings.data ? (
                <>
                  <label className="checkbox-row evidence-checkbox">
                    <input checked={entitySettings.data.enabled} disabled={updateEntitySettings.isPending} onChange={(event) => updateEntitySettings.mutate({ enabled: event.target.checked })} type="checkbox" />
                    <span><strong>Extract named entities</strong><small>Runs asynchronously after normalization and also backfills retained responses.</small></span>
                  </label>
                  <label className="checkbox-row evidence-checkbox">
                    <input checked={entitySettings.data.autoTrackEnabled} disabled={!entitySettings.data.enabled || updateEntitySettings.isPending} onChange={(event) => updateEntitySettings.mutate({ autoTrackEnabled: event.target.checked })} type="checkbox" />
                    <span><strong>Auto-track high-confidence competitors</strong><small>Requires repeated evidence across prompts plus provider/domain corroboration or a stronger observation threshold.</small></span>
                  </label>
                  <div className="settings-enrichment-usage">
                    <div><strong>{formatProviderCost(entitySettings.data.monthToDateCost)}</strong><span>Estimated month-to-date</span></div>
                    <div><strong>{compact(entitySettings.data.monthToDateTasks)}</strong><span>Extraction tasks</span></div>
                  </div>
                  {entitySettings.data.warningExceeded ? <div className="settings-enrichment-warning"><AlertTriangle size={14} /> The estimated monthly warning level has been reached.</div> : null}
                  <form className="settings-enrichment-threshold" onSubmit={entityWarningSubmit}>
                    <div><Label hint="Estimated list price before shared free allocation">Monthly cost warning (USD)</Label><Input defaultValue={entitySettings.data.monthlyWarningUsd} min="0" name="monthlyWarningUsd" step="0.01" type="number" /></div>
                    <Button disabled={updateEntitySettings.isPending} type="submit" variant="secondary">Save warning</Button>
                  </form>
                  <p className="muted product-enrichment-footnote">Inference costs are estimates derived from model token usage and the stored pricing snapshot; Cloudflare account-level free allocation is not apportioned to projects.</p>
                </>
              ) : <p className="muted">Entity extraction settings could not be loaded.</p>}
            </CardContent>
          </Card>
        ) : null}
        <Card><CardHeader title="Provider & infrastructure" description="Health checks from the last 24 hours." />{health.isPending ? <CardContent><p className="muted">Checking infrastructure…</p></CardContent> : health.data ? <div className="health-panel"><div><CheckCircle2/><span><strong>Control database</strong>Connected</span></div><div><ServerCog/><span><strong>Snapshot shards</strong>32 shards configured</span></div><div><KeyRound/><span><strong>Runtime configuration</strong>Bindings available</span></div></div> : <CardContent><p className="muted">Administrator access is required to view health checks.</p></CardContent>}</Card>
        <Card><CardHeader title="Webhook delivery" description="Send signed alerts to external systems." action={<Button variant="secondary" onClick={() => {setWebhookSecret("");setWebhookOpen(true);}}><Webhook size={14}/> Add</Button>} /><CardContent className="settings-note"><p className="muted">Alert payloads include an event ID, timestamp, and HMAC-SHA256 signature.</p></CardContent></Card>
        <Card><CardHeader title="Response retention" description="Private storage lifecycle." /><div className="retention-grid"><div><strong>730 days</strong><span>Raw results</span></div><div><strong>90 days</strong><span>Original page HTML</span></div><div><strong>7 days</strong><span>Exports</span></div></div></Card>
      </div>
      <Dialog open={projectOpen} onOpenChange={setProjectOpen} title="Create project" description="Define the brand and domain used for visibility metrics."><form className="form-stack" onSubmit={projectSubmit}><Label>Project name</Label><Input name="name" required /><Label>Owned brand</Label><Input name="brand" required /><Label>Primary domain</Label><Input name="primaryDomain" placeholder="example.com" /><label className="checkbox-row"><input name="html" type="checkbox" /> Retain original response pages for future runs</label><Button>Create project</Button></form></Dialog>
      <Dialog
        open={Boolean(editingProject)}
        onOpenChange={(open) => {
          if (!open) setEditingProject(null);
        }}
        title="Edit project"
        description="Update project details and response-page retention for future runs."
      >
        {editingProject ? (
          <form
            key={editingProject.id}
            className="form-stack"
            onSubmit={projectUpdateSubmit}
          >
            <Label>Project name</Label>
            <Input name="name" defaultValue={editingProject.name} required />
            <Label>Primary domain</Label>
            <Input
              name="primaryDomain"
              defaultValue={editingProject.primary_domain ?? ""}
              placeholder="example.com"
            />
            <label className="checkbox-row evidence-checkbox">
              <input
                name="html"
                type="checkbox"
                defaultChecked={editingProject.html_capture_enabled === 1}
              />
              <span>
                <strong>Retain original response pages</strong>
                <small>
                  Applies to new scheduled and manual runs. Existing snapshots are unchanged.
                </small>
              </span>
            </label>
            {updateProject.isError ? (
              <p className="form-error">{updateProject.error.message}</p>
            ) : null}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditingProject(null)}
              >
                Cancel
              </Button>
              <Button disabled={updateProject.isPending}>
                {updateProject.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
      <Dialog open={webhookOpen} onOpenChange={setWebhookOpen} title="Add webhook destination" description="Only public HTTPS targets are accepted.">{webhookSecret ? <div className="success-panel"><CheckCircle2/><p>Store this signing secret now; it will not be shown again.</p><code className="invite-link">{webhookSecret}</code><Button onClick={() => void navigator.clipboard.writeText(webhookSecret)}>Copy secret</Button></div> : <form className="form-stack" onSubmit={webhookSubmit}><Label>Name</Label><Input name="name" required /><Label>HTTPS URL</Label><Input name="url" type="url" placeholder="https://example.com/hooks/ai-tracker" required /><Button>Create destination</Button></form>}</Dialog>
    </div>
  );
}
