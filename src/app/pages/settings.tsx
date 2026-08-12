import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
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
import { api, patch, post, type Project } from "../lib/api";
import { compact, formText, pluralize } from "../lib/utils";

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
}

interface WebhookDestination {
  id: string;
  name: string;
  url: string;
  is_enabled: number;
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
    queryFn: () => api<Record<string, unknown>>("/settings/health"),
    enabled: canAdmin && view === "diagnostics",
  });
  const webhooks = useQuery({
    queryKey: ["webhook-destinations"],
    queryFn: () => api<WebhookDestination[]>("/webhook-destinations"),
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
      title: "Retain original response pages",
      description: `Keep source HTML for ${projectSettings.data.htmlRetentionDays} days for future captures.`,
      checked: projectSettings.data.htmlCaptureEnabled,
      disabled: !canAdmin,
    },
    {
      key: "productEnrichmentEnabled" as const,
      title: "Google Shopping enrichment",
      description: "Refresh product, seller, availability, and market data for eligible Shopping results.",
      checked: projectSettings.data.productEnrichmentEnabled,
      disabled: !canAdmin,
    },
    {
      key: "entityExtractionEnabled" as const,
      title: "Named entity extraction",
      description: "Discover brands, companies, people, and places in captured responses.",
      checked: projectSettings.data.entityExtractionEnabled,
      disabled: !canAdmin,
    },
    {
      key: "entityAutoTrackEnabled" as const,
      title: "Auto-track high-confidence competitors",
      description: "Promote repeatedly corroborated competitor brands into visibility tracking.",
      checked: projectSettings.data.entityAutoTrackEnabled,
      disabled: !canAdmin || !projectSettings.data.entityExtractionEnabled,
    },
  ] : [];

  return (
    <div className="page">
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
                      <div><strong>{feature.title}</strong><span>{feature.description}</span></div>
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
                  Original page HTML is retained for {projectSettings.data?.htmlRetentionDays ?? 90} days when capture is enabled.
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
                <div><KeyRound/><span><strong>Runtime configuration</strong>Bindings available</span></div>
              </div>
            ) : <p className="muted">Health checks could not be loaded.</p>}
          </section>
        </div>
      ) : null}

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
