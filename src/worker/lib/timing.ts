export interface RequestTimingEntry {
  name: string;
  durationMs: number;
  description?: string;
}

interface D1ResultLike {
  meta: {
    duration: number;
    rows_read: number;
    rows_written: number;
    served_by_region?: string;
    served_by_colo?: string;
    served_by_primary?: boolean;
    total_attempts?: number;
  };
}

export interface D1TimingRecord {
  calls: number;
  durationMs: number;
  rowsRead: number;
  rowsWritten: number;
  primaryCalls: number;
  retryAttempts: number;
  regions: string[];
  colos: string[];
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
  private readonly d1 = {
    calls: 0,
    durationMs: 0,
    rowsRead: 0,
    rowsWritten: 0,
    primaryCalls: 0,
    retryAttempts: 0,
    regions: new Set<string>(),
    colos: new Set<string>(),
  };

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

  async measureD1<T extends D1ResultLike | D1ResultLike[]>(
    name: string,
    operation: () => Promise<T>,
    description?: string,
  ): Promise<T> {
    const result = await this.measure(name, operation, description);
    this.recordD1(result);
    return result;
  }

  recordD1(result: D1ResultLike | D1ResultLike[]): void {
    for (const value of Array.isArray(result) ? result : [result]) {
      const meta = value.meta;
      this.d1.calls += 1;
      this.d1.durationMs += Number(meta.duration) || 0;
      this.d1.rowsRead += Number(meta.rows_read) || 0;
      this.d1.rowsWritten += Number(meta.rows_written) || 0;
      this.d1.primaryCalls += meta.served_by_primary ? 1 : 0;
      this.d1.retryAttempts += Math.max(0, Number(meta.total_attempts ?? 1) - 1);
      if (meta.served_by_region) this.d1.regions.add(meta.served_by_region);
      if (meta.served_by_colo) this.d1.colos.add(meta.served_by_colo);
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

  toD1LogRecord(): D1TimingRecord {
    return {
      calls: this.d1.calls,
      durationMs: Number(this.d1.durationMs.toFixed(1)),
      rowsRead: this.d1.rowsRead,
      rowsWritten: this.d1.rowsWritten,
      primaryCalls: this.d1.primaryCalls,
      retryAttempts: this.d1.retryAttempts,
      regions: [...this.d1.regions].sort(),
      colos: [...this.d1.colos].sort(),
    };
  }
}
