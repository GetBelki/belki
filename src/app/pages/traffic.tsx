import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { NoProject, PageHeader } from "../components/layout";
import { Button, Card, CardContent, CardHeader, EmptyState, Input, Select } from "../components/ui";
import { useApp } from "../context";
import { api } from "../lib/api";
import { TRAFFIC_LABELS, TRAFFIC_SOURCES, type TrafficBreakdown, type TrafficConfig, type TrafficReport, type TrafficSettings, type TrafficSource } from "../../shared/traffic";
import "./traffic.css";

const sourceOptions = TRAFFIC_SOURCES.map((value) => ({ value, label: TRAFFIC_LABELS[value] }));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const percent = (part: number, total: number) => `${total ? (part / total * 100).toFixed(1) : "0"}%`;
const count = (n: number) => n.toLocaleString();

export function TrafficPage() {
  const { projectId } = useApp();
  return projectId ? <ProjectTraffic key={projectId} projectId={projectId} /> : <NoProject />;
}
function ProjectTraffic({ projectId }: { projectId: string }) {
  const { session, currentProject } = useApp();
  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [source, setSource] = useState("all");
  const [configure, setConfigure] = useState(false);
  const config = useQuery({ queryKey: ["traffic-config", projectId], queryFn: () => api<TrafficConfig>(`/traffic/${projectId}/config`), refetchInterval: 60000 });
  const report = useQuery({
    queryKey: ["traffic-report", projectId, from, to, source],
    queryFn: () => api<TrafficReport>(`/traffic/${projectId}/report?${new URLSearchParams({ from, to, ...(source === "all" ? {} : { source }) })}`),
    enabled: Boolean(from && to), refetchInterval: 60000,
  });
  const data = report.data;
  const editable = session.user.role !== "viewer" && session.workspace.status === "active";
  const daily = [];
  if (data && from && to && Date.parse(to) - Date.parse(from) <= 366 * 86400000) {
    const byDay = new Map(data.daily.map((day) => [day.label, day]));
    for (let day = Date.parse(from); day <= Date.parse(to); day += 86400000) {
      const label = isoDate(new Date(day));
      daily.push(byDay.get(label) ?? { label, sessions: 0, views: 0 });
    }
  }
  return <div className="page traffic-page">
    <PageHeader title="AI Traffic" description="Visits and conversions from AI-tagged links. Only recognized utm_source sessions are measured."
      action={<Button variant="secondary" onClick={() => setConfigure(!configure)}>{configure ? "View traffic" : "Installation & goals"}</Button>} />
    {config.error ? <p role="alert">{config.error.message}</p> : null}
    {config.isPending ? <p role="status">Loading installation settings…</p> : null}
    {config.data && (configure || !config.data.key) ? <TrafficSetup key={`${projectId}:${config.data.key ?? "new"}`} projectId={projectId}
      initial={config.data} domain={currentProject?.primary_domain ?? ""} editable={editable} /> : null}
    {config.data?.key && !configure ? <>
      {!config.data.enabled ? <p className="traffic-notice">Collection is disabled. Historical traffic remains available.</p> : null}
      <div className="traffic-filters">
        <label>From (UTC)<Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To (UTC)<Input type="date" value={to} min={from} max={isoDate(new Date())} onChange={(e) => setTo(e.target.value)} /></label>
        <label>AI source<Select ariaLabel="AI traffic source" value={source} onValueChange={setSource} options={[{ value: "all", label: "All AI sources" }, ...sourceOptions]} /></label>
      </div>
      {report.isPending ? <p role="status">Loading traffic…</p> : null}
      {report.error ? <p role="alert">{report.error.message}</p> : null}
      {data ? <>
        <div className="traffic-metrics">{[
          ["Sessions", count(data.summary.sessions)], ["Page views", count(data.summary.views)],
          ["Pages / session", data.summary.sessions ? (data.summary.views / data.summary.sessions).toFixed(1) : "0"],
          ["Visible time / session", `${data.summary.sessions ? Math.round(data.summary.visibleMs / data.summary.sessions / 1000) : 0}s`],
          ["Converted sessions", count(data.summary.converted)], ["Conversion rate", percent(data.summary.converted, data.summary.sessions)],
        ].map(([label, value]) => <Card key={label}><CardContent><span>{label}</span><strong>{value}</strong></CardContent></Card>)}</div>
        {!data.summary.sessions ? <EmptyState title="No attributed visits yet" description="Install the tag, enable collection, and visit an authorized domain with ?utm_source=chatgpt. Untagged traffic is not recorded." /> : <>
          <Card><CardHeader title="Daily traffic" description="Sessions and their page views, grouped by session start date in UTC." /><CardContent>
            <div className="traffic-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={daily} accessibilityLayer>
              <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tickFormatter={(v: string) => v.slice(5)} minTickGap={32} /><YAxis allowDecimals={false} />
              <Tooltip /><Line type="monotone" dataKey="sessions" name="Sessions" stroke="#1e73be" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="views" name="Page views" stroke="#8c62c4" dot={false} strokeWidth={2} />
            </LineChart></ResponsiveContainer></div>
          </CardContent></Card>
          <div className="traffic-tables">
            <Breakdown title="AI sources" rows={data.sources.map((r) => ({ ...r, label: TRAFFIC_LABELS[r.label as TrafficSource] ?? r.label }))} />
            <Breakdown title="Entry pages" rows={data.entries} />
            <Breakdown title="Visited pages" rows={data.pages} />
            <Breakdown title="Countries" rows={data.countries.map((r) => ({ ...r, label: r.label === "unknown" ? "Unknown" : new Intl.DisplayNames(["en"], { type: "region" }).of(r.label) ?? r.label }))} />
            <Breakdown title="Devices" rows={data.devices} />
            <Card><CardHeader title="Conversion goals" description="Each goal counts once per session. Historical goal names are preserved." /><CardContent>
              {data.goals.length ? <table className="traffic-table"><thead><tr><th>Goal</th><th>Sessions</th><th>Rate</th></tr></thead><tbody>{data.goals.map((goal, index) => <tr key={index}><td>{goal.label}</td><td>{count(goal.sessions)}</td><td>{percent(goal.sessions, data.summary.sessions)}</td></tr>)}</tbody></table> : <p>No goals completed in this period.</p>}
            </CardContent></Card>
          </div>
        </>}
        <p className="traffic-footnote">12 months of history · Anonymous sessions per tab · Visible time is approximate, not a measure of attention. Tables show the top 100 entries.</p>
      </> : null}
    </> : null}
  </div>;
}
function Breakdown({ title, rows }: { title: string; rows: TrafficBreakdown[] }) {
  return <Card><CardHeader title={title} /><CardContent><div className="traffic-table-scroll"><table className="traffic-table">
    <thead><tr><th>{title}</th><th>Sessions</th><th>Views</th><th>Conv. rate</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.label}><td>{row.label}</td><td>{count(row.sessions)}</td><td>{count(row.views)}</td><td>{percent(row.converted, row.sessions)}</td></tr>)}</tbody>
  </table></div></CardContent></Card>;
}
function TrafficSetup({ projectId, initial, domain, editable }: { projectId: string; initial: TrafficConfig; domain: string; editable: boolean }) {
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<TrafficSettings>({ enabled: initial.enabled, domains: initial.domains.length ? initial.domains : domain ? [domain] : [], aliases: initial.aliases, goals: initial.goals });
  const [domains, setDomains] = useState(settings.domains.join("\n"));
  const [copied, setCopied] = useState(false);
  const save = useMutation({ mutationFn: () => api<TrafficConfig>(`/traffic/${projectId}/config`, { method: "PUT", body: JSON.stringify({ ...settings, domains: domains.split(/[\n,]/).map((v) => v.trim()).filter(Boolean) }) }),
    onSuccess: (value) => { setSettings(value); queryClient.setQueryData(["traffic-config", projectId], value); } });
  const config = save.data ?? initial;
  const snippet = `<script async src="${window.location.origin}/api/traffic/v1.js" data-site="${config.key ?? "SAVE_TO_GENERATE_KEY"}"></script>`;
  return <Card><CardHeader title="Installation & goals" description="Install once on every page you want to measure. Subdomains must be listed explicitly." /><CardContent>
    <form className="traffic-setup" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <fieldset disabled={!editable || save.isPending}>
        <label className="traffic-enable"><input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} /> Enable traffic collection</label>
        <label>Authorized hostnames<textarea aria-label="Authorized hostnames" className="input" rows={3} placeholder="example.com&#10;www.example.com" value={domains} onChange={(e) => setDomains(e.target.value)} /></label>
        <h3>Source aliases</h3><p>Built-in names and domains for ChatGPT, Claude, Gemini, Perplexity, Copilot and Grok are included. Add your own utm_source values below.</p>
        {settings.aliases.map((alias, index) => <div className="traffic-edit-row" key={index}>
          <Input aria-label={`Alias ${index + 1}`} value={alias.alias} placeholder="my-chatgpt-campaign" onChange={(e) => setSettings({ ...settings, aliases: settings.aliases.map((v, i) => i === index ? { ...v, alias: e.target.value } : v) })} />
          <select aria-label={`Alias source ${index + 1}`} className="input" value={alias.source} onChange={(e) => setSettings({ ...settings, aliases: settings.aliases.map((v, i) => i === index ? { ...v, source: e.target.value as TrafficSource } : v) })}>{sourceOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          <Button type="button" variant="ghost" aria-label={`Remove alias ${index + 1}`} onClick={() => setSettings({ ...settings, aliases: settings.aliases.filter((_, i) => i !== index) })}>Remove</Button>
        </div>)}
        <Button type="button" variant="secondary" disabled={settings.aliases.length >= 50} onClick={() => setSettings({ ...settings, aliases: [...settings.aliases, { alias: "", source: "chatgpt" }] })}>Add alias</Button>
        <h3>Conversion goals</h3><p>Match an exact pathname, such as /thanks, or call <code>window.belki?.track('signup')</code> after a successful action. Events accept only a name.</p>
        {settings.goals.map((goal, index) => <div className="traffic-edit-row traffic-goal-row" key={goal.id}>
          <Input aria-label={`Goal name ${index + 1}`} value={goal.name} placeholder="Signup" onChange={(e) => setSettings({ ...settings, goals: settings.goals.map((g, i) => i === index ? { ...g, name: e.target.value } : g) })} />
          <select aria-label={`Goal type ${index + 1}`} className="input" value={goal.type} onChange={(e) => setSettings({ ...settings, goals: settings.goals.map((g, i) => i === index ? { ...g, type: e.target.value as "path" | "event" } : g) })}><option value="path">Page path</option><option value="event">JS event</option></select>
          <Input aria-label={`Goal value ${index + 1}`} value={goal.value} placeholder={goal.type === "path" ? "/thanks" : "signup"} onChange={(e) => setSettings({ ...settings, goals: settings.goals.map((g, i) => i === index ? { ...g, value: e.target.value } : g) })} />
          <Button type="button" variant="ghost" aria-label={`Remove goal ${index + 1}`} onClick={() => setSettings({ ...settings, goals: settings.goals.filter((_, i) => i !== index) })}>Remove</Button>
        </div>)}
        <Button type="button" variant="secondary" disabled={settings.goals.length >= 30} onClick={() => setSettings({ ...settings, goals: [...settings.goals, { id: crypto.randomUUID(), name: "", type: "path", value: "" }] })}>Add goal</Button>
        <div><Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save settings"}</Button></div>
      </fieldset>
      {save.error ? <p role="alert">{save.error.message}</p> : save.isSuccess ? <p role="status">Settings saved.</p> : null}
      {!editable ? <p>Editing requires an editor role and an active workspace.</p> : null}
    </form>
    {config.key ? <div className="traffic-install"><h3>Your installation tag</h3><pre><code>{snippet}</code></pre>
      <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(snippet).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "Copied" : "Copy tag"}</Button>
      <p>Last event: {initial.lastEvent ? new Date(initial.lastEvent).toLocaleString() : "Not received yet"}.</p>
      <p>Test an authorized page with <code>?utm_source=chatgpt</code>. Events appear within a minute. Untagged visits create no analytics events.</p>
      <p>Load this tag through your consent manager when needed. Allow this Belki origin in your site's script-src and connect-src policies. No visitor cookies or persistent visitor IDs are used.</p>
    </div> : null}
  </CardContent></Card>;
}
