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
  { path: "/shopping/:productKey", destination: "/shopping" },
] as const;

export function projectChangeDestination(pathname: string): string | null {
  return (
    PROJECT_DETAIL_ROUTES.find(({ path }) =>
      matchPath({ path, end: true }, pathname)
    )?.destination ?? null
  );
}
