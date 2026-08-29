import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ArchiveRestore,
  KeyRound,
  Pencil,
  Plus,
  ServerCog,
  Webhook,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { NoProject, PageHeader } from "../components/layout";
import { DomainFavicon } from "../components/domain-favicon";
import { TrackingSourceMark } from "../components/tracking-source-mark";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Switch,
} from "../components/ui";
import { useApp } from "../context";
import { api, patch, post, type Project, type Session } from "../lib/api";
import { compact, formText, pluralize } from "../lib/utils";
import {
  TRACKING_SOURCE_DESCRIPTIONS,
  TRACKING_SOURCE_LABELS,
  TRACKING_SOURCES,
  type TrackingSource,
} from "../../shared/tracking-sources";

type SettingsView = "project" | "workspace" | "diagnostics";

interface ProjectSettings {
  id: string;
  name: string;
  primaryDomain: string | null;
  htmlCaptureEnabled: boolean;
  productEnrichmentEnabled: boolean;
  entityExtractionEnabled: boolean;
  entityAutoTrackEnabled: boolean;
  rawRetentionDays: number;
  htmlRetentionDays: number;
  trackingSources: TrackingSource[];
  availableTrackingSources: TrackingSource[];
  allowedTrackingSources: TrackingSource[];
  trackingSourceLimit: number;
}

interface WebhookDestination {
  id: string;
  name: string;
  url: string;
  is_enabled: number;
}

interface ArchivedProject {
  id: string;
  name: string;
  primary_domain: string | null;
  archived_at: string;
}

interface HealthSummary {
  provider?: {
    dataForSeo?: { configured: boolean; source: string; account: string };
    payments?: {
      configured: boolean;
      mode: string;
      provider: string | null;
      providerLabel: string | null;
      environment: "test" | "live" | null;
      source: string | null;
    };
    email?: { configured: boolean; source: string };
  };
  publicOrigin?: { configured: string | null; stored: string | null };
}

export default function SettingsPage() {
  const { projects, projectId, session, currentProject } = useApp();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get("view");
  const view: SettingsView = requestedView === "workspace" || requestedView === "diagnostics"
    ? requestedView
    : "project";
  const [projectOpen, setProjectOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [webhookOpen, setWebhookOpen] = useState(false);
  const [webhookSecret, setWebhookSecret] = useState("");
  const canAdmin = session.user.role === "owner" || session.user.role === "admin";
  const canEditProject = session.user.role !== "viewer";

  const projectSettings = useQuery({
    queryKey: ["project-settings", projectId],
    queryFn: () => api<ProjectSettings>(`/projects/${projectId}/settings`),
    enabled: Boolean(projectId),
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api<HealthSummary>("/settings/health"),
    enabled: canAdmin && view === "diagnostics",
  });
  const webhooks = useQuery({
    queryKey: ["webhook-destinations"],
    queryFn: () => api<WebhookDestination[]>("/webhook-destinations"),
    enabled: canAdmin && view === "workspace",
  });
  const archivedProjects = useQuery({
    queryKey: ["archived-projects"],
    queryFn: () => api<ArchivedProject[]>("/projects/archived"),
    enabled: canAdmin && view === "workspace",
  });
  const updateFeatures = useMutation({
    mutationFn: (body: Partial<Pick<ProjectSettings,
      "htmlCaptureEnabled" |
      "productEnrichmentEnabled" |
      "entityExtractionEnabled" |
      "entityAutoTrackEnabled"
    >>) => patch(`/projects/${projectId}/settings`, body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-settings", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["shopping-product"] }),
        queryClient.invalidateQueries({ queryKey: ["entities"] }),
      ]);
    },
  });
  const updateTrackingSources = useMutation({
    mutationFn: (sources: TrackingSource[]) =>
      patch<{ id: string; trackingSources: TrackingSource[] }>(
        `/projects/${projectId}/tracking-sources`,
        { sources },
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-settings", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["analytics"] }),
      ]);
    },
  });
  const createProject = useMutation({
    mutationFn: (body: Record<string, unknown>) => post("/projects", body),
    onSuccess: async () => {
      setProjectOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const updateProject = useMutation({
    mutationFn: ({ id, body }: {
      id: string;
      body: { name: string; primaryDomain: string | null };
    }) => patch(`/projects/${id}`, body),
    onSuccess: async () => {
      setEditingProject(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project-settings"] }),
      ]);
    },
  });
  const updateWorkspace = useMutation({
    mutationFn: (body: { name: string; publicBaseUrl?: string }) =>
      patch<{ id: string; name: string; publicBaseUrl: string }>("/settings/workspace", body),
    onSuccess: (workspace) => {
      queryClient.setQueryData<Session>(["session"], (current) => current
        ? { ...current, workspaceId: workspace.id, workspace: { ...current.workspace, ...workspace } }
        : current);
      setWorkspaceOpen(false);
    },
  });
  const restoreProject = useMutation({
    mutationFn: (id: string) => patch(`/projects/${id}/restore`, {}),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["archived-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["managed-billing-summary"] }),
      ]);
    },
  });
  const createWebhook = useMutation({
    mutationFn: (body: Record<string, string>) =>
      post<{ signingSecret: string }>("/webhook-destinations", body),
    onSuccess: async (value) => {
      setWebhookSecret(value.signingSecret);
      await queryClient.invalidateQueries({ queryKey: ["webhook-destinations"] });
    },
  });

  const projectSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    createProject.mutate({
      name: data.get("name"),
      primaryDomain: data.get("primaryDomain") || null,
      ownedBrandName: data.get("brand"),
      ownedBrandAliases: [],
      competitorBrands: [],
      htmlCaptureEnabled: false,
    });
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
      },
    });
  };
  const workspaceUpdateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    updateWorkspace.mutate({
      name: formText(data, "name"),
      ...(!session.capabilities.publicOriginManaged
        ? { publicBaseUrl: formText(data, "publicBaseUrl") }
        : {}),
    });
  };
  const webhookSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    createWebhook.mutate({ name: formText(data, "name"), url: formText(data, "url") });
  };
  const changeView = (nextView: SettingsView) => {
    setSearchParams(nextView === "project" ? {} : { view: nextView }, { replace: true });
  };
  const featureRows = projectSettings.data ? [
    {
      key: "htmlCaptureEnabled" as const,
      title: "Retain original ChatGPT pages",
      description: `Store the original ChatGPT result page for ${projectSettings.data.htmlRetentionDays} days.`,
      note: "Scheduled retention uses normal-priority collection and does not by itself increase the provider task price. Other AI platforms are unaffected.",
      checked: projectSettings.data.htmlCaptureEnabled,
      disabled: !canAdmin,
    },
    {
      key: "productEnrichmentEnabled" as const,
      title: "Google Shopping enrichment",
      description: "Refresh product, seller, availability, and market data for eligible Shopping results.",
      note: null,
      checked: projectSettings.data.productEnrichmentEnabled,
      disabled: !canAdmin,
    },
    {
      key: "entityExtractionEnabled" as const,
      title: "Named entity extraction",
      description: "Discover brands, companies, people, and places in captured responses.",
      note: null,
      checked: projectSettings.data.entityExtractionEnabled,
      disabled: !canAdmin,
    },
    {
      key: "entityAutoTrackEnabled" as const,
      title: "Auto-track high-confidence competitors",
      description: "Promote repeatedly corroborated competitor brands into visibility tracking.",
      note: null,
      checked: projectSettings.data.entityAutoTrackEnabled,
      disabled: !canAdmin || !projectSettings.data.entityExtractionEnabled,
    },
  ] : [];

  return (
    <div className="page settings-page page-flow">
      <PageHeader
        title="Settings"
        description={view === "project" && currentProject
          ? `Configure capture and analysis for ${currentProject.name}.`
          : "Manage shared workspace services and installation health."}
      />
      <div className="settings-tabs" role="tablist" aria-label="Settings scope">
        {(["project", "workspace", "diagnostics"] as const).map((tab) => (
          <button
            aria-selected={view === tab}
            className={view === tab ? "active" : undefined}
            key={tab}
            onClick={() => changeView(tab)}
            role="tab"
            type="button"
          >
            {tab === "project" ? "Project" : tab === "workspace" ? "Workspace" : "Diagnostics"}
          </button>
        ))}
      </div>

      {view === "project" ? (
        !projectId ? <NoProject /> : (
          <div className="settings-surface" role="tabpanel">
            <section className="settings-section">
              <div className="settings-section-heading">
                <div><h2>Project details</h2><p>The selected project controls all settings below.</p></div>
                {canEditProject && currentProject ? (
                  <Button variant="secondary" onClick={() => setEditingProject(currentProject)}>
                    <Pencil size={14}/> Edit
                  </Button>
                ) : null}
              </div>
              <div className="settings-project-summary">
                <DomainFavicon domain={projectSettings.data?.primaryDomain ?? null} size={22} />
                <div>
                  <strong>{projectSettings.data?.name ?? currentProject?.name}</strong>
                  <span>{projectSettings.data?.primaryDomain ?? "No primary domain"}</span>
                </div>
                <Badge tone="info">Selected project</Badge>
              </div>
            </section>
            <section className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <h2>AI platforms</h2>
                  <p>Choose where Belki monitors your prompts, answers, and citations.</p>
                </div>
                {projectSettings.data ? (
                  <span className="tracking-source-count">
                    {projectSettings.data.trackingSources.length} of {projectSettings.data.trackingSourceLimit} active
                  </span>
                ) : null}
              </div>
              {projectSettings.isPending ? (
                <Skeleton className="settings-feature-skeleton" />
              ) : projectSettings.data ? (
                <div className="tracking-source-list">
                  {TRACKING_SOURCES.map((source) => {
                    const selected = projectSettings.data.trackingSources.includes(source);
                    const allowed = projectSettings.data.allowedTrackingSources.includes(source);
                    const deployed = projectSettings.data.availableTrackingSources.includes(source);
                    const atLimit = !selected && projectSettings.data.trackingSources.length >= projectSettings.data.trackingSourceLimit;
                    const status = selected
                      ? "Active"
                      : !deployed
                        ? "Coming soon"
                        : !allowed
                          ? "Upgrade"
                          : atLimit
                            ? "Limit reached"
                            : "Available";
                    const provider = source === "chatgpt" ? "OpenAI" : "Google";
                    return (
                      <div className={`tracking-source-row${selected ? " is-selected" : ""}`} key={source}>
                        <div className={`tracking-source-mark tracking-source-mark-${source}`}>
                          <TrackingSourceMark source={source} />
                        </div>
                        <div className="tracking-source-copy">
                          <div className="tracking-source-title">
                            <strong>{TRACKING_SOURCE_LABELS[source]}</strong>
                            <span className={`tracking-source-status tracking-source-status-${status.toLowerCase().replace(" ", "-")}`}>
                              {status}
                            </span>
                          </div>
                          <span><span className="tracking-source-provider">{provider}</span> · {TRACKING_SOURCE_DESCRIPTIONS[source]}</span>
                        </div>
                        <div className="tracking-source-control">
                          <Switch
                            ariaLabel={`${selected ? "Disable" : "Enable"} ${TRACKING_SOURCE_LABELS[source]}`}
                            checked={selected}
                            disabled={!canAdmin || !deployed || (!selected && !allowed) || atLimit || updateTrackingSources.isPending || (selected && projectSettings.data.trackingSources.length === 1)}
                            onCheckedChange={(checked) => {
                              const next = checked
                                ? [...projectSettings.data.trackingSources, source]
                                : projectSettings.data.trackingSources.filter((item) => item !== source);
                              updateTrackingSources.mutate(next);
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <p className="tracking-source-footnote">
                Each active platform runs your enabled prompts independently.
              </p>
              {updateTrackingSources.isError ? <p className="form-error">{updateTrackingSources.error.message}</p> : null}
            </section>
            <section className="settings-section">
              <div className="settings-section-heading">
                <div><h2>Features</h2><p>Paid and analytical workloads apply only to this project.</p></div>
              </div>
              {projectSettings.isPending ? (
                <Skeleton className="settings-feature-skeleton" />
              ) : projectSettings.isError ? (
                <p className="form-error">Project settings could not be loaded.</p>
              ) : (
                <div className="settings-feature-list">
                  {featureRows.map((feature) => (
                    <div className="settings-feature-row" key={feature.key}>
                      <div>
                        <strong>{feature.title}</strong>
                        <span>{feature.description}</span>
                        {feature.note ? <span className="settings-feature-cost-note">{feature.note}</span> : null}
                      </div>
                      <Switch
                        ariaLabel={feature.title}
                        checked={feature.checked}
                        disabled={feature.disabled || updateFeatures.isPending}
                        onCheckedChange={(checked) => updateFeatures.mutate({ [feature.key]: checked })}
                      />
                    </div>
                  ))}
                </div>
              )}
              {updateFeatures.isError ? (
                <p className="form-error">The feature setting could not be saved. Try again.</p>
              ) : null}
            </section>
            <section className="settings-section settings-retention-line">
              <div>
                <h2>Retention</h2>
                <p>
                  Raw normalized results are retained for {projectSettings.data?.rawRetentionDays ?? 730} days.
                  Original ChatGPT page HTML is retained for {projectSettings.data?.htmlRetentionDays ?? 90} days when enabled. Scheduled retention remains on normal-priority collection.
                </p>
              </div>
            </section>
          </div>
        )
      ) : null}

      {view === "workspace" ? (
        <div className="settings-surface" role="tabpanel">
          <section className="settings-section">
            <div className="settings-section-heading">
              <div><h2>Workspace details</h2><p>This name appears in invitations and identifies the workspace throughout Belki.</p></div>
              {session.user.role === "owner" ? <Button variant="secondary" onClick={() => { updateWorkspace.reset(); setWorkspaceOpen(true); }}><Pencil size={14}/> Edit</Button> : null}
            </div>
            <div className="settings-workspace-summary">
              <span>Name</span>
              <strong>{session.workspace.name}</strong>
              <span>Public application URL</span>
              <strong>{session.workspace.publicBaseUrl}</strong>
              <span>URL source</span>
              <strong>{session.capabilities.publicOriginManaged ? "Deployment configuration" : "Workspace setting"}</strong>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-heading">
              <div><h2>Projects</h2><p>{pluralize(projects.length, "project")} in this workspace.</p></div>
              {canEditProject ? <Button onClick={() => setProjectOpen(true)}><Plus size={15}/> New project</Button> : null}
            </div>
            {projects.length ? (
              <DataTable
                columns={[
                  {key:"project",label:"Project"},
                  {key:"prompts",label:"Prompts"},
                  {key:"status",label:"Status"},
                  {key:"action",label:""},
                ]}
                rows={projects.map((project) => ({
                  id: project.id,
                  project: <div className="domain-cell"><DomainFavicon domain={project.primary_domain} size={18}/><div className="primary-cell"><strong>{project.name}</strong><span>{project.primary_domain ?? "No primary domain"}</span></div></div>,
                  prompts: compact(project.query_count),
                  status: project.id === projectId ? <Badge tone="info">Selected</Badge> : <Badge>Available</Badge>,
                  action: canEditProject ? <Button className="settings-edit-button" variant="secondary" onClick={() => setEditingProject(project)}><Pencil size={13}/> Edit</Button> : null,
                }))}
              />
            ) : <EmptyState title="No projects" description="Create a project to start monitoring a brand." />}
          </section>
          {canAdmin && (archivedProjects.data?.length ?? 0) > 0 ? (
            <section className="settings-section">
              <div className="settings-section-heading">
                <div><h2>Archived projects</h2><p>History is preserved. Restore a project when your current plan has space.</p></div>
              </div>
              <DataTable
                columns={[
                  { key: "project", label: "Project" },
                  { key: "archived", label: "Archived" },
                  { key: "action", label: "" },
                ]}
                rows={(archivedProjects.data ?? []).map((project) => ({
                  id: project.id,
                  project: <div className="domain-cell"><DomainFavicon domain={project.primary_domain} size={18}/><strong>{project.name}</strong></div>,
                  archived: new Date(project.archived_at).toLocaleDateString(),
                  action: <Button disabled={restoreProject.isPending} onClick={() => restoreProject.mutate(project.id)} variant="secondary"><ArchiveRestore size={14}/> Restore</Button>,
                }))}
              />
              {restoreProject.isError ? <p className="form-error">{restoreProject.error.message}</p> : null}
            </section>
          ) : null}
          <section className="settings-section">
            <div className="settings-section-heading">
              <div><h2>Webhook delivery</h2><p>Workspace-wide signed alert destinations.</p></div>
              {canAdmin ? <Button variant="secondary" onClick={() => {setWebhookSecret("");setWebhookOpen(true);}}><Webhook size={14}/> Add destination</Button> : null}
            </div>
            {!canAdmin ? (
              <p className="muted">Administrator access is required.</p>
            ) : webhooks.isPending ? (
              <Skeleton className="settings-feature-skeleton" />
            ) : webhooks.data?.length ? (
              <div className="settings-webhook-list">
                {webhooks.data.map((webhook) => (
                  <div key={webhook.id}>
                    <div><strong>{webhook.name}</strong><span>{webhook.url}</span></div>
                    <Badge tone={webhook.is_enabled ? "success" : "neutral"}>{webhook.is_enabled ? "Active" : "Paused"}</Badge>
                  </div>
                ))}
              </div>
            ) : <p className="muted">No webhook destinations configured.</p>}
          </section>
        </div>
      ) : null}

      {view === "diagnostics" ? (
        <div className="settings-surface" role="tabpanel">
          <section className="settings-section">
            <div className="settings-section-heading"><div><h2>Provider & infrastructure</h2><p>Installation checks from the last 24 hours.</p></div></div>
            {!canAdmin ? (
              <p className="muted">Administrator access is required to view health checks.</p>
            ) : health.isPending ? (
              <Skeleton className="settings-feature-skeleton" />
            ) : health.data ? (
              <div className="settings-health-list">
                <div><CheckCircle2/><span><strong>Control database</strong>Connected</span></div>
                <div><ServerCog/><span><strong>Snapshot shards</strong>32 shards configured</span></div>
                <div><KeyRound/><span><strong>DataForSEO credentials</strong>{health.data.provider?.dataForSeo?.configured ? "Configured in Worker secrets" : "Missing Worker secrets"}</span></div>
                <div><KeyRound/><span><strong>Managed billing</strong>{health.data.provider?.payments?.mode === "disabled" ? "Disabled for self-hosted mode" : health.data.provider?.payments?.configured ? `${health.data.provider.payments.providerLabel ?? "Payment provider"} ${health.data.provider.payments.environment ?? ""} configured`.trim() : "Payment provider setup is incomplete"}</span></div>
                <div><KeyRound/><span><strong>Email delivery</strong>{health.data.provider?.email?.configured ? "Configured" : "Disabled; invitation links remain copyable"}</span></div>
                <div><ServerCog/><span><strong>Public application URL</strong>{health.data.publicOrigin?.configured ?? health.data.publicOrigin?.stored ?? "Not configured"}{health.data.publicOrigin?.configured ? " (managed by Worker configuration)" : " (workspace setting)"}</span></div>
              </div>
            ) : <p className="muted">Health checks could not be loaded.</p>}
          </section>
        </div>
      ) : null}

      <Dialog
        open={workspaceOpen}
        onOpenChange={setWorkspaceOpen}
        title="Edit workspace"
        description="The public application URL receives provider callbacks and is used in generated links."
      >
        <form className="form-stack" onSubmit={workspaceUpdateSubmit}>
          <Label>Workspace name</Label>
          <Input name="name" defaultValue={session.workspace.name} minLength={2} maxLength={120} required />
          <Label hint={session.capabilities.publicOriginManaged ? "Managed by PUBLIC_APP_ORIGIN" : "HTTPS origin only; do not include a path"}>
            Public application URL
          </Label>
          <Input
            disabled={session.capabilities.publicOriginManaged}
            name="publicBaseUrl"
            type="url"
            defaultValue={session.workspace.publicBaseUrl}
            required={!session.capabilities.publicOriginManaged}
          />
          {updateWorkspace.isError ? <p className="form-error">{updateWorkspace.error.message}</p> : null}
          <div className="dialog-actions">
            <Button type="button" variant="ghost" onClick={() => setWorkspaceOpen(false)}>Cancel</Button>
            <Button disabled={updateWorkspace.isPending}>{updateWorkspace.isPending ? "Saving…" : "Save changes"}</Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={projectOpen}
        onOpenChange={setProjectOpen}
        title="Create project"
        description="New projects start with Shopping enrichment and automatic competitor tracking disabled."
      >
        <form className="form-stack" onSubmit={projectSubmit}>
          <Label>Project name</Label><Input name="name" required />
          <Label>Owned brand</Label><Input name="brand" required />
          <Label>Primary domain</Label><Input name="primaryDomain" placeholder="example.com" />
          <Button disabled={createProject.isPending}>{createProject.isPending ? "Creating…" : "Create project"}</Button>
        </form>
      </Dialog>
      <Dialog
        open={Boolean(editingProject)}
        onOpenChange={(open) => { if (!open) setEditingProject(null); }}
        title="Edit project"
        description="Update the project name and primary domain."
      >
        {editingProject ? (
          <form className="form-stack" key={editingProject.id} onSubmit={projectUpdateSubmit}>
            <Label>Project name</Label><Input name="name" defaultValue={editingProject.name} required />
            <Label>Primary domain</Label><Input name="primaryDomain" defaultValue={editingProject.primary_domain ?? ""} placeholder="example.com" />
            {updateProject.isError ? <p className="form-error">The project could not be updated.</p> : null}
            <div className="dialog-actions">
              <Button type="button" variant="ghost" onClick={() => setEditingProject(null)}>Cancel</Button>
              <Button disabled={updateProject.isPending}>{updateProject.isPending ? "Saving…" : "Save changes"}</Button>
            </div>
          </form>
        ) : null}
      </Dialog>
      <Dialog
        open={webhookOpen}
        onOpenChange={setWebhookOpen}
        title="Add webhook destination"
        description="Only public HTTPS targets are accepted."
      >
        {webhookSecret ? (
          <div className="success-panel">
            <CheckCircle2/><p>Store this signing secret now; it will not be shown again.</p>
            <code className="invite-link">{webhookSecret}</code>
            <Button onClick={() => void navigator.clipboard.writeText(webhookSecret)}>Copy secret</Button>
          </div>
        ) : (
          <form className="form-stack" onSubmit={webhookSubmit}>
            <Label>Name</Label><Input name="name" required />
            <Label>HTTPS URL</Label><Input name="url" type="url" placeholder="https://example.com/hooks/belki" required />
            <Button disabled={createWebhook.isPending}>{createWebhook.isPending ? "Creating…" : "Create destination"}</Button>
          </form>
        )}
      </Dialog>
    </div>
  );
}
