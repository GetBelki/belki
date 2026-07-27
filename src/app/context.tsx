import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { api, type Project, type Session } from "./lib/api";

interface AppContextValue {
  session: Session;
  projects: Project[];
  projectId: string | null;
  setProjectId: (value: string) => void;
  currentProject: Project | null;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  session,
  children,
}: PropsWithChildren<{ session: Session }>) {
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/projects"),
  });
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const [selectedProjectId, setProjectIdState] = useState<string | null>(
    localStorage.getItem("ai-tracker-project"),
  );
  const projectId = projects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : projects[0]?.id ?? null;
  const setProjectId = (value: string) => {
    localStorage.setItem("ai-tracker-project", value);
    setProjectIdState(value);
  };
  const value = useMemo(
    () => ({
      session,
      projects,
      projectId,
      setProjectId,
      currentProject: projects.find((project) => project.id === projectId) ?? null,
    }),
    [projectId, projects, session],
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
