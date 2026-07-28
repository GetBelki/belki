import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileJson,
  Globe2,
  Plus,
  RefreshCw,
  Search,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
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
  localeLabel,
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
          <KpiCard label="Product block rate" value={percent(overview.data?.summary.productBlockRate ?? 0)} detail={pluralize(overview.data?.summary.product_runs ?? 0, "product result")} icon={<ShoppingBag size={19} />} tone="green" />
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
          <CardHeader title="Recent evidence" description="Latest captured snapshots" />
          <div className="activity-list">
            {overview.data?.recentSnapshots.length ? overview.data.recentSnapshots.map((snapshot) => (
              <div className="activity-row" key={String(snapshot.id)}>
                <span className="activity-icon"><FileJson size={15} /></span>
                <div><strong>{String(snapshot.query_text)}</strong><span>{dateTime(String(snapshot.captured_at))}</span></div>
                <Badge tone={Number(snapshot.cited_domains_count) ? "success" : "neutral"}>{Number(snapshot.cited_domains_count)} cited</Badge>
              </div>
            )) : <EmptyState title="No snapshots" description="Add a query to begin monitoring." />}
          </div>
        </Card>
      </div>
    </div>
  );
}

interface QueryRow {
  id: string;
  project_id: string;
  query_text: string;
  location_code: number;
  language_code: string;
  schedule_cadence: "daily" | "weekly";
  schedule_time: string;
  schedule_timezone: string;
  is_active: number;
  next_run_at: string;
  last_snapshot_at: string | null;
  snapshot_count: number;
  latest_run_status: RunStatus | null;
}

export function QueriesPage() {
  const { projectId } = useApp();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const [locationCode, setLocationCode] = useState("2840");
  const [languageCode, setLanguageCode] = useState("en");
  const languageOptions = languagesForLocation(locationCode);
  const queries = useQuery({
    queryKey: ["queries", projectId],
    queryFn: () => api<QueryRow[]>(`/queries?projectId=${projectId}`),
    enabled: Boolean(projectId),
    refetchInterval: (current) =>
      current.state.data?.some((query) =>
        isRunInProgress(query.latest_run_status),
      )
        ? 3_000
        : false,
  });
  const createQuery = useMutation({
    mutationFn: (body: Record<string, unknown>) => post(`/projects/${projectId}/queries`, body),
    onSuccess: async () => {
      setDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["queries", projectId] });
    },
    onError: (value: Error) => setError(value.message),
  });
  const manualRun = useMutation({
    mutationFn: (queryId: string) => post(`/queries/${queryId}/runs`, { captureHtml: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["queries", projectId] }),
  });
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      patch(`/queries/${id}/status`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["queries", projectId] }),
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
      <PageHeader title="Tracked queries" description="Prompts monitored against ChatGPT web Search mode." action={
        <Button onClick={() => setDialogOpen(true)}><Plus size={16} /> Add query</Button>
      } />
      <Card>
        <CardHeader title={pluralize(queries.data?.length ?? 0, "query", "queries")} description="Schedules use each query’s configured timezone." />
        {queries.data?.length ? (
          <DataTable
            columns={[
              { key: "query", label: "Query" }, { key: "schedule", label: "Schedule" },
              { key: "status", label: "Status" }, { key: "last", label: "Last capture" },
              { key: "actions", label: "" },
            ]}
            rows={queries.data.map((query) => {
              const runInProgress = isRunInProgress(query.latest_run_status);
              const isStarting =
                manualRun.isPending && manualRun.variables === query.id;
              return {
                id: query.id,
                query: <Link className="primary-cell table-query-link" to={`/queries/${query.id}`}><strong>{query.query_text}</strong><span>{localeLabel(query.location_code, query.language_code)}</span></Link>,
                schedule: <div className="primary-cell"><strong className="capitalize">{query.schedule_cadence}</strong><span>{query.schedule_time} · {query.schedule_timezone}</span></div>,
                status: <button className="plain-button" onClick={() => toggle.mutate({ id: query.id, isActive: !query.is_active })}><Badge tone={query.is_active ? "success" : "neutral"}>{query.is_active ? "Active" : "Paused"}</Badge></button>,
                last: <div className="primary-cell"><strong>{dateTime(query.last_snapshot_at)}</strong><span>{runInProgress ? runStatusLabel(query.latest_run_status) : pluralize(query.snapshot_count, "snapshot")}</span></div>,
                actions: <Button variant="secondary" disabled={isStarting || runInProgress} onClick={() => manualRun.mutate(query.id)}><RefreshCw size={14} /> {isStarting ? "Queued…" : runStatusLabel(query.latest_run_status)}</Button>,
              };
            })}
          />
        ) : <EmptyState title="No tracked queries" description="Add the prompts your audience asks ChatGPT." action={<Button onClick={() => setDialogOpen(true)}><Plus size={15} /> Add query</Button>} />}
      </Card>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} title="Add tracked query" description="Schedule a web-grounded ChatGPT result capture.">
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
          <div className="dialog-actions"><Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button><Button disabled={createQuery.isPending}>{createQuery.isPending ? "Adding…" : "Add query"}</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
