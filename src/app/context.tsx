import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { api, type Project, type Session } from "./lib/api";
import type { TrackingSource } from "../shared/tracking-sources";

interface AppContextValue {
  session: Session;
  projects: Project[];
  projectId: string | null;
  setProjectId: (value: string) => void;
  currentProject: Project | null;
  trackingSources: TrackingSource[];
  trackingSource: TrackingSource;
  setTrackingSource: (value: TrackingSource) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  session,
  children,
}: PropsWithChildren<{ session: Session }>) {
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/projects"),
    initialData: session.projects,
    refetchInterval: 60_000,
  });
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const [selectedProjectId, setProjectIdState] = useState<string | null>(
    localStorage.getItem("ai-tracker-project"),
  );
  const [selectedTrackingSource, setSelectedTrackingSource] = useState<{
    projectId: string;
    source: TrackingSource;
  } | null>(null);
  const projectId = projects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : projects[0]?.id ?? null;
  const sourceSettings = useQuery({
    queryKey: ["project-settings", projectId],
    queryFn: () => api<{ trackingSources: TrackingSource[] }>(`/projects/${projectId}/settings`),
    enabled: Boolean(projectId),
  });
  const trackingSources = useMemo<TrackingSource[]>(
    () => sourceSettings.data?.trackingSources?.length
      ? sourceSettings.data.trackingSources
      : ["chatgpt"],
    [sourceSettings.data],
  );
  const storedSource = selectedTrackingSource?.projectId === projectId
    ? selectedTrackingSource.source
    : (projectId
    ? localStorage.getItem(`belki-tracking-source:${projectId}`) as TrackingSource | null
    : null);
  const trackingSource = storedSource && trackingSources.includes(storedSource)
    ? storedSource
    : trackingSources[0] ?? "chatgpt";
  const setProjectId = useCallback((value: string) => {
    localStorage.setItem("ai-tracker-project", value);
    setProjectIdState(value);
  }, []);
  const setTrackingSource = useCallback((value: TrackingSource) => {
    if (projectId) localStorage.setItem(`belki-tracking-source:${projectId}`, value);
    if (projectId) setSelectedTrackingSource({ projectId, source: value });
  }, [projectId]);
  const value = useMemo(
    () => ({
      session,
      projects,
      projectId,
      setProjectId,
      currentProject: projects.find((project) => project.id === projectId) ?? null,
      trackingSources,
      trackingSource,
      setTrackingSource,
    }),
    [projectId, projects, session, setProjectId, setTrackingSource, trackingSource, trackingSources],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// The provider and its companion hook intentionally share this small module.
// eslint-disable-next-line react-refresh/only-export-components
export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}
