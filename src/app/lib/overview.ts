export function hasOverviewProducts(
  overview:
    | {
        topProducts: readonly unknown[];
        recentProducts: readonly unknown[];
      }
    | undefined,
): boolean {
  return Boolean(
    overview && (overview.topProducts.length || overview.recentProducts.length),
  );
}
