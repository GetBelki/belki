import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  Megaphone,
  Search,
} from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
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
import { DomainFavicon } from "../components/domain-favicon";
import { TagPicker, type PromptTag } from "../components/prompt-tags";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  DataTable,
  EmptyState,
  Input,
  Select,
  Skeleton,
  TableSkeleton,
} from "../components/ui";
import { useApp } from "../context";
import { api } from "../lib/api";
import { LOCATION_OPTIONS, localeLabel } from "../lib/locale-catalog";
import { compact, dateTime, percent } from "../lib/utils";
import { TRACKING_SOURCE_LABELS } from "../../shared/tracking-sources";

type AdPeriod = "7d" | "30d" | "90d" | "365d";
type AdRelationship = "owned" | "competitor" | "untracked";

interface AdCreative {
  creativeKey: string;
  advertiserKey: string;
  advertiserName: string;
  advertiserDomain: string | null;
  relationship: AdRelationship;
  title: string | null;
  snippet: string | null;
  destinationUrl: string | null;
  destinationDomain: string | null;
  imageUrl: string | null;
  imageFallbackUrl: string | null;
  faviconUrl: string | null;
  faviconFallbackUrl: string | null;
  appearances: number;
  servedAppearances: number;
  hiddenAppearances: number;
  renderRate: number;
  firstSeen: string;
  latestSeen: string;
  averagePosition: number | null;
}

interface AdsOverview {
  period: AdPeriod;
  indexing: boolean;
  summary: {
    appearanceRate: number;
    servedAppearanceRate: number;
    appearances: number;
    servedAppearances: number;
    hiddenAppearances: number;
    activeAdvertisers: number;
    servedAdvertisers: number;
    uniqueCreatives: number;
    servedCreatives: number;
    completedResponses: number;
  };
  trend: Array<{
    date: string;
    appearances: number;
    servedAppearances: number;
    hiddenAppearances: number;
    adSnapshots: number;
    completedResponses: number;
    appearanceRate: number;
    servedAppearanceRate: number;
  }>;
  advertisers: Array<{
    advertiserKey: string;
    name: string;
    domain: string | null;
    relationship: AdRelationship;
    appearances: number;
    servedAppearances: number;
    hiddenAppearances: number;
    renderRate: number;
    adShare: number;
    snapshots: number;
    prompts: number;
    creatives: number;
    firstSeen: string | null;
    latestSeen: string | null;
    firstServed: string;
    latestServed: string;
    servedOnly: boolean;
    faviconUrl: string | null;
  }>;
  creatives: AdCreative[];
}

interface AdvertiserDetail {
  advertiser: {
    advertiserKey: string;
    name: string;
    domain: string | null;
    website: string | null;
    relationship: AdRelationship;
    faviconUrl: string | null;
    appearances: number;
    servedAppearances: number;
    hiddenAppearances: number;
    renderRate: number;
    snapshots: number;
    servedSnapshots: number;
    prompts: number;
    servedPrompts: number;
    creatives: number;
    servedCreatives: number;
    firstSeen: string | null;
    latestSeen: string | null;
    firstServed: string;
    latestServed: string;
  };
  trend: Array<{
    date: string;
    appearances: number;
    servedAppearances: number;
    hiddenAppearances: number;
    snapshots: number;
    servedSnapshots: number;
  }>;
  creatives: AdCreative[];
  prompts: Array<{
    id: string;
    query: string;
    locationCode: number;
    languageCode: string;
    appearances: number;
    servedAppearances: number;
    hiddenAppearances: number;
    renderRate: number;
    snapshots: number;
    servedSnapshots: number;
    latestSeen: string;
    latestSnapshotId: string;
    tags: Array<{ id: string; name: string }>;
  }>;
}

const PERIOD_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "365d", label: "Last 365 days" },
];

function periodValue(value: string | null): AdPeriod {
  return value === "7d" || value === "90d" || value === "365d" ? value : "30d";
}

function relationshipLabel(value: AdRelationship) {
  return value === "owned" ? "Your brand" : value === "competitor" ? "Competitor" : "Untracked";
}

function tableRowId(row: Record<string, React.ReactNode>): string {
  return typeof row.id === "string" || typeof row.id === "number"
    ? String(row.id)
    : "";
}

function AdvertiserIdentity({
  name,
  domain,
  faviconUrl,
  faviconFallbackUrl,
}: {
  name: string;
  domain: string | null;
  faviconUrl: string | null;
  faviconFallbackUrl?: string | null;
}) {
  return (
    <span className="advertiser-identity">
      <span className="advertiser-favicon">
        {domain ? <DomainFavicon domain={domain} size={18} /> : <Megaphone size={16} />}
        {faviconUrl ? (
          <img
            src={faviconUrl}
            alt=""
            loading="lazy"
            onError={(event) => {
              if (faviconFallbackUrl && event.currentTarget.dataset.fallbackAttempted !== "true") {
                event.currentTarget.dataset.fallbackAttempted = "true";
                event.currentTarget.src = faviconFallbackUrl;
                return;
              }
              event.currentTarget.remove();
            }}
          />
        ) : null}
      </span>
      <span><strong>{name}</strong>{domain ? <small>{domain}</small> : null}</span>
    </span>
  );
}

function CreativeCard({ creative }: { creative: AdCreative }) {
  return (
    <article className="ad-creative-card">
      <div className="ad-creative-image">
        <ImageIcon className="ad-image-fallback" size={22} />
        {creative.imageUrl ? (
          <img
            src={creative.imageUrl}
            alt=""
            loading="lazy"
            onError={(event) => {
              if (creative.imageFallbackUrl && event.currentTarget.dataset.fallbackAttempted !== "true") {
                event.currentTarget.dataset.fallbackAttempted = "true";
                event.currentTarget.src = creative.imageFallbackUrl;
                return;
              }
              event.currentTarget.remove();
            }}
          />
        ) : null}
        <Badge tone={creative.appearances === 0 ? "warning" : "neutral"}>
          {creative.appearances === 0 ? "Served only" : "Rendered"}
        </Badge>
      </div>
      <div className="ad-creative-body">
        <AdvertiserIdentity
          name={creative.advertiserName}
          domain={creative.advertiserDomain}
          faviconUrl={creative.faviconUrl}
          faviconFallbackUrl={creative.faviconFallbackUrl}
        />
        <h3>{creative.title ?? "Untitled ad"}</h3>
        {creative.snippet ? <p>{creative.snippet}</p> : null}
        <div className="ad-creative-meta">
          <span>{creative.appearances} rendered · {creative.hiddenAppearances} hidden</span>
          <span>Latest {dateTime(creative.latestSeen)}</span>
          {creative.averagePosition !== null
            ? <span>Avg. position {creative.averagePosition.toFixed(1)}</span>
            : null}
        </div>
        <div className="ad-creative-actions">
          <Link to={`/ads/${creative.advertiserKey}`}>Advertiser activity</Link>
          {creative.destinationUrl ? (
            <a href={creative.destinationUrl} target="_blank" rel="noreferrer">
              Open ad <ExternalLink size={13} />
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function AdsPage() {
  const { projectId, currentProject, trackingSource } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const period = periodValue(searchParams.get("period"));
  const search = searchParams.get("search") ?? "";
  const country = searchParams.get("country") ?? "";
  const relationship = searchParams.get("relationship") ?? "";
  const selectedTagIds = (searchParams.get("tags") ?? "").split(",").filter(Boolean);
  const tags = useQuery({
    queryKey: ["prompt-tags", projectId],
    queryFn: () => api<PromptTag[]>(`/projects/${projectId}/tags`),
    enabled: Boolean(projectId),
  });
  const params = new URLSearchParams({
    projectId: projectId ?? "",
    source: trackingSource,
    period,
  });
  if (search) params.set("search", search);
  if (country) params.set("locationCode", country);
  if (relationship) params.set("relationship", relationship);
  if (selectedTagIds.length) params.set("tagIds", selectedTagIds.join(","));
  const query = useQuery({
    queryKey: ["ads", projectId, trackingSource, period, search, country, relationship, selectedTagIds.join(",")],
    queryFn: () => api<AdsOverview>(`/analytics/ads?${params}`),
    enabled: Boolean(projectId),
    placeholderData: (previous) => previous,
  });
  if (!projectId) return <NoProject />;
  const data = query.data;
  const projectHasAds = Number(
    currentProject?.source_data_counts?.[trackingSource]?.ads ?? 0,
  ) > 0;
  const hasTrendActivity = Boolean(data?.trend.some((row) => row.servedAppearances > 0));
  const noAdsDetected = !query.isPending
    && !query.isError
    && !data?.indexing
    && !projectHasAds
    && Number(data?.summary.appearances ?? 0) === 0;
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  return (
    <div className="page ads-page">
      <PageHeader
        eyebrow={PERIOD_OPTIONS.find((option) => option.value === period)?.label}
        title="Ads"
        description={`Rendered ${TRACKING_SOURCE_LABELS[trackingSource]} ads, with served-but-hidden placements retained for diagnostics.`}
        action={<div className="ads-period-select"><Select value={period} onValueChange={(value) => update("period", value)} options={PERIOD_OPTIONS} /></div>}
      />
      {noAdsDetected ? (
        <Card className="ads-empty-card">
          <EmptyState
            title="No ads detected yet"
            description={`This source will appear here automatically after a captured ${TRACKING_SOURCE_LABELS[trackingSource]} response contains a sponsored result.`}
          />
        </Card>
      ) : (
        <>
      {data?.indexing ? (
        <div className="indexing-notice">Historical ads are being indexed. New results already appear here.</div>
      ) : null}
      <div className="ad-kpis">
        {query.isPending ? Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="ad-kpi" />) : (
          <>
            <div className="ad-kpi"><span>Rendered response rate</span><strong>{percent(data?.summary.appearanceRate ?? 0)}</strong><small>{percent(data?.summary.servedAppearanceRate ?? 0)} received an ad payload</small></div>
            <div className="ad-kpi"><span>Rendered ads</span><strong>{compact(data?.summary.appearances ?? 0)}</strong><small>{compact(data?.summary.servedAppearances ?? 0)} served in total</small></div>
            <div className="ad-kpi"><span>Served but hidden</span><strong>{compact(data?.summary.hiddenAppearances ?? 0)}</strong><small>Not visible to users</small></div>
            <div className="ad-kpi"><span>Rendered advertisers</span><strong>{compact(data?.summary.activeAdvertisers ?? 0)}</strong><small>{compact(data?.summary.servedAdvertisers ?? 0)} served in total</small></div>
          </>
        )}
      </div>
      <Card className="ad-trend-card">
        <CardHeader title="Ad activity trend" description="Daily visible placements compared with ads served but hidden by ChatGPT." />
        <CardContent className={`ad-trend-chart${!query.isPending && !hasTrendActivity ? " ad-trend-empty" : ""}`}>
          {query.isPending ? <Skeleton className="chart-skeleton" /> : hasTrendActivity ? (
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={data?.trend ?? []} margin={{ top: 8, right: 10, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: "#71717a", fontSize: 11 }} />
                <YAxis yAxisId="rate" domain={[0, 100]} tickFormatter={(value) => `${value}%`} tickLine={false} axisLine={false} width={52} />
                <YAxis yAxisId="count" orientation="right" allowDecimals={false} tickLine={false} axisLine={false} width={34} />
                <Tooltip formatter={(value, name) => name === "Rendered response rate" ? `${Number(value).toFixed(1)}%` : Number(value)} />
                <Line yAxisId="rate" type="monotone" dataKey="appearanceRate" name="Rendered response rate" stroke="#18181b" strokeWidth={2.5} dot={{ r: 2 }} />
                <Line yAxisId="count" type="monotone" dataKey="appearances" name="Rendered ads" stroke="#7c3aed" strokeWidth={2} dot={{ r: 2 }} />
                <Line yAxisId="count" type="monotone" dataKey="hiddenAppearances" name="Served but hidden" stroke="#d97706" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : <EmptyState title="No ad activity" description="Ads will appear when a captured response contains a sponsored result." />}
        </CardContent>
      </Card>
      <div className="report-filters ads-report-filters">
        <div className="search-filter"><Search size={15} /><Input aria-label="Search ads" placeholder="Search advertisers or ad copy" value={search} onChange={(event) => update("search", event.target.value)} /></div>
        <Select value={country || "all"} onValueChange={(value) => update("country", value === "all" ? "" : value)} options={[{ value: "all", label: "All countries" }, ...LOCATION_OPTIONS]} />
        <Select value={relationship || "all"} onValueChange={(value) => update("relationship", value === "all" ? "" : value)} options={[
          { value: "all", label: "All advertisers" },
          { value: "owned", label: "Your brand" },
          { value: "competitor", label: "Competitors" },
          { value: "untracked", label: "Untracked" },
        ]} />
        <TagPicker
          disabled={tags.isPending || !tags.data?.length}
          label={selectedTagIds.length ? "Filtered tags" : "All tags"}
          selectedNames={selectedTagIds.map((id) => tags.data?.find((tag) => tag.id === id)?.name).filter((name): name is string => Boolean(name))}
          tags={tags.data ?? []}
          onToggle={(name, selected) => {
            const id = tags.data?.find((tag) => tag.name === name)?.id;
            if (!id) return;
            update("tags", (selected ? [...new Set([...selectedTagIds, id])] : selectedTagIds.filter((value) => value !== id)).join(","));
          }}
        />
      </div>
      <Card>
        <CardHeader title="Advertisers" description="Rendered-first activity, including advertisers whose ads were only served in the payload." />
        {query.isPending ? <TableSkeleton rows={6} columns={7} /> : data?.advertisers.length ? (
          <DataTable
            columns={[
              { key: "advertiser", label: "Advertiser" },
              { key: "relationship", label: "Relationship" },
              { key: "renderRate", label: "Render rate" },
              { key: "appearances", label: "Rendered" },
              { key: "hidden", label: "Hidden" },
              { key: "creatives", label: "Creatives" },
              { key: "prompts", label: "Prompts" },
              { key: "latest", label: "Latest seen" },
              { key: "open", label: "" },
            ]}
            rows={data.advertisers.map((advertiser) => ({
              id: advertiser.advertiserKey,
              advertiser: <AdvertiserIdentity name={advertiser.name} domain={advertiser.domain} faviconUrl={advertiser.faviconUrl} />,
              relationship: <Badge>{relationshipLabel(advertiser.relationship)}</Badge>,
              renderRate: advertiser.servedOnly
                ? <Badge tone="warning">Served only</Badge>
                : percent(advertiser.renderRate),
              appearances: <strong>{compact(advertiser.appearances)}</strong>,
              hidden: compact(advertiser.hiddenAppearances),
              creatives: compact(advertiser.creatives),
              prompts: compact(advertiser.prompts),
              latest: dateTime(advertiser.latestSeen ?? advertiser.latestServed),
              open: <ChevronRight size={16} />,
            }))}
            onRowClick={(row) => void navigate(`/ads/${tableRowId(row)}`)}
            rowAriaLabel={(row) => `Open advertiser activity for ${tableRowId(row)}`}
          />
        ) : <EmptyState title="No advertisers found" description="Try a wider period or remove filters." />}
      </Card>
      <Card>
        <CardHeader title="Recent creatives" description="Latest distinct ads, including their retained image assets and copy." />
        <CardContent>
          {query.isPending ? <div className="ad-creative-grid ad-creative-grid-cards"><Skeleton /><Skeleton /><Skeleton /></div>
            : data?.creatives.length ? <div className="ad-creative-grid ad-creative-grid-cards">{data.creatives.map((creative) => <CreativeCard creative={creative} key={creative.creativeKey} />)}</div>
            : <EmptyState title="No creatives found" description="Captured ad creatives will appear here." />}
        </CardContent>
      </Card>
        </>
      )}
    </div>
  );
}

export function AdvertiserDetailPage() {
  const { projectId, trackingSource } = useApp();
  const { advertiserKey } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const period = periodValue(searchParams.get("period"));
  const detailView = searchParams.get("view") === "creatives" ? "creatives" : "overview";
  const updateDetailParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const query = useQuery({
    queryKey: ["advertiser-ads", projectId, advertiserKey, trackingSource, period],
    queryFn: () => api<AdvertiserDetail>(`/analytics/ads/${advertiserKey}?projectId=${projectId}&source=${trackingSource}&period=${period}`),
    enabled: Boolean(projectId && advertiserKey),
  });
  if (!projectId) return <NoProject />;
  const advertiser = query.data?.advertiser;
  return (
    <div className="page ads-page">
      <Link className="back-link" to="/ads"><ArrowLeft size={14} /> Ads</Link>
      <PageHeader
        eyebrow="Advertiser activity"
        title={advertiser?.name ?? "Advertiser"}
        description={advertiser?.domain ?? "Sponsored appearances across captured responses."}
        action={<div className="ads-period-select"><Select value={period} onValueChange={(value) => updateDetailParam("period", value)} options={PERIOD_OPTIONS} /></div>}
      />
      <div className="ad-detail-tabs" role="tablist" aria-label="Advertiser activity views">
        <button aria-selected={detailView === "overview"} className={detailView === "overview" ? "active" : undefined} onClick={() => updateDetailParam("view", "")} role="tab" type="button">Overview</button>
        <button aria-selected={detailView === "creatives"} className={detailView === "creatives" ? "active" : undefined} onClick={() => updateDetailParam("view", "creatives")} role="tab" type="button">Creatives <span>{compact(advertiser?.servedCreatives ?? 0)}</span></button>
      </div>
      {detailView === "creatives" ? (
        <section className="ad-creatives-panel" role="tabpanel">
          <div className="ad-panel-heading"><div><h2>Creatives</h2><p>Copy, destinations, assets, and observed positions.</p></div></div>
          {query.isPending ? <div className="ad-creative-grid ad-creative-grid-cards"><Skeleton /><Skeleton /><Skeleton /></div> : query.data?.creatives.length ? (
            <div className="ad-creative-grid ad-creative-grid-cards">{query.data.creatives.map((creative) => <CreativeCard creative={creative} key={creative.creativeKey} />)}</div>
          ) : <EmptyState title="No creatives" description="No creatives were captured in this period." />}
        </section>
      ) : (
        <>
      {query.isPending ? <Skeleton className="ad-detail-summary" /> : advertiser ? (
        <Card className="ad-detail-summary"><CardContent>
          <div className="ad-detail-identity">
            <AdvertiserIdentity name={advertiser.name} domain={advertiser.domain} faviconUrl={advertiser.faviconUrl} />
            <Badge>{relationshipLabel(advertiser.relationship)}</Badge>
            {advertiser.website ? <a href={advertiser.website} target="_blank" rel="noreferrer">Website <ExternalLink size={13} /></a> : null}
          </div>
          <div className="ad-detail-metrics">
            <div><span>Rendered</span><strong>{compact(advertiser.appearances)}</strong><small>{compact(advertiser.snapshots)} visible responses</small></div>
            <div><span>Served but hidden</span><strong>{compact(advertiser.hiddenAppearances)}</strong><small>{percent(advertiser.renderRate)} render rate</small></div>
            <div><span>Rendered prompts</span><strong>{compact(advertiser.prompts)}</strong><small>{compact(advertiser.servedPrompts)} served in total</small></div>
            <div><span>Latest rendered</span><strong className="ad-kpi-date">{dateTime(advertiser.latestSeen ?? advertiser.latestServed)}</strong><small>{advertiser.latestSeen ? "Visible to the user" : "Served only"}</small></div>
          </div>
        </CardContent></Card>
      ) : null}
      <Card className="ad-trend-card"><CardHeader title="Appearance trend" description="Rendered placements compared with served-but-hidden placements." /><CardContent className="ad-trend-chart">
        {query.isPending ? <Skeleton className="chart-skeleton" /> : query.data?.trend.length ? (
          <ResponsiveContainer width="100%" height="100%" minWidth={0}><LineChart data={query.data.trend}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" /><XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: "#71717a", fontSize: 11 }} /><YAxis allowDecimals={false} tickLine={false} axisLine={false} width={34} /><Tooltip /><Line type="monotone" dataKey="appearances" name="Rendered" stroke="#18181b" strokeWidth={2.5} dot={{ r: 2 }} /><Line type="monotone" dataKey="hiddenAppearances" name="Served but hidden" stroke="#d97706" strokeWidth={2} dot={{ r: 2 }} /></LineChart></ResponsiveContainer>
        ) : <EmptyState title="No trend data" description="No appearances were captured in this period." />}
      </CardContent></Card>
      <Card><CardHeader title="Prompts serving this advertiser" description="Tracked prompts where this advertiser was served, whether rendered or hidden." />
        {query.isPending ? <TableSkeleton rows={6} columns={6} /> : query.data?.prompts.length ? <DataTable columns={[
          { key: "prompt", label: "Prompt" }, { key: "locale", label: "Locale" },
          { key: "tags", label: "Tags" }, { key: "appearances", label: "Rendered" },
          { key: "hidden", label: "Hidden" },
          { key: "latest", label: "Latest seen" }, { key: "open", label: "" },
        ]} rows={query.data.prompts.map((prompt) => ({
          id: prompt.latestSnapshotId,
          prompt: <strong>{prompt.query}</strong>,
          locale: <span className="country-cell"><CountryFlag locationCode={prompt.locationCode} />{localeLabel(prompt.locationCode, prompt.languageCode)}</span>,
          tags: prompt.tags.length ? prompt.tags.map((tag) => <Badge key={tag.id}>{tag.name}</Badge>) : "—",
          appearances: <strong>{compact(prompt.appearances)}</strong>,
          hidden: prompt.appearances === 0
            ? <Badge tone="warning">{compact(prompt.hiddenAppearances)} served only</Badge>
            : compact(prompt.hiddenAppearances),
          latest: dateTime(prompt.latestSeen),
          open: <Link to={`/snapshots/${prompt.latestSnapshotId}`} aria-label={`Open latest snapshot for ${prompt.query}`}><ChevronRight size={16} /></Link>,
        }))} /> : <EmptyState title="No prompts" description="No prompt appearances were captured in this period." />}
      </Card>
        </>
      )}
    </div>
  );
}
