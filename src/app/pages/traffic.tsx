import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { NoProject, PageHeader } from "../components/layout";
import { Button, Card, CardContent, CardHeader, Dialog, EmptyState, Input, Select } from "../components/ui";
import { useApp } from "../context";
import { api } from "../lib/api";
import { TRAFFIC_LABELS, TRAFFIC_SOURCES, trafficSnippet, type TrafficTestResult, type TrafficBreakdown, type TrafficConfig, type TrafficReport, type TrafficSettings, type TrafficSource } from "../../shared/traffic";
import "./traffic.css";

type TrafficTab = "summary" | "installation" | "conversions" | "sources";
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
  const [selectedTab, setSelectedTab] = useState<TrafficTab>("summary");
  const config = useQuery({ queryKey: ["traffic-config", projectId], queryFn: () => api<TrafficConfig>(`/traffic/${projectId}/config`), refetchInterval: 60000 });
  const report = useQuery({
    queryKey: ["traffic-report", projectId, from, to, source],
    queryFn: () => api<TrafficReport>(`/traffic/${projectId}/report?${new URLSearchParams({ from, to, ...(source === "all" ? {} : { source }) })}`),
    enabled: Boolean(from && to), refetchInterval: 60000,
  });
  const tab = !config.data?.key && selectedTab === "summary" ? "installation" : selectedTab;
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
    <PageHeader title="AI Analytics" description="Understand visits and conversions from AI sources." />
    <nav className="traffic-tabs" aria-label="AI Analytics sections">
      {([["summary", "Overview"], ["installation", "Installation"], ["conversions", "Conversions"], ["sources", "Sources"]] as const).map(([value, label]) =>
        <Button key={value} variant={tab === value ? "default" : "ghost"} aria-pressed={tab === value} onClick={() => setSelectedTab(value)}>{label}</Button>)}
    </nav>
    {config.error ? <p role="alert">{config.error.message}</p> : null}
    {config.isPending ? <p role="status">Loading installation settings…</p> : null}
    {config.data ? <div hidden={tab === "summary"}><TrafficSetup section={tab} key={`${projectId}:${config.data.key ?? "new"}`} projectId={projectId}
      initial={config.data} domain={currentProject?.primary_domain ?? ""} editable={editable} /></div> : null}
    {config.data?.key && tab === "summary" ? <>
      {!config.data.enabled ? <p className="traffic-notice">Collection is disabled. Historical traffic remains available.</p> : null}
      <div className="traffic-filters">
        <TrafficDateRange from={from} to={to} onChange={(range) => { setFrom(range.from); setTo(range.to); }} />
        <label className="traffic-source-filter">AI source<Select ariaLabel="AI traffic source" value={source} onValueChange={setSource} options={[{ value: "all", label: "All AI sources" }, ...sourceOptions]} /></label>
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
        {!data.summary.sessions ? <div className="traffic-empty"><EmptyState title="No visits for these filters" description="Try another date range or AI source. To verify collection, check your tag installation and test an AI-tagged visit." action={<Button variant="secondary" onClick={() => setSelectedTab("installation")}>Check installation</Button>} /></div> : <>
          <Card><CardHeader title="Daily traffic" description="Sessions and their page views, grouped by session start date in UTC." /><CardContent>
            <div className="traffic-chart-legend" aria-label="Chart legend"><span><i className="traffic-legend-sessions" />Sessions</span><span><i className="traffic-legend-views" />Page views</span></div>
            <div className="traffic-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={daily} accessibilityLayer>
              <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tickFormatter={(v: string) => v.slice(5)} minTickGap={32} /><YAxis allowDecimals={false} width={40} />
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
function TrafficDateRange({ from, to, onChange }: { from: string; to: string; onChange: (range: { from: string; to: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const today = isoDate(new Date());
  const format = (value: string, year: boolean) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", ...(year ? { year: "numeric" } as const : {}), timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
  const includeYear = from.slice(0, 4) !== to.slice(0, 4);
  const rangeTooLong = Date.parse(draftTo) - Date.parse(draftFrom) > 366 * 86400000;
  const apply = (nextFrom: string, nextTo: string) => { onChange({ from: nextFrom, to: nextTo }); setOpen(false); };
  return <div className="traffic-date-range">
    <span id="traffic-date-range-label">Date range (UTC)</span>
    <Dialog title="Date range" description="Choose a preset or enter custom dates. Reports use UTC." contentClassName="traffic-date-dialog" open={open}
      onOpenChange={(value) => { if (value) { setDraftFrom(from); setDraftTo(to); } setOpen(value); }}
      trigger={<Button variant="secondary" className="traffic-date-trigger" aria-labelledby="traffic-date-range-label traffic-date-range-value">
        <span id="traffic-date-range-value" title={`${format(from, true)} – ${format(to, true)}`}>{format(from, includeYear)} – {format(to, includeYear)}</span><ChevronDown size={15} aria-hidden="true" />
      </Button>}>
      <div className="traffic-date-presets" aria-label="Quick date ranges">
        {[7, 30, 90].map((days) => <Button key={days} variant="secondary" onClick={() => apply(isoDate(new Date(Date.parse(today) - (days - 1) * 86400000)), today)}>Last {days} days</Button>)}
      </div>
      <form className="traffic-date-form" onSubmit={(event) => { event.preventDefault(); if (!rangeTooLong) apply(draftFrom, draftTo); }}>
        <label>From (UTC)<Input type="date" required value={draftFrom} max={draftTo || today} onChange={(event) => setDraftFrom(event.target.value)} /></label>
        <label>To (UTC)<Input type="date" required value={draftTo} min={draftFrom} max={today} onChange={(event) => setDraftTo(event.target.value)} /></label>
        {rangeTooLong ? <p role="alert">Choose a range of no more than 12 months.</p> : null}
        <div className="traffic-date-actions"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={!draftFrom || !draftTo || rangeTooLong}>Apply dates</Button></div>
      </form>
    </Dialog>
  </div>;
}
function Breakdown({ title, rows }: { title: string; rows: TrafficBreakdown[] }) {
  return <Card><CardHeader title={title} /><CardContent><div className="traffic-table-scroll"><table className="traffic-table">
    <thead><tr><th>{title}</th><th>Sessions</th><th>Views</th><th>Conv. rate</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.label}><td>{row.label}</td><td>{count(row.sessions)}</td><td>{count(row.views)}</td><td>{percent(row.converted, row.sessions)}</td></tr>)}</tbody>
  </table></div></CardContent></Card>;
}
function TrafficSetup({ projectId, initial, domain, editable, section }: { projectId: string; initial: TrafficConfig; domain: string; editable: boolean; section: TrafficTab }) {
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<TrafficSettings>({ enabled: initial.enabled, domains: initial.domains.length ? initial.domains : domain ? [domain] : [], aliases: initial.aliases, goals: initial.goals });
  const [domains, setDomains] = useState(settings.domains.join("\n"));
  const [copied, setCopied] = useState(false);
  const save = useMutation({ mutationFn: () => api<TrafficConfig>(`/traffic/${projectId}/config`, { method: "PUT", body: JSON.stringify({ ...settings, domains: domains.split(/[\n,]/).map((v) => v.trim()).filter(Boolean) }) }),
    onSuccess: (value) => { setSettings({ enabled: value.enabled, domains: value.domains, aliases: value.aliases, goals: value.goals }); queryClient.setQueryData(["traffic-config", projectId], value); } });
  const config = save.data ?? initial;
  const snippet = trafficSnippet(config.installation, config.key ?? "SAVE_TO_GENERATE_KEY");
  return <Card><CardHeader title={section === "conversions" ? "Conversion goals" : section === "sources" ? "AI sources" : "Install Belki Analytics"} description={section === "conversions" ? "Count a successful action or arrival at a specific page. Each goal counts once per session." : section === "sources" ? "Attribute visits using recognized utm_source values." : "Add the tag once to your site’s global template. Include every hostname you want to measure."} /><CardContent>
    <form className="traffic-setup" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <fieldset disabled={!editable || save.isPending}>
        <div className="traffic-section" hidden={section !== "installation"}>
        <label className="traffic-enable"><input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} /> Enable traffic collection</label>
        <label>Authorized hostnames<textarea aria-label="Authorized hostnames" aria-describedby="traffic-hostnames-hint" className="input" rows={3} placeholder="example.com&#10;www.example.com" value={domains} onChange={(e) => setDomains(e.target.value)} /></label>
        <p className="traffic-field-hint" id="traffic-hostnames-hint">One hostname per line or separated by commas. Include each subdomain, without https:// or a path.</p>
        </div>
        <div className="traffic-section" hidden={section !== "sources"}>
        <h3>Source aliases</h3><p>Built-in names and domains for ChatGPT, Claude, Gemini, Perplexity, Copilot and Grok are included. Add your own utm_source values below.</p>
        {settings.aliases.map((alias, index) => <div className="traffic-edit-row" key={index}>
          <label>UTM source<Input aria-label={`Alias ${index + 1}`} value={alias.alias} placeholder="my-chatgpt-campaign" onChange={(e) => setSettings({ ...settings, aliases: settings.aliases.map((v, i) => i === index ? { ...v, alias: e.target.value } : v) })} /></label>
          <label>AI source<select aria-label={`Alias source ${index + 1}`} className="input" value={alias.source} onChange={(e) => setSettings({ ...settings, aliases: settings.aliases.map((v, i) => i === index ? { ...v, source: e.target.value as TrafficSource } : v) })}>{sourceOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          <Button type="button" variant="ghost" aria-label={`Remove alias ${index + 1}`} onClick={() => setSettings({ ...settings, aliases: settings.aliases.filter((_, i) => i !== index) })}>Remove</Button>
        </div>)}
        <Button type="button" variant="secondary" disabled={settings.aliases.length >= 50} onClick={() => setSettings({ ...settings, aliases: [...settings.aliases, { alias: "", source: "chatgpt" }] })}>Add alias</Button>
        </div>
        <div className="traffic-section" hidden={section !== "conversions"}>
        <p>Use an exact page path such as <code>/thanks</code>, or send a JavaScript event after your application confirms success. Visiting a page does not prove a purchase or registration completed.</p>
        {settings.goals.map((goal, index) => <div className="traffic-goal" key={goal.id}><div className="traffic-edit-row traffic-goal-row">
          <label>Goal name<Input aria-label={`Goal name ${index + 1}`} value={goal.name} placeholder="Signup" onChange={(e) => setSettings({ ...settings, goals: settings.goals.map((g, i) => i === index ? { ...g, name: e.target.value } : g) })} /></label>
          <label>Track by<select aria-label={`Goal type ${index + 1}`} className="input" value={goal.type} onChange={(e) => setSettings({ ...settings, goals: settings.goals.map((g, i) => i === index ? { ...g, type: e.target.value as "path" | "event" } : g) })}><option value="path">Page visit</option><option value="event">JavaScript event</option></select></label>
          <label>{goal.type === "path" ? "Page path" : "Event name"}<Input aria-label={`Goal value ${index + 1}`} value={goal.value} placeholder={goal.type === "path" ? "/thanks" : "signup_completed"} onChange={(e) => setSettings({ ...settings, goals: settings.goals.map((g, i) => i === index ? { ...g, value: e.target.value } : g) })} /></label>
          <Button type="button" variant="ghost" aria-label={`Remove goal ${index + 1}`} onClick={() => setSettings({ ...settings, goals: settings.goals.filter((_, i) => i !== index) })}>Remove</Button>
        </div>
          {goal.type === "event" ? <div className="traffic-goal-code"><code>{`window.belki.track(${JSON.stringify(goal.value || "signup_completed")});`}</code>
            <Button type="button" variant="ghost" onClick={() => { void navigator.clipboard.writeText(`window.belki.track(${JSON.stringify(goal.value || "signup_completed")});`); }}>Copy event</Button></div>
            : <p>Matches only <code>{goal.value || "/thanks"}</code>. Query parameters and fragments are ignored; trailing slashes must match.</p>}
        </div>)}
        <Button type="button" variant="secondary" disabled={settings.goals.length >= 30} onClick={() => setSettings({ ...settings, goals: [...settings.goals, { id: crypto.randomUUID(), name: "", type: "path", value: "" }] })}>Add goal</Button>
        </div>
        <div className="traffic-save"><Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save settings"}</Button></div>
      </fieldset>
      {save.error ? <p role="alert">{save.error.message}</p> : save.isSuccess ? <p role="status">Settings saved.</p> : null}
      {!editable ? <p>Editing requires an editor role and an active workspace.</p> : null}
    </form>
    {config.key && section === "installation" ? <div className="traffic-install"><h3>Your installation tag</h3><p>Paste both script blocks inside &lt;head&gt;, before &lt;/head&gt;, in your shared layout so they load on every page. Keep them in this order.</p><pre tabIndex={0} aria-label="Installation tag"><code>{snippet}</code></pre>
      <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(snippet).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "Copied" : "Copy tag"}</Button>
      <p>Last real event: {initial.lastEvent ? new Date(initial.lastEvent).toLocaleString() : "Not received yet"}.</p>
      <p>{config.enabled ? "Collection is active for recognized AI sources." : "Real traffic collection is off. You can verify the installation before enabling it."} Untagged visits create no analytics events.</p>
      <TrafficInstallationTest projectId={projectId} domain={config.domains[0] ?? domain} editable={editable} />
      <p>Load this tag through your consent manager when needed. Allow the script’s origin in script-src and the analytics service in connect-src. The inline queue initializer also needs your CSP nonce or hash. No visitor cookies or persistent visitor IDs are used.</p>
    </div> : null}
  </CardContent></Card>;
}
function TrafficInstallationTest({ projectId, domain, editable }: { projectId: string; domain: string; editable: boolean }) {
  const [url, setUrl] = useState(`https://${domain}/`);
  const start = useMutation({ mutationFn: () => api<{ url: string; expiresAt: number }>(`/traffic/${projectId}/test`, { method: "POST", body: JSON.stringify({ url }) }) });
  const status = useQuery({ queryKey: ["traffic-test", projectId, start.data?.expiresAt], queryFn: () => api<TrafficTestResult | null>(`/traffic/${projectId}/test`), enabled: Boolean(start.data), refetchInterval: () => start.data && start.data.expiresAt > Date.now() ? 3000 : false });
  const result = status.data?.result;
  return <div className="traffic-test">
    <h3>Check your installation</h3>
    <p>Open a temporary test session on your site, then navigate or complete a goal. Test events stay out of your reports and expire after 10 minutes.</p>
    <label>Page to test<Input aria-label="Page to test" type="url" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
    <Button variant="secondary" disabled={!editable || start.isPending} onClick={() => start.mutate()}>{start.isPending ? "Preparing test…" : "Create test link"}</Button>
    {start.error ? <p role="alert">{start.error.message}</p> : null}
    {start.data ? <>
      <a href={start.data.url} target="_blank" rel="noreferrer">Open test page ↗</a>
      <p role="status">{status.isSuccess && status.data === null ? "Test expired. Create a new link to continue." : result ? `Page received: ${result.path}` : "Waiting for a test event. No signal yet does not necessarily mean the tag is missing."}</p>
      {result?.event ? <p>Event received: <code>{result.event}</code></p> : null}
      {result?.goals.length ? <p>Goals matched: {result.goals.join(", ")}</p> : null}
      {status.error ? <p role="alert">{status.error.message}</p> : null}
    </> : null}
  </div>;
}
