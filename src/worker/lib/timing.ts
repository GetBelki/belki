export interface RequestTimingEntry {
  name: string;
  durationMs: number;
  description?: string;
}

function timingToken(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.slice(0, 48) || "step";
}

function timingDescription(value: string): string {
  return value.replace(/["\\\r\n]/gu, " ").trim().slice(0, 120);
}

export class RequestTiming {
  readonly startedAt = performance.now();
  readonly entries: RequestTimingEntry[] = [];

  async measure<T>(
    name: string,
    operation: () => Promise<T>,
    description?: string,
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.add(name, performance.now() - startedAt, description);
    }
  }

  add(name: string, durationMs: number, description?: string): void {
    this.entries.push({
      name: timingToken(name),
      durationMs: Math.max(0, durationMs),
      ...(description ? { description: timingDescription(description) } : {}),
    });
  }

  totalMs(): number {
    return Math.max(0, performance.now() - this.startedAt);
  }

  toServerTiming(): string {
    const grouped = new Map<string, RequestTimingEntry>();
    for (const entry of this.entries) {
      const existing = grouped.get(entry.name);
      grouped.set(entry.name, {
        name: entry.name,
        durationMs: (existing?.durationMs ?? 0) + entry.durationMs,
        description: existing?.description ?? entry.description,
      });
    }
    const entries = [
      ...grouped.values(),
      { name: "total", durationMs: this.totalMs() },
    ];
    return entries
      .map((entry) => {
        const description = entry.description
          ? `;desc="${timingDescription(entry.description)}"`
          : "";
        return `${timingToken(entry.name)};dur=${entry.durationMs.toFixed(1)}${description}`;
      })
      .join(", ");
  }

  toLogRecord(): Record<string, number> {
    const record: Record<string, number> = {};
    for (const entry of this.entries) {
      record[entry.name] = Number(
        ((record[entry.name] ?? 0) + entry.durationMs).toFixed(1),
      );
    }
    record.total = Number(this.totalMs().toFixed(1));
    return record;
  }
}
