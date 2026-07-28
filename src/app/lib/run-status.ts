import type { RunStatus } from "../../shared/contracts";

const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  "queued",
  "submitting",
  "submission_unknown",
  "submitted",
  "awaiting_result",
  "normalizing",
]);

export function isRunInProgress(
  status: RunStatus | null | undefined,
): boolean {
  return status ? ACTIVE_RUN_STATUSES.has(status) : false;
}

export function runStatusLabel(
  status: RunStatus | null | undefined,
): string {
  switch (status) {
    case "queued":
      return "Queued…";
    case "submitting":
      return "Submitting…";
    case "submission_unknown":
    case "submitted":
    case "awaiting_result":
      return "Waiting for result…";
    case "normalizing":
      return "Saving result…";
    default:
      return "Run now";
  }
}
