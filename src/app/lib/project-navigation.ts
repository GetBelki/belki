import { matchPath } from "react-router-dom";
import type { TrackingSource } from "../../shared/tracking-sources";

const PROJECT_DETAIL_ROUTES = [
  { path: "/prompts/:queryId", destination: "/prompts" },
  {
    path: "/prompts/:queryId/snapshots/:snapshotId",
    destination: "/prompts",
  },
  { path: "/queries/:queryId", destination: "/prompts" },
  {
    path: "/queries/:queryId/snapshots/:snapshotId",
    destination: "/prompts",
  },
  { path: "/snapshots/:snapshotId", destination: "/prompts" },
  { path: "/citations/:domain", destination: "/citations" },
  { path: "/related-queries/:queryKey", destination: "/related-queries" },
  { path: "/ads/:advertiserKey", destination: "/ads" },
  { path: "/shopping/:productKey", destination: "/shopping" },
] as const;

export function activeProjectsFirst<T extends { paused_at?: string | null }>(
  projects: readonly T[],
): T[] {
  return [
    ...projects.filter((project) => !project.paused_at),
    ...projects.filter((project) => Boolean(project.paused_at)),
  ];
}

export function projectDataNavigationVisible(
  destination: string,
  pathname: string,
  counts: { ads: number; products: number },
): boolean {
  if (destination === "/ads") {
    return counts.ads > 0 || pathname.startsWith("/ads");
  }
  if (destination === "/shopping") {
    return counts.products > 0 || pathname.startsWith("/shopping");
  }
  return true;
}

export function trackingSourcesForPath(
  pathname: string,
  enabledSources: TrackingSource[],
  counts: Partial<Record<TrackingSource, { ads: number; products: number }>> = {},
): TrackingSource[] {
  const metric = pathname.startsWith("/ads")
    ? "ads"
    : pathname.startsWith("/shopping")
      ? "products"
      : null;
  if (!metric) return enabledSources;
  return enabledSources.filter(
    (source) => Number(counts[source]?.[metric] ?? 0) > 0,
  );
}

export function projectChangeDestination(pathname: string): string | null {
  if (pathname === "/prompts/library") return null;
  return (
    PROJECT_DETAIL_ROUTES.find(({ path }) =>
      matchPath({ path, end: true }, pathname)
    )?.destination ?? null
  );
}

export function trackingSourceChangeDestination(
  pathname: string,
): string | null {
  for (const path of [
    "/prompts/:queryId/snapshots/:snapshotId",
    "/queries/:queryId/snapshots/:snapshotId",
  ]) {
    const match = matchPath({ path, end: true }, pathname);
    if (match?.params.queryId) {
      return `/prompts/${encodeURIComponent(match.params.queryId)}`;
    }
  }
  if (matchPath({ path: "/shopping/:productKey", end: true }, pathname)) {
    return "/shopping";
  }
  if (matchPath({ path: "/ads/:advertiserKey", end: true }, pathname)) {
    return "/ads";
  }
  return matchPath({ path: "/snapshots/:snapshotId", end: true }, pathname)
    ? "/snapshots"
    : null;
}
