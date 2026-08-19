// Version 6 records response-level fan-out classifications for operator trends.
export const ANALYTICS_READ_MODEL_SCHEMA_VERSION = 6;
// Related-query tables and indexing were complete in version 4. Later additive
// schema versions must remain valid for this report.
export const RELATED_QUERIES_READ_MODEL_SCHEMA_VERSION = 4;

export interface AnalyticsReadModelState {
  status: string;
  schema_version: number;
}

export function analyticsReadModelSupports(
  state: AnalyticsReadModelState | null,
  requiredVersion = ANALYTICS_READ_MODEL_SCHEMA_VERSION,
): boolean {
  return state?.status === "ready" && state.schema_version >= requiredVersion;
}
