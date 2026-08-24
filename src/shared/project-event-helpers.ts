import type {
  ChartAnnotation,
  ProjectEventType,
} from "./project-events";
import {
  TRACKING_SOURCES,
  type TrackingSource,
} from "./tracking-sources";

export interface ProjectEventRow {
  id: string;
  event_type: ProjectEventType;
  tracking_source: TrackingSource | null;
  event_date: string;
  occurred_at: string;
  payload_json: string;
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isTrackingSource(value: unknown): value is TrackingSource {
  return typeof value === "string" &&
    TRACKING_SOURCES.includes(value as TrackingSource);
}

function trackingSources(value: unknown): TrackingSource[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isTrackingSource))];
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 0;
}

export function promptChangeFromAudit(
  action: string,
  metadataJson: string,
): { addedCount: number; removedCount: number } | null {
  if (action === "query.created") {
    return { addedCount: 1, removedCount: 0 };
  }
  if (action === "query.purge_requested") {
    return { addedCount: 0, removedCount: 1 };
  }
  if (action !== "query.bulk_created") return null;
  const count = parsePayload(metadataJson).createdCount;
  return positiveInteger(count)
    ? { addedCount: Number(count), removedCount: 0 }
    : null;
}

export function normalizeProviderModel(value: string | null | undefined): {
  display: string;
  key: string;
} | null {
  const display = value?.trim().replace(/\s+/gu, " ");
  if (!display) return null;
  return { display, key: display.toLocaleLowerCase("en-US") };
}

export function trackingSourceDelta(
  previous: readonly TrackingSource[],
  next: readonly TrackingSource[],
): { addedSources: TrackingSource[]; removedSources: TrackingSource[] } {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    addedSources: TRACKING_SOURCES.filter(
      (source) => nextSet.has(source) && !previousSet.has(source),
    ),
    removedSources: TRACKING_SOURCES.filter(
      (source) => previousSet.has(source) && !nextSet.has(source),
    ),
  };
}

export function buildChartAnnotations(
  rows: readonly ProjectEventRow[],
): ChartAnnotation[] {
  const annotations: ChartAnnotation[] = [];
  const promptsByDate = new Map<string, {
    addedCount: number;
    removedCount: number;
  }>();

  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(row.event_date)) continue;
    const payload = parsePayload(row.payload_json);
    if (row.event_type === "prompt_set_changed") {
      const addedCount = positiveInteger(payload.addedCount);
      const removedCount = positiveInteger(payload.removedCount);
      if (!addedCount && !removedCount) continue;
      const current = promptsByDate.get(row.event_date) ?? {
        addedCount: 0,
        removedCount: 0,
      };
      current.addedCount += addedCount;
      current.removedCount += removedCount;
      promptsByDate.set(row.event_date, current);
      continue;
    }
    if (row.event_type === "tracking_sources_changed") {
      const addedSources = trackingSources(payload.addedSources);
      const removedSources = trackingSources(payload.removedSources);
      if (!addedSources.length && !removedSources.length) continue;
      annotations.push({
        type: row.event_type,
        id: row.id,
        metricDate: row.event_date,
        occurredAt: row.occurred_at,
        addedSources,
        removedSources,
      });
      continue;
    }
    if (row.event_type === "model_detected" && row.tracking_source) {
      const model = typeof payload.model === "string" ? payload.model.trim() : "";
      if (!model) continue;
      annotations.push({
        type: row.event_type,
        id: row.id,
        metricDate: row.event_date,
        occurredAt: row.occurred_at,
        trackingSource: row.tracking_source,
        model,
      });
    }
  }

  for (const [metricDate, counts] of promptsByDate) {
    annotations.push({
      type: "prompt_set_changed",
      metricDate,
      ...counts,
    });
  }
  return annotations.sort((left, right) =>
    left.metricDate.localeCompare(right.metricDate) ||
    left.type.localeCompare(right.type)
  );
}
