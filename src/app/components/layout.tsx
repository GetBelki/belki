import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Boxes,
  ChartNoAxesCombined,
  FileDown,
  Globe2,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageSearch,
  Search,
  Settings,
  Tags,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useApp } from "../context";
import { post } from "../lib/api";
import { Button, Select } from "./ui";
import { cn } from "../lib/utils";

const NAVIGATION = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/queries", label: "Queries", icon: Search },
  { to: "/snapshots", label: "Snapshots", icon: Boxes },
  { to: "/domains", label: "Domains", icon: Globe2 },
  { to: "/brands", label: "Brands", icon: Tags },
  { to: "/products", label: "Products", icon: PackageSearch },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/exports", label: "Exports", icon: FileDown },
] as const;

export function AppLayout() {
  const { session, projects, projectId, setProjectId, currentProject } = useApp();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);
  const logout = useMutation({
    mutationFn: () => post("/auth/logout"),
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/");
    },
  });
  return (
    <div className="app-shell">
      <aside className={cn("sidebar", mobileOpen && "sidebar-open")}>
        <div className="sidebar-brand">
          <span className="brand-mark">A</span>
          <span>AI Tracker</span>
          <button className="mobile-close" onClick={() => setMobileOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <div className="workspace-label">Workspace</div>
        <Select
          value={projectId ?? undefined}
          onValueChange={(value) => {
            setProjectId(value);
            setMobileOpen(false);
          }}
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          placeholder="Select project"
        />
        <nav className="sidebar-nav">
          <p>Monitor</p>
          {NAVIGATION.map(({ to, label, icon: Icon, ...item }) => (
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
            <NavLink
              to="/users"
              className={({ isActive }) => cn("nav-item", isActive && "active")}
            >
              <Users size={17} /> <span>Users</span>
            </NavLink>
          ) : null}
          <NavLink
            to="/settings"
            className={({ isActive }) => cn("nav-item", isActive && "active")}
          >
            <Settings size={17} /> <span>Settings</span>
          </NavLink>
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
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileOpen(true)}>
            <Menu size={19} />
          </button>
          <div>
            <span className="eyebrow">ChatGPT Web Search</span>
            <strong>{currentProject?.name ?? "Create your first project"}</strong>
          </div>
          <div className="topbar-status">
            <span className="status-dot" /> Monitoring
          </div>
        </header>
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
  title: string;
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
  return (
    <div className="page">
      <PageHeader
        title="Start with a project"
        description="Projects connect your brand, competitors, and tracked prompts."
      />
      <div className="welcome-panel">
        <ChartNoAxesCombined size={30} />
        <h2>No project selected</h2>
        <p>Create a project from Settings to begin collecting ChatGPT web visibility data.</p>
        <Button asChild><NavLink to="/settings">Open settings</NavLink></Button>
      </div>
    </div>
  );
}
