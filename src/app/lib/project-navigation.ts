import { matchPath } from "react-router-dom";

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
  return matchPath({ path: "/snapshots/:snapshotId", end: true }, pathname)
    ? "/snapshots"
    : null;
}
