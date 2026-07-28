import { matchPath } from "react-router-dom";

const PROJECT_DETAIL_ROUTES = [
  "/prompts/:queryId",
  "/prompts/:queryId/snapshots/:snapshotId",
  "/queries/:queryId",
  "/queries/:queryId/snapshots/:snapshotId",
  "/snapshots/:snapshotId",
] as const;

export function projectChangeDestination(pathname: string): string | null {
  return PROJECT_DETAIL_ROUTES.some((path) =>
    matchPath({ path, end: true }, pathname)
  )
    ? "/prompts"
    : null;
}
