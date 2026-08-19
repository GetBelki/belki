export function insightYAxisMax(values: Iterable<number>): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, value);
  const padded = maximum * 1.15;
  for (const ceiling of [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100]) {
    if (padded <= ceiling) return ceiling;
  }
  return 100;
}
