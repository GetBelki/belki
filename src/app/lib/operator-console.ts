export type OperatorWorkspaceStatus =
  | "pending_payment"
  | "active"
  | "read_only"
  | "suspended"
  | "deleted";

export function operatorPlanLabel(planKey: string): string {
  if (planKey === "self_hosted") return "Internal";
  return planKey
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

export function operatorStatusLabel(status: OperatorWorkspaceStatus): string {
  return status
    .replaceAll("_", " ")
    .replaceAll(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

export function operatorStatusTone(
  status: OperatorWorkspaceStatus,
): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "active") return "success";
  if (status === "pending_payment") return "warning";
  if (status === "read_only") return "info";
  if (status === "suspended" || status === "deleted") return "danger";
  return "neutral";
}

export function operatorLimitUsage(current: number, limit: number): string {
  if (limit >= 1_000_000) return "Unlimited";
  const format = new Intl.NumberFormat("en-US");
  return `${format.format(current)}/${format.format(limit)}`;
}
