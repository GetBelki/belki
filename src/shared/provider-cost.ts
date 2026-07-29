function validCost(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function resolveProviderCost(
  ...costs: Array<number | null | undefined>
): number | null {
  const validCosts = costs.filter(validCost);
  return validCosts.find((cost) => cost > 0) ?? validCosts[0] ?? null;
}
