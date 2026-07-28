import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileDown,
  Globe2,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ServerCog,
  ShoppingBag,
  UserPlus,
  Webhook,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { NoProject, PageHeader } from "../components/layout";
import { DomainFavicon } from "../components/domain-favicon";
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
  Skeleton,
  TableSkeleton,
} from "../components/ui";
import { useApp } from "../context";
import { api, apiPage, patch, post, type Project } from "../lib/api";
import { productDestination } from "../lib/snapshot-evidence";
import { compact, dateTime, formText, percent, pluralize } from "../lib/utils";

function useProjectAnalytics<T>(name: string) {
  const { projectId } = useApp();
  return useQuery({
    queryKey: [name, projectId],
    queryFn: () => api<T>(`/analytics/${name}?projectId=${projectId}`),
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

export function CitationSourcesPage() {
  const { projectId } = useApp();
  const navigate = useNavigate();
  const pageSize = 10;
  const [pagination, setPagination] = useState({ projectId, offset: 0 });
  const offset =
    pagination.projectId === projectId ? pagination.offset : 0;
  const query = useQuery({
    queryKey: ["citation-sources", projectId, offset],
    queryFn: () =>
      apiPage<CitationSourceRow[]>(
        `/analytics/citation-sources?projectId=${projectId}&offset=${offset}&limit=${pageSize}`,
      ),
    enabled: Boolean(projectId),
  });
  if (!projectId) return <NoProject />;
  const sources = query.data?.data ?? [];
  const total = query.data?.page.total ?? 0;
  const firstItem = total ? offset + 1 : 0;
  const lastItem = Math.min(offset + sources.length, total);
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
                { key: "urls", label: "Total URLs" },
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
                rate: <strong>{percent(source.citationRate)}</strong>,
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
                  disabled={offset === 0 || query.isFetching}
                  onClick={() =>
                    setPagination({
                      projectId,
                      offset: Math.max(0, offset - pageSize),
                    })
                  }
                >
                  <ChevronLeft size={14} /> Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={!query.data?.page.nextCursor || query.isFetching}
                  onClick={() =>
                    setPagination({
                      projectId,
                      offset: offset + pageSize,
                    })
                  }
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
    citationRate: number;
  };
  trend: Array<{
    date: string;
    completedRuns: number;
    citedSnapshots: number;
    citationCount: number;
    citationRate: number;
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
  const { projectId } = useApp();
  const { domain: routeDomain = "" } = useParams();
  const domain = routeDomain.trim().toLowerCase();
  const pageSize = 10;
  const pageKey = `${projectId ?? ""}:${domain}`;
  const [pagination, setPagination] = useState({ pageKey, offset: 0 });
  const offset = pagination.pageKey === pageKey ? pagination.offset : 0;
  const query = useQuery({
    queryKey: ["citation-source", projectId, domain, offset],
    queryFn: () =>
      apiPage<CitationSourceDetail>(
        `/analytics/citation-sources/${encodeURIComponent(domain)}?projectId=${projectId}&offset=${offset}&limit=${pageSize}`,
      ),
    enabled: Boolean(projectId && domain),
  });
  if (!projectId) return <NoProject />;
  const detail = query.data?.data;
  const total = query.data?.page.total ?? 0;
  const firstItem = total ? offset + 1 : 0;
  const lastItem = Math.min(offset + (detail?.urls.length ?? 0), total);

  return (
    <div className="page citation-source-detail-page">
      <Link className="back-link" to="/citations">
        <ArrowLeft size={14} /> Citation sources
      </Link>
      <PageHeader
        eyebrow="Last 30 days"
        title={domain || "Citation source"}
        description="Citation performance, trend, and cited pages for this source."
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
                    data={detail.trend}
                    margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
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
                      stroke="#e4e4e7"
                      strokeDasharray="3 3"
                      vertical={false}
                    />
                    <XAxis
                      axisLine={false}
                      dataKey="date"
                      tick={{ fill: "#71717a", fontSize: 11 }}
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
                      contentStyle={{
                        border: "1px solid #d4d4d8",
                        borderRadius: 6,
                        boxShadow: "none",
                      }}
                      formatter={(value) => [
                        percent(Number(value)),
                        "Citation rate",
                      ]}
                    />
                    <Area
                      dataKey="citationRate"
                      dot={{ fill: "#fff", r: 3, stroke: "#18181b", strokeWidth: 2 }}
                      fill="url(#sourceCitationRate)"
                      name="Citation rate"
                      stroke="#18181b"
                      strokeWidth={2}
                      type="monotone"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState
                  title="No trend data"
                  description="Citation history will appear after completed prompt runs."
                />
              )}
            </div>
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
                      disabled={offset === 0 || query.isFetching}
                      onClick={() =>
                        setPagination({
                          pageKey,
                          offset: Math.max(0, offset - pageSize),
                        })
                      }
                    >
                      <ChevronLeft size={14} /> Previous
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!query.data?.page.nextCursor || query.isFetching}
                      onClick={() =>
                        setPagination({
                          pageKey,
                          offset: offset + pageSize,
                        })
                      }
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

export function BrandsPage() {
  const { projectId } = useApp();
  const query = useProjectAnalytics<Array<Record<string, string | number>>>("brands");
  if (!projectId) return <NoProject />;
  return (
    <div className="page">
      <PageHeader
        title="Brand visibility"
        description="Tracked brand names and aliases detected in captured answers, ignoring letter case."
        action={
          <Button
            variant="secondary"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={14} />
            {query.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
      <div className="brand-grid">
        {query.isPending ? Array.from({ length: 3 }, (_, index) => (
          <Skeleton className="brand-card-skeleton" key={index} />
        )) : query.data?.length ? query.data.map((brand) => (
          <Card className="brand-card" key={String(brand.id)}>
            <div className="brand-avatar">{String(brand.name).slice(0, 1).toUpperCase()}</div>
            <div><Badge tone={brand.kind === "owned" ? "info" : "neutral"}>{brand.kind}</Badge><h3>{brand.name}</h3><strong>{compact(Number(brand.mentioned_snapshot_count))}</strong><span>mentioning snapshots</span></div>
          </Card>
        )) : <Card><EmptyState title="No brand metrics" description="Configure brand aliases and complete a tracking run." /></Card>}
      </div>
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
}

export function ShoppingPage() {
  const { projectId } = useApp();
  const pageSize = 10;
  const [pagination, setPagination] = useState({ projectId, offset: 0 });
  const offset =
    pagination.projectId === projectId ? pagination.offset : 0;
  const query = useQuery({
    queryKey: ["shopping", projectId, offset],
    queryFn: () =>
      apiPage<ShoppingRow[]>(
        `/analytics/shopping?projectId=${projectId}&offset=${offset}&limit=${pageSize}`,
      ),
    enabled: Boolean(projectId),
  });
  if (!projectId) return <NoProject />;
  const products = query.data?.data ?? [];
  const total = query.data?.page.total ?? 0;
  const firstItem = total ? offset + 1 : 0;
  const lastItem = Math.min(offset + products.length, total);
  return (
    <div className="page">
      <PageHeader
        eyebrow="Last 30 days"
        title="Shopping"
        description="Deduplicated products surfaced in captured shopping blocks."
      />
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
                const href = productDestination(product);
                return {
                  id: product.id,
                  product: (
                    <div className="shopping-table-product">
                      <span className="shopping-table-image">
                        {product.images[0] ? (
                          <img src={product.images[0]} alt="" loading="lazy" />
                        ) : (
                          <ShoppingBag size={17} />
                        )}
                      </span>
                      <strong>{product.title ?? "Untitled product"}</strong>
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
                  action: (
                    <Button asChild variant="secondary">
                      <a href={href} target="_blank" rel="noreferrer">
                        Open <ExternalLink size={13} />
                      </a>
                    </Button>
                  ),
                };
              })}
            />
            <div className="table-pagination">
              <span>{firstItem}–{lastItem} of {total}</span>
              <div>
                <Button
                  variant="secondary"
                  disabled={offset === 0 || query.isFetching}
                  onClick={() =>
                    setPagination({
                      projectId,
                      offset: Math.max(0, offset - pageSize),
                    })
                  }
                >
                  <ChevronLeft size={14} /> Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={!query.data?.page.nextCursor || query.isFetching}
                  onClick={() =>
                    setPagination({
                      projectId,
                      offset: offset + pageSize,
                    })
                  }
                >
                  Next <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            title="No shopping products"
            description="Products will appear when a captured answer contains a shopping block."
          />
        )}
      </Card>
    </div>
  );
}

export function AlertsPage() {
  const { projectId } = useApp();
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
    create.mutate({ name: data.get("name"), eventType: data.get("eventType"), threshold: data.get("threshold") ? Number(data.get("threshold")) : null, channels: ["in_app", "webhook"] });
  };
  return (
    <div className="page">
      <PageHeader title="Alerts" description="Change detection with in-app history and signed webhook delivery." action={<Button onClick={() => setOpen(true)}><Plus size={15}/> Add rule</Button>} />
      <div className="split-grid">
        <Card><CardHeader title="Recent events" description="Newest visibility changes across projects." />{alerts.data?.length ? <div className="alert-list">{alerts.data.map((alert) => <div className="alert-row" key={String(alert.id)}><span className="alert-icon"><AlertTriangle size={16}/></span><div><strong>{alert.title}</strong><p>{alert.message}</p><span>{dateTime(String(alert.created_at))}</span></div><Badge tone={alert.is_read ? "neutral" : "warning"}>{alert.is_read ? "Read" : "New"}</Badge></div>)}</div> : <EmptyState title="No alerts" description="Configured changes will appear here." />}</Card>
        <Card><CardHeader title="Rules" description={`${rules.data?.length ?? 0} configured`} />{rules.data?.length ? <div className="rule-list">{rules.data.map((rule) => <div key={String(rule.id)}><span className="status-dot"/><div><strong>{rule.name}</strong><span>{String(rule.event_type).replaceAll("_", " ")}</span></div><Badge tone="success">Active</Badge></div>)}</div> : <EmptyState title="No rules" description="Create a rule for the changes that matter." />}</Card>
      </div>
      <Dialog open={open} onOpenChange={setOpen} title="Create alert rule" description="Webhook delivery is used when a destination is configured.">
        <form className="form-stack" onSubmit={submit}><Label>Rule name</Label><Input name="name" required /><Label>Event</Label><select className="input" name="eventType"><option value="own_citation_lost">Owned citation lost</option><option value="brand_mention_lost">Brand mention lost</option><option value="competitor_citation_gained">Competitor gained visibility</option><option value="product_block_changed">Product block changed</option><option value="visibility_drop">Visibility drop</option><option value="run_failed">Run failed</option></select><Label hint="Used for visibility drop">Threshold (percentage points)</Label><Input name="threshold" type="number" min="0" max="100" defaultValue="10" /><div className="dialog-actions"><Button variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button><Button>Create rule</Button></div></form>
      </Dialog>
    </div>
  );
}

export function ExportsPage() {
  const { projectId } = useApp();
  const queryClient = useQueryClient();
  const exportsQuery = useQuery({ queryKey: ["exports"], queryFn: () => api<Array<Record<string, string | number | null>>>("/exports"), refetchInterval: 10_000 });
  const create = useMutation({
    mutationFn: (format: "csv" | "ndjson") => post("/exports", { projectId, format }),
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
  const [open, setOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<Array<Record<string, string>>>("/users") });
  const invite = useMutation({
    mutationFn: (body: Record<string, string>) => post<{ link: string }>("/auth/invitations", body),
    onSuccess: (data) => setInviteLink(data.link),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    invite.mutate({ email: formText(data, "email"), role: formText(data, "role") });
  };
  return (
    <div className="page">
      <PageHeader title="Workspace users" description="Role-based access for owners, admins, editors, and viewers." action={<Button onClick={() => { setInviteLink(""); setOpen(true); }}><UserPlus size={15}/> Invite user</Button>} />
      <Card>{users.data?.length ? <DataTable columns={[{key:"user",label:"User"},{key:"role",label:"Role"},{key:"status",label:"Status"},{key:"last",label:"Last login"}]} rows={users.data.map((user) => ({id:user.id,user:<div className="primary-cell"><strong>{user.display_name}</strong><span>{user.email}</span></div>,role:<Badge tone={user.role === "owner" ? "info" : "neutral"}>{user.role}</Badge>,status:<Badge tone="success">{user.status}</Badge>,last:dateTime(user.last_login_at)}))} /> : null}</Card>
      <Dialog open={open} onOpenChange={setOpen} title="Invite workspace user" description="Invite links expire after 24 hours and are shown once.">
        {inviteLink ? <div className="success-panel"><CheckCircle2/><p>Copy and send this link securely.</p><code className="invite-link">{inviteLink}</code><Button onClick={() => void navigator.clipboard.writeText(inviteLink)}>Copy link</Button></div> : <form className="form-stack" onSubmit={submit}><Label>Email</Label><Input name="email" type="email" required /><Label>Role</Label><select className="input" name="role"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option></select><Button disabled={invite.isPending}><Send size={15}/> Create invitation</Button></form>}
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
  const health = useQuery({ queryKey: ["health"], queryFn: () => api<Record<string, unknown>>("/settings/health"), enabled: session.user.role === "owner" || session.user.role === "admin" });
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
                  <span className="settings-icon"><Globe2 /></span>
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
