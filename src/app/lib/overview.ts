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

export interface PromptSetEvent {
  metric_date: string;
  addedCount: number;
  removedCount: number;
}

export interface AlignedPromptSetEvent extends PromptSetEvent {
  chartDate: string;
  label: string;
  sourceEvents: PromptSetEvent[];
}

function positiveInteger(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function promptSetEventLabel(
  event: Pick<PromptSetEvent, "addedCount" | "removedCount">,
): string {
  const added = positiveInteger(event.addedCount);
  const removed = positiveInteger(event.removedCount);
  if (added && removed) return `+${added} / −${removed}`;
  if (added) return `+${added} ${added === 1 ? "prompt" : "prompts"}`;
  if (removed) return `−${removed} ${removed === 1 ? "prompt" : "prompts"}`;
  return "";
}

export function alignPromptSetEvents(
  events: readonly PromptSetEvent[],
  chartDates: readonly string[],
): AlignedPromptSetEvent[] {
  const dates = [...new Set(chartDates)]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date))
    .sort();
  const alignedByDate = new Map<string, AlignedPromptSetEvent>();

  for (const source of [...events].sort((left, right) =>
    left.metric_date.localeCompare(right.metric_date),
  )) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(source.metric_date)) continue;
    const addedCount = positiveInteger(source.addedCount);
    const removedCount = positiveInteger(source.removedCount);
    if (!addedCount && !removedCount) continue;
    const chartDate = dates.find((date) => date >= source.metric_date);
    if (!chartDate) continue;
    const sourceEvent = {
      metric_date: source.metric_date,
      addedCount,
      removedCount,
    };
    const existing = alignedByDate.get(chartDate);
    if (existing) {
      existing.addedCount += addedCount;
      existing.removedCount += removedCount;
      existing.sourceEvents.push(sourceEvent);
      existing.label = promptSetEventLabel(existing);
    } else {
      alignedByDate.set(chartDate, {
        ...sourceEvent,
        chartDate,
        label: promptSetEventLabel(sourceEvent),
        sourceEvents: [sourceEvent],
      });
    }
  }

  return [...alignedByDate.values()];
}

export function promptSetEventDescription(
  event: AlignedPromptSetEvent,
): string {
  const details = event.sourceEvents.flatMap((source) => {
    const messages: string[] = [];
    if (source.addedCount) {
      messages.push(
        `${source.addedCount} ${source.addedCount === 1 ? "prompt" : "prompts"} added on ${source.metric_date}`,
      );
    }
    if (source.removedCount) {
      messages.push(
        `${source.removedCount} ${source.removedCount === 1 ? "prompt" : "prompts"} removed on ${source.metric_date}`,
      );
    }
    return messages;
  });
  const wasShifted = event.sourceEvents.some(
    (source) => source.metric_date !== event.chartDate,
  );
  return `${details.join("; ")}.${
    wasShifted
      ? ` Shown at the next available chart point on ${event.chartDate}.`
      : ""
  }`;
}
