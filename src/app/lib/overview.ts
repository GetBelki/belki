import type { ChartAnnotation } from "../../shared/project-events";
import { TRACKING_SOURCE_LABELS } from "../../shared/tracking-sources";
import { CAPTURE_PROVIDER_LABELS } from "../../shared/capture-providers";

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

export interface AlignedChartAnnotation {
  chartDate: string;
  label: string;
  sourceEvents: ChartAnnotation[];
}

function positiveInteger(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function promptCounts(events: readonly ChartAnnotation[]): {
  addedCount: number;
  removedCount: number;
} {
  return events.reduce(
    (counts, event) => event.type === "prompt_set_changed"
      ? {
          addedCount: counts.addedCount + positiveInteger(event.addedCount),
          removedCount: counts.removedCount + positiveInteger(event.removedCount),
        }
      : counts,
    { addedCount: 0, removedCount: 0 },
  );
}

export function promptSetEventLabel(event: {
  addedCount: number;
  removedCount: number;
}): string {
  const added = positiveInteger(event.addedCount);
  const removed = positiveInteger(event.removedCount);
  if (added && removed) return `+${added} / −${removed}`;
  if (added) return `+${added} ${added === 1 ? "prompt" : "prompts"}`;
  if (removed) return `−${removed} ${removed === 1 ? "prompt" : "prompts"}`;
  return "";
}

export function chartAnnotationLabel(
  events: readonly ChartAnnotation[],
): string {
  const prompts = events.filter((event) => event.type === "prompt_set_changed");
  if (prompts.length === events.length) {
    return promptSetEventLabel(promptCounts(events));
  }
  if (events.length === 1 && events[0]?.type === "model_detected") {
    return "Model detected";
  }
  if (
    events.length === 1 &&
    events[0]?.type === "capture_provider_detected"
  ) {
    return "Capture provider detected";
  }
  if (events.length === 1 && events[0]?.type === "tracking_sources_changed") {
    return "Platform tracking changed";
  }
  return `${events.length} events`;
}

export function chartAnnotationMarkerLabel(
  event: AlignedChartAnnotation,
): string {
  if (event.sourceEvents.every((source) => source.type === "prompt_set_changed")) {
    const counts = promptCounts(event.sourceEvents);
    if (counts.addedCount && counts.removedCount) {
      return `±${counts.addedCount + counts.removedCount}`;
    }
    return counts.addedCount ? `+${counts.addedCount}` : `−${counts.removedCount}`;
  }
  if (event.sourceEvents.length === 1) {
    const type = event.sourceEvents[0]?.type;
    if (type === "model_detected") return "Model";
    if (type === "capture_provider_detected") return "Provider";
    return "Platform";
  }
  return `${event.sourceEvents.length}`;
}

export function alignChartAnnotations(
  events: readonly ChartAnnotation[],
  chartDates: readonly string[],
): AlignedChartAnnotation[] {
  const dates = [...new Set(chartDates)]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date))
    .sort();
  const alignedByDate = new Map<string, AlignedChartAnnotation>();

  for (const source of [...events].sort((left, right) =>
    left.metricDate.localeCompare(right.metricDate)
  )) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(source.metricDate)) continue;
    if (
      source.type === "prompt_set_changed" &&
      !positiveInteger(source.addedCount) &&
      !positiveInteger(source.removedCount)
    ) continue;
    const chartDate = dates.find((date) => date >= source.metricDate);
    if (!chartDate) continue;
    const existing = alignedByDate.get(chartDate);
    if (existing) {
      existing.sourceEvents.push(source);
      existing.label = chartAnnotationLabel(existing.sourceEvents);
    } else {
      alignedByDate.set(chartDate, {
        chartDate,
        label: chartAnnotationLabel([source]),
        sourceEvents: [source],
      });
    }
  }
  return [...alignedByDate.values()];
}

export function clusterChartAnnotations(
  events: readonly AlignedChartAnnotation[],
  chartDates: readonly string[],
  maximumIndexSpan = 1,
): AlignedChartAnnotation[] {
  const dateIndexes = new Map(
    [...new Set(chartDates)].map((date, index) => [date, index]),
  );
  const positioned = events
    .map((event) => ({ event, index: dateIndexes.get(event.chartDate) }))
    .filter(
      (value): value is { event: AlignedChartAnnotation; index: number } =>
        value.index !== undefined,
    )
    .sort((left, right) => left.index - right.index);
  const clusters: Array<{ firstIndex: number; event: AlignedChartAnnotation }> = [];

  for (const positionedEvent of positioned) {
    const current = clusters.at(-1);
    if (
      current &&
      positionedEvent.index - current.firstIndex <= maximumIndexSpan
    ) {
      const sourceEvents = [
        ...current.event.sourceEvents,
        ...positionedEvent.event.sourceEvents,
      ];
      current.event = {
        chartDate: positionedEvent.event.chartDate,
        label: chartAnnotationLabel(sourceEvents),
        sourceEvents,
      };
      continue;
    }
    clusters.push({
      firstIndex: positionedEvent.index,
      event: {
        ...positionedEvent.event,
        sourceEvents: [...positionedEvent.event.sourceEvents],
      },
    });
  }
  return clusters.map((cluster) => cluster.event);
}

export function chartAnnotationItemLabel(event: ChartAnnotation): string {
  if (event.type === "prompt_set_changed") {
    const messages: string[] = [];
    if (event.addedCount) {
      messages.push(
        `${event.addedCount} ${event.addedCount === 1 ? "prompt" : "prompts"} added`,
      );
    }
    if (event.removedCount) {
      messages.push(
        `${event.removedCount} ${event.removedCount === 1 ? "prompt" : "prompts"} removed`,
      );
    }
    return messages.join("; ");
  }
  if (event.type === "model_detected") {
    return `${event.model} first detected on ${TRACKING_SOURCE_LABELS[event.trackingSource]}`;
  }
  if (event.type === "capture_provider_detected") {
    return `${CAPTURE_PROVIDER_LABELS[event.captureProvider]} first used for ${TRACKING_SOURCE_LABELS[event.trackingSource]}`;
  }
  const changes: string[] = [];
  if (event.addedSources.length) {
    changes.push(
      `${event.addedSources.map((source) => TRACKING_SOURCE_LABELS[source]).join(", ")} added`,
    );
  }
  if (event.removedSources.length) {
    changes.push(
      `${event.removedSources.map((source) => TRACKING_SOURCE_LABELS[source]).join(", ")} removed`,
    );
  }
  return changes.join("; ");
}

export function chartAnnotationItemDescription(event: ChartAnnotation): string {
  return `${chartAnnotationItemLabel(event)} on ${event.metricDate}`;
}

export function chartAnnotationDescription(
  event: AlignedChartAnnotation,
): string {
  const details = event.sourceEvents.map(chartAnnotationItemDescription);
  const wasShifted = event.sourceEvents.some(
    (source) => source.metricDate !== event.chartDate,
  );
  return `${details.join("; ")}.${
    wasShifted
      ? ` Shown at the next available chart point on ${event.chartDate}.`
      : ""
  }`;
}
