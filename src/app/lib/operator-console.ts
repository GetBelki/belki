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

export function operatorLimitUsage(current: number, limit: number): string {
  if (limit >= 1_000_000) return "Unlimited";
  const format = new Intl.NumberFormat("en-US");
  return `${format.format(current)}/${format.format(limit)}`;
}
