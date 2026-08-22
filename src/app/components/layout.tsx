import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ChartNoAxesCombined,
  LayoutDashboard,
  LogOut,
  Menu,
  Megaphone,
  ScanSearch,
  ShoppingBag,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../context";
import { post } from "../lib/api";
import { APP_NAME } from "../lib/branding";
import {
  projectDataNavigationVisible,
  projectChangeDestination,
  trackingSourcesForPath,
  trackingSourceChangeDestination,
} from "../lib/project-navigation";
import { AppIcon } from "./app-icon";
import { DomainFavicon } from "./domain-favicon";
import {
  BillingIcon,
  PromptsIcon,
  RelatedQueriesIcon,
  SourcesIcon,
} from "./navigation-icons";
import { Button, Select } from "./ui";
import { cn } from "../lib/utils";
import { TRACKING_SOURCE_LABELS } from "../../shared/tracking-sources";

const NAVIGATION = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/prompts", label: "Prompts", icon: PromptsIcon },
  { to: "/related-queries", label: "Related queries", icon: RelatedQueriesIcon },
  { to: "/citations", label: "Citation Sources", icon: SourcesIcon },
  { to: "/brands", label: "Entities", icon: ScanSearch },
  { to: "/ads", label: "Ads", icon: Megaphone },
  { to: "/shopping", label: "Shopping", icon: ShoppingBag },
] as const;

export function AppLayout() {
  const {
    session,
    projects,
    projectId,
    setProjectId,
    currentProject,
    trackingSources,
    trackingSource,
    setTrackingSource,
  } = useApp();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const pageTrackingSources = useMemo(
    () => trackingSourcesForPath(
      location.pathname,
      trackingSources,
      currentProject?.source_data_counts,
    ),
    [currentProject?.source_data_counts, location.pathname, trackingSources],
  );
  useEffect(() => {
    const fallbackSource = pageTrackingSources[0];
    if (fallbackSource && !pageTrackingSources.includes(trackingSource)) {
      setTrackingSource(fallbackSource);
      const destination = trackingSourceChangeDestination(location.pathname);
      if (destination) void navigate(destination, { replace: true });
    }
  }, [
    location.pathname,
    navigate,
    pageTrackingSources,
    setTrackingSource,
    trackingSource,
  ]);
  const logout = useMutation({
    mutationFn: () => post("/auth/logout"),
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/");
    },
  });
  const selectWorkspace = useMutation({
    mutationFn: (workspaceId: string) => post("/auth/workspaces/select", { workspaceId }),
    onSuccess: () => {
      localStorage.removeItem("ai-tracker-project");
      queryClient.clear();
      window.location.assign("/");
    },
  });
  const projectOptions = projects.map((project) => ({
    value: project.id,
    label: project.name,
    icon: <DomainFavicon domain={project.primary_domain} size={18} />,
  }));
  const selectProject = (value: string) => {
    setProjectId(value);
    setMobileOpen(false);
    const destination = projectChangeDestination(location.pathname);
    if (destination) void navigate(destination, { replace: true });
  };
  return (
    <div className="app-shell">
      <aside className={cn("sidebar", mobileOpen && "sidebar-open")}>
        <div className="sidebar-brand">
          <NavLink
            aria-label={`${APP_NAME} overview`}
            className="brand-home"
            onClick={() => setMobileOpen(false)}
            to="/"
          >
            <span className="brand-mark"><AppIcon /></span>
            <span>{APP_NAME}</span>
          </NavLink>
          <button className="mobile-close" onClick={() => setMobileOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <div className="workspace-summary">
          <span className="workspace-label">Workspace</span>
          {session.workspaces.length > 1 ? (
            <Select
              ariaLabel="Active workspace"
              value={session.workspaceId}
              onValueChange={(workspaceId) => selectWorkspace.mutate(workspaceId)}
              options={session.workspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
            />
          ) : <strong title={session.workspace.name}>{session.workspace.name}</strong>}
        </div>
        <div className="project-label">Project</div>
        <Select
          ariaLabel="Active project"
          value={projectId ?? undefined}
          onValueChange={selectProject}
          options={projectOptions}
          placeholder="Select project"
        />
        <nav className="sidebar-nav">
          <p>Monitor</p>
          {NAVIGATION
            .filter(({ to }) => projectDataNavigationVisible(
              to,
              location.pathname,
              {
                ads: Number(currentProject?.ads_count ?? 0),
                products: Number(currentProject?.products_count ?? 0),
              },
            ))
            .map(({ to, label, icon: Icon, ...item }) => (
            <NavLink
              key={to}
              to={to}
              end={"end" in item ? item.end : false}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => cn("nav-item", isActive && "active")}
            >
              <Icon size={17} />
              <span>{label}</span>
            </NavLink>
            ))}
          <p>Manage</p>
          {session.user.role === "owner" || session.user.role === "admin" ? (
            <>
              <NavLink
                to="/users"
                className={({ isActive }) => cn("nav-item", isActive && "active")}
              >
                <Users size={17} /> <span>Users</span>
              </NavLink>
              <NavLink
                to="/billing"
                className={({ isActive }) => cn("nav-item", isActive && "active")}
              >
                <BillingIcon size={17} /> <span>Billing</span>
              </NavLink>
            </>
          ) : null}
          <NavLink
            to="/settings"
            className={({ isActive }) => cn("nav-item", isActive && "active")}
          >
            <Settings size={17} /> <span>Settings</span>
          </NavLink>
          {session.isPlatformOperator ? (
            <>
              <p>Operator</p>
              <NavLink
                end
                to="/operator"
                className={({ isActive }) => cn("nav-item", "operator-nav-item", isActive && "active")}
              >
                <ShieldCheck size={17} /> <span>Console</span>
              </NavLink>
              <NavLink
                to="/operator/insights/citations"
                className={({ isActive }) => cn("nav-item", "operator-nav-item", isActive && "active")}
              >
                <SourcesIcon size={17} /> <span>Citation trends</span>
              </NavLink>
              <NavLink
                to="/operator/insights/fan-out"
                className={({ isActive }) => cn("nav-item", "operator-nav-item", isActive && "active")}
              >
                <RelatedQueriesIcon size={17} /> <span>Fan-out trends</span>
              </NavLink>
            </>
          ) : null}
        </nav>
        <div className="sidebar-user">
          <div className="avatar">{session.user.displayName.slice(0, 1).toUpperCase()}</div>
          <div>
            <strong>{session.user.displayName}</strong>
            <span>{session.user.role}</span>
          </div>
          <button title="Sign out" onClick={() => logout.mutate()}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {mobileOpen ? <button className="sidebar-scrim" onClick={() => setMobileOpen(false)} /> : null}
      <main className="main">
        <header className="mobile-topbar">
          <button
            aria-label="Open navigation"
            className="mobile-menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={19} />
          </button>
          <NavLink
            aria-label={`${APP_NAME} overview`}
            className="mobile-brand"
            to="/"
          >
            <AppIcon size={23} />
            <strong>{APP_NAME}</strong>
          </NavLink>
          {projects.length > 0 ? (
            <div className="mobile-project-switcher">
              <Select
                ariaLabel="Active project"
                value={projectId ?? undefined}
                onValueChange={selectProject}
                options={projectOptions}
                placeholder="Select project"
              />
            </div>
          ) : null}
        </header>
        {projectId && pageTrackingSources.length > 1 && location.pathname !== "/" && ![
          "/billing",
          "/settings",
          "/users",
          "/operator",
          "/entities",
        ].some((path) => location.pathname.startsWith(path)) ? (
          <div className="tracking-source-tabs" aria-label="Tracking source" role="tablist">
            {pageTrackingSources.map((source) => (
              <button
                aria-selected={trackingSource === source}
                className={trackingSource === source ? "active" : undefined}
                key={source}
                onClick={() => {
                  if (source === trackingSource) return;
                  setTrackingSource(source);
                  const destination = trackingSourceChangeDestination(
                    location.pathname,
                  );
                  if (destination) void navigate(destination, { replace: true });
                }}
                role="tab"
                type="button"
              >
                {TRACKING_SOURCE_LABELS[source]}
              </button>
            ))}
          </div>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function NoProject() {
  const { session } = useApp();
  const canCreate = session.user.role !== "viewer";
  return (
    <section className="project-required-state">
      <span className="project-required-icon"><ChartNoAxesCombined size={24} /></span>
      <div>
        <span className="eyebrow">First step</span>
        <h2>Create your first project</h2>
        <p>{canCreate
          ? "Connect a brand and website before adding the prompts you want Belki to monitor."
          : "Ask a workspace editor or administrator to create a project before monitoring can begin."}</p>
      </div>
      {canCreate ? <Button asChild><NavLink to="/onboarding/project">Create project <ArrowRight size={16} /></NavLink></Button> : null}
    </section>
  );
}
