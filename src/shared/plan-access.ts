import type { PlanKey } from "./contracts";

export function planAllowsManualRuns(planKey: PlanKey): boolean {
  return planKey === "self_hosted";
}
