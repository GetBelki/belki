export function insightYAxisMax(values: Iterable<number>): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, value);
  const padded = maximum * 1.15;
  for (const ceiling of [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100]) {
    if (padded <= ceiling) return ceiling;
  }
  return 100;
}

export function insightNumericYAxisMax(values: Iterable<number>): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, value);
  if (maximum <= 0) return 1;
  const padded = maximum * 1.15;
  const magnitude = 10 ** Math.floor(Math.log10(padded));
  const normalized = padded / magnitude;
  const ceiling = [1, 2, 5, 10].find((value) => normalized <= value) ?? 10;
  return ceiling * magnitude;
}
