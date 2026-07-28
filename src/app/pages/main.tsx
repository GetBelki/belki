import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  FileJson,
  Globe2,
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
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { NoProject, PageHeader } from "../components/layout";
import { CountryFlag } from "../components/country-flag";
import {
  Badge,
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
} from "../components/ui";
import { useApp } from "../context";
import { api, patch, post } from "../lib/api";
import {
  LOCATION_OPTIONS,
  languagesForLocation,
} from "../lib/locale-catalog";
import { isRunInProgress, runStatusLabel } from "../lib/run-status";
import { compact, dateTime, formText, percent, pluralize } from "../lib/utils";
import type { RunStatus } from "../../shared/contracts";

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
  recentSnapshots: Array<Record<string, string | number | null>>;
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

export function OverviewPage() {
  const { projectId, currentProject } = useApp();
  const overview = useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => api<Overview>(`/analytics/overview?projectId=${projectId}`),
    enabled: Boolean(projectId),
  });
  if (!projectId) return <NoProject />;
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
          <KpiCard label="Citation rate" value={percent(overview.data?.summary.citationRate ?? 0)} detail={pluralize(overview.data?.summary.cited_runs ?? 0, "cited run")} icon={<Globe2 size={19} />} />
          <KpiCard label="Brand mention rate" value={percent(overview.data?.summary.brandMentionRate ?? 0)} detail={pluralize(overview.data?.summary.brand_mentioned_runs ?? 0, "mention")} icon={<Sparkles size={19} />} tone="blue" />
          <KpiCard
            label="Product prompt coverage"
            value={percent(overview.data?.summary.productPromptCoverage ?? 0)}
            detail={`${overview.data?.summary.productPromptCount ?? 0} of ${overview.data?.summary.trackedPromptCount ?? 0} tracked prompts`}
            icon={<ShoppingBag size={19} />}
            tone="green"
          />
          <KpiCard label="Completed runs" value={compact(overview.data?.summary.completed_runs ?? 0)} detail={`${pluralize(overview.data?.summary.total_citations ?? 0, "citation")} captured`} icon={<Search size={19} />} tone="amber" />
        </div>
      )}
      <div className="dashboard-grid">
        <Card className="chart-card">
          <CardHeader title="Visibility trend" description="Daily citation and brand-mention rates" />
          <div className="chart">
            {(overview.data?.series.length ?? 0) > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={overview.data?.series}>
                  <defs>
                    <linearGradient id="citation" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#18181b" stopOpacity={0.12}/><stop offset="95%" stopColor="#18181b" stopOpacity={0}/></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" />
                  <XAxis dataKey="metric_date" tickLine={false} axisLine={false} tick={{ fill: "#71717a", fontSize: 11 }} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fill: "#71717a", fontSize: 11 }} />
                  <Tooltip contentStyle={{ borderRadius: 6, border: "1px solid #d4d4d8", boxShadow: "none" }} />
                  <Area type="monotone" dataKey="cited_runs" name="Cited runs" stroke="#18181b" strokeWidth={2} fill="url(#citation)" />
                  <Area type="monotone" dataKey="brand_mentioned_runs" name="Brand mentions" stroke="#71717a" strokeWidth={2} fill="transparent" />
                </AreaChart>
              </ResponsiveContainer>
            ) : <EmptyState title="No trend data yet" description="Your first completed tracking run will appear here." />}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent AI responses" description="Latest completed prompt runs" />
          <div className="activity-list">
            {overview.data?.recentSnapshots.length ? overview.data.recentSnapshots.map((snapshot) => (
              <div className="activity-row" key={String(snapshot.id)}>
                <span className="activity-icon"><FileJson size={15} /></span>
                <div><strong>{String(snapshot.query_text)}</strong><span>{dateTime(String(snapshot.captured_at))}</span></div>
                <Badge tone={Number(snapshot.cited_domains_count) ? "success" : "neutral"}>{Number(snapshot.cited_domains_count)} cited</Badge>
              </div>
            )) : <EmptyState title="No responses yet" description="Add a prompt to begin monitoring." />}
          </div>
        </Card>
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
}

export function PromptsPage() {
  const { projectId } = useApp();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const [locationCode, setLocationCode] = useState("2840");
  const [languageCode, setLanguageCode] = useState("en");
  const languageOptions = languagesForLocation(locationCode);
  const search = searchParams.get("search") ?? "";
  const country = searchParams.get("country") ?? "";
  const language = searchParams.get("language") ?? "";
  const reportParams = new URLSearchParams({ projectId: projectId ?? "" });
  if (search) reportParams.set("search", search);
  if (country) reportParams.set("locationCode", country);
  if (language) reportParams.set("languageCode", language);
  const queries = useQuery({
    queryKey: ["prompts", projectId, search, country, language],
    queryFn: () => api<QueryRow[]>(`/analytics/prompts?${reportParams}`),
    enabled: Boolean(projectId),
    refetchInterval: (current) =>
      current.state.data?.some((query) =>
        isRunInProgress(query.latestRunStatus),
      )
        ? 3_000
        : false,
  });
  const createQuery = useMutation({
    mutationFn: (body: Record<string, unknown>) => post(`/projects/${projectId}/queries`, body),
    onSuccess: async () => {
      setDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["prompts", projectId] });
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
  if (!projectId) return <NoProject />;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const cadence = formText(data, "cadence");
    createQuery.mutate({
      queryText: data.get("queryText"),
      locationCode: Number(locationCode),
      languageCode,
      forceWebSearch: true,
      schedule: cadence === "weekly"
        ? { cadence, weekday: Number(data.get("weekday")), time: data.get("time"), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        : { cadence, time: data.get("time"), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
  };
  return (
    <div className="page">
      <PageHeader title="Prompts" description="Prompts monitored against ChatGPT web Search mode." action={
        <Button onClick={() => setDialogOpen(true)}><Plus size={16} /> Add prompt</Button>
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
      </div>
      <Card>
        <CardHeader title={pluralize(queries.data?.length ?? 0, "prompt")} description="Latest capture metrics with a rolling 30-day owned-brand mention rate." />
        {queries.data?.length ? (
          <DataTable
            columns={[
              { key: "query", label: "Prompt" }, { key: "country", label: "Country" },
              { key: "sources", label: "Sources" }, { key: "mentions", label: "Mentions" },
              { key: "rate", label: "Mention rate" }, { key: "citations", label: "Citations" },
              { key: "change", label: "Mention change" },
              { key: "actions", label: "" },
            ]}
            rows={queries.data.map((query) => {
              const runInProgress = isRunInProgress(query.latestRunStatus);
              const isStarting =
                manualRun.isPending && manualRun.variables === query.id;
              const destination = query.latestSnapshotId
                ? `/prompts/${query.id}/snapshots/${query.latestSnapshotId}`
                : `/prompts/${query.id}`;
              return {
                id: query.id,
                query: <Link className="primary-cell table-query-link" to={destination}><strong>{query.queryText}</strong><span>{dateTime(query.latestCapturedAt)} · {pluralize(query.snapshotCount, "capture")}</span></Link>,
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
                  <button className="plain-button" onClick={() => toggle.mutate({ id: query.id, isActive: !query.isActive })}><Badge tone={query.isActive ? "success" : "neutral"}>{query.isActive ? "Active" : "Paused"}</Badge></button>
                  <Button variant="secondary" disabled={isStarting || runInProgress} onClick={() => manualRun.mutate(query.id)}><RefreshCw size={14} /> {isStarting ? "Queued…" : runStatusLabel(query.latestRunStatus)}</Button>
                </div>,
              };
            })}
          />
        ) : <EmptyState title="No prompts found" description="Add the prompts your audience asks ChatGPT or adjust the filters." action={<Button onClick={() => setDialogOpen(true)}><Plus size={15} /> Add prompt</Button>} />}
      </Card>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} title="Add tracked prompt" description="Schedule a web-grounded ChatGPT result capture.">
        <form className="form-stack" onSubmit={submit}>
          <Label>Prompt</Label><textarea className="textarea" name="queryText" required maxLength={2000} placeholder="What are the best project management tools for remote teams?" />
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
          <div className="dialog-actions"><Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button><Button disabled={createQuery.isPending}>{createQuery.isPending ? "Adding…" : "Add prompt"}</Button></div>
        </form>
      </Dialog>
    </div>
  );
}

export const QueriesPage = PromptsPage;
