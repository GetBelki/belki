import { describe, expect, it } from "vitest";
import { preserveBrandMetricsHistory } from "../src/worker/lib/brand-metrics-state";

describe("brand metrics configuration changes", () => {
  it("preserves an existing ready read model and its revision", async () => {
    const statements: Array<{ bindings: unknown[]; sql: string }> = [];
    const db = {
      prepare(sql: string) {
        const statement = { bindings: [] as unknown[], sql };
        statements.push(statement);
        return {
          bind(...bindings: unknown[]) {
            statement.bindings = bindings;
            return this;
          },
          run() {
            return Promise.resolve({ success: true });
          },
        };
      },
    } as unknown as D1Database;

    await preserveBrandMetricsHistory(db, "project-1");

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/ON CONFLICT\(project_id\) DO NOTHING/i);
    expect(statements[0]?.sql).not.toMatch(/UPDATE projects/i);
    expect(statements[0]?.sql).not.toMatch(/DO UPDATE SET\s+status/i);
    expect(statements[0]?.bindings[0]).toBe("project-1");
  });
});
