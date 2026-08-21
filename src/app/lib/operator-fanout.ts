export type FanOutMetric =
  | "shareOfFanOuts"
  | "fanOutsPerResponse"
  | "responseShare";

export type FanOutSignalGroup =
  | "direct-source"
  | "commercial-research"
  | "listicle"
  | "comparison"
  | "years";

export function fanOutMetricValue(value: string | null): FanOutMetric {
  return value === "fanOutsPerResponse" || value === "responseShare"
    ? value
    : "shareOfFanOuts";
}

export function fanOutSignalGroupValue(
  value: string | null,
): FanOutSignalGroup {
  return value === "commercial-research"
    || value === "listicle"
    || value === "comparison"
    || value === "years"
    ? value
    : "direct-source";
}
