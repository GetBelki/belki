import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
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
import { NoProject, PageHeader } from "../components/layout";
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
} from "../components/ui";
import { useApp } from "../context";
import { api, patch, post, type Project } from "../lib/api";
import { compact, dateTime, formText, percent, pluralize } from "../lib/utils";

function useProjectAnalytics<T>(name: string) {
  const { projectId } = useApp();
  return useQuery({
    queryKey: [name, projectId],
    queryFn: () => api<T>(`/analytics/${name}?projectId=${projectId}`),
    enabled: Boolean(projectId),
    refetchOnMount: "always",
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
        {query.data?.length ? <DataTable columns={[
          { key: "domain", label: "Domain" }, { key: "cited", label: "Cited snapshots" },
          { key: "citations", label: "Citations" }, { key: "retrieved", label: "Retrieved" },
          { key: "products", label: "Products" },
        ]} rows={query.data.map((domain) => ({
          id: domain.domain,
          domain: <div className="domain-cell"><span><Globe2 size={15}/></span><strong>{domain.domain}</strong></div>,
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

export function CitationSourcesPage() {
  const { projectId } = useApp();
  const query =
    useProjectAnalytics<CitationSourceRow[]>("citation-sources");
  if (!projectId) return <NoProject />;
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
        />
        {query.data?.length ? (
          <DataTable
            columns={[
              { key: "domain", label: "Domain" },
              { key: "rate", label: "Citation rate" },
              { key: "urls", label: "Total URLs" },
              { key: "citations", label: "Total citations" },
            ]}
            rows={query.data.map((source) => ({
              id: source.domain,
              domain: (
                <div className="domain-cell">
                  <span><Globe2 size={15} /></span>
                  <strong>{source.domain}</strong>
                </div>
              ),
              rate: <strong>{percent(source.citationRate)}</strong>,
              urls: compact(source.totalUrls),
              citations: compact(source.totalCitations),
            }))}
          />
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
        {query.data?.length ? query.data.map((brand) => (
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
        {query.data?.length ? query.data.map((product) => {
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
  appearances: number;
  latestSeen: string;
}

export function ShoppingPage() {
  const { projectId } = useApp();
  const query = useProjectAnalytics<ShoppingRow[]>("shopping");
  if (!projectId) return <NoProject />;
  return (
    <div className="page">
      <PageHeader
        eyebrow="Last 30 days"
        title="Shopping"
        description="Deduplicated products surfaced in captured shopping blocks."
      />
      <Card>
        <CardHeader
          title={pluralize(query.data?.length ?? 0, "product")}
          description="The latest product details are shown; appearances count every captured occurrence."
        />
        {query.data?.length ? (
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
            rows={query.data.map((product) => {
              const href = product.canonical_url ?? product.raw_url;
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
                action: href ? (
                  <Button asChild variant="secondary">
                    <a href={href} target="_blank" rel="noreferrer">
                      Open <ExternalLink size={13} />
                    </a>
                  </Button>
                ) : null,
              };
            })}
          />
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
