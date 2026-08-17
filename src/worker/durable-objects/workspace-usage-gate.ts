import { DurableObject } from "cloudflare:workers";
import type {
  PlanKey,
  SubscriptionStatus,
  UsageSku,
  WorkspaceStatus,
} from "../../shared/contracts";

export interface UsageEntitlement {
  planKey: PlanKey;
  subscriptionStatus: SubscriptionStatus;
  workspaceStatus: WorkspaceStatus;
  allowance: number;
  projectLimit: number;
  promptLimit: number;
  sourceLimit: number;
  cycleStartedAt: string;
  cycleEndsAt: string;
  readOnlyUntil: string | null;
}

export interface UsageReservationInput {
  reservationId: string;
  sku: UsageSku;
  units: number;
  resourceType: string;
  resourceId: string;
}

export interface UsageReservationResult {
  reservationId: string;
  status: "reserved" | "committed" | "released";
  units: number;
  used: number;
  reserved: number;
  remaining: number;
  cycleStartedAt: string;
}

export interface UsageSummary extends UsageEntitlement {
  committed: number;
  reserved: number;
  remaining: number;
  projectCount: number;
  promptCount: number;
}

interface EntitlementRow extends Record<string, SqlStorageValue> {
  plan_key: PlanKey;
  subscription_status: SubscriptionStatus;
  workspace_status: WorkspaceStatus;
  allowance: number;
  project_limit: number;
  prompt_limit: number;
  source_limit: number;
  cycle_started_at: string;
  cycle_ends_at: string;
  read_only_until: string | null;
  project_count: number;
  prompt_count: number;
}

interface ReservationRow extends Record<string, SqlStorageValue> {
  reservation_id: string;
  status: "reserved" | "committed" | "released";
  units: number;
}

export class WorkspaceUsageGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS entitlement (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          plan_key TEXT NOT NULL,
          subscription_status TEXT NOT NULL,
          workspace_status TEXT NOT NULL,
          allowance INTEGER NOT NULL,
          project_limit INTEGER NOT NULL,
          prompt_limit INTEGER NOT NULL DEFAULT 1000000,
          source_limit INTEGER NOT NULL DEFAULT 4,
          cycle_started_at TEXT NOT NULL,
          cycle_ends_at TEXT NOT NULL,
          read_only_until TEXT,
          project_count INTEGER NOT NULL DEFAULT 0,
          prompt_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS reservations (
          reservation_id TEXT PRIMARY KEY,
          sku TEXT NOT NULL,
          units INTEGER NOT NULL CHECK (units > 0),
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
          cycle_started_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS reservations_cycle_status_idx
          ON reservations(cycle_started_at, status);
      `);
      const columns = new Set(
        this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(entitlement)")
          .toArray().map((column) => column.name),
      );
      if (!columns.has("prompt_limit")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE entitlement ADD COLUMN prompt_limit INTEGER NOT NULL DEFAULT 1000000",
        );
      }
      if (!columns.has("source_limit")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE entitlement ADD COLUMN source_limit INTEGER NOT NULL DEFAULT 4",
        );
      }
      if (!columns.has("prompt_count")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE entitlement ADD COLUMN prompt_count INTEGER NOT NULL DEFAULT 0",
        );
      }
      await this.ctx.storage.put("schema_version", 2);
    });
  }

  setEntitlement(input: UsageEntitlement): UsageSummary {
    const previous = this.entitlement();
    const projectCount = previous?.project_count ?? 0;
    const promptCount = previous?.prompt_count ?? 0;
    this.ctx.storage.sql.exec(
      `INSERT INTO entitlement (
        singleton, plan_key, subscription_status, workspace_status, allowance,
        project_limit, prompt_limit, source_limit, cycle_started_at, cycle_ends_at,
        read_only_until, project_count, prompt_count
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        plan_key = excluded.plan_key,
        subscription_status = excluded.subscription_status,
        workspace_status = excluded.workspace_status,
        allowance = excluded.allowance,
        project_limit = excluded.project_limit,
        prompt_limit = excluded.prompt_limit,
        source_limit = excluded.source_limit,
        cycle_started_at = excluded.cycle_started_at,
        cycle_ends_at = excluded.cycle_ends_at,
        read_only_until = excluded.read_only_until`,
      input.planKey,
      input.subscriptionStatus,
      input.workspaceStatus,
      input.allowance,
      input.projectLimit,
      input.promptLimit,
      input.sourceLimit,
      input.cycleStartedAt,
      input.cycleEndsAt,
      input.readOnlyUntil,
      projectCount,
      promptCount,
    );
    return this.summary();
  }

  reserve(input: UsageReservationInput): UsageReservationResult {
    if (!Number.isInteger(input.units) || input.units <= 0) throw new Error("invalid_usage_units");
    const entitlement = this.requireEntitlement();
    this.assertWritable(entitlement);
    const existing = this.ctx.storage.sql.exec<ReservationRow>(
      "SELECT reservation_id, status, units FROM reservations WHERE reservation_id = ?",
      input.reservationId,
    ).toArray()[0];
    if (existing) {
      if (existing.units !== input.units) throw new Error("reservation_conflict");
      return this.result(existing.reservation_id, existing.status, existing.units, entitlement);
    }
    const totals = this.totals(entitlement.cycle_started_at);
    if (totals.committed + totals.reserved + input.units > entitlement.allowance) {
      throw new Error("usage_limit");
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO reservations (
        reservation_id, sku, units, resource_type, resource_id, status,
        cycle_started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      input.reservationId,
      input.sku,
      input.units,
      input.resourceType,
      input.resourceId,
      entitlement.cycle_started_at,
      now,
      now,
    );
    return this.result(input.reservationId, "reserved", input.units, entitlement);
  }

  reserveBatch(inputs: UsageReservationInput[]): UsageReservationResult[] {
    const results: UsageReservationResult[] = [];
    for (const input of inputs) results.push(this.reserve(input));
    return results;
  }

  commit(reservationId: string): UsageReservationResult {
    return this.transition(reservationId, "committed");
  }

  release(reservationId: string): UsageReservationResult {
    return this.transition(reservationId, "released");
  }

  getSummary(): UsageSummary {
    return this.summary();
  }

  syncProjectCount(count: number): UsageSummary {
    if (!Number.isInteger(count) || count < 0) throw new Error("invalid_project_count");
    this.requireEntitlement();
    this.ctx.storage.sql.exec("UPDATE entitlement SET project_count = ? WHERE singleton = 1", count);
    return this.summary();
  }

  syncPromptCount(count: number): UsageSummary {
    if (!Number.isInteger(count) || count < 0) throw new Error("invalid_prompt_count");
    this.requireEntitlement();
    this.ctx.storage.sql.exec("UPDATE entitlement SET prompt_count = ? WHERE singleton = 1", count);
    return this.summary();
  }

  claimPrompts(count = 1): UsageSummary {
    if (!Number.isInteger(count) || count <= 0) throw new Error("invalid_prompt_count");
    const entitlement = this.requireEntitlement();
    this.assertWritable(entitlement);
    if (entitlement.prompt_count + count > entitlement.prompt_limit) throw new Error("prompt_limit");
    this.ctx.storage.sql.exec(
      "UPDATE entitlement SET prompt_count = prompt_count + ? WHERE singleton = 1",
      count,
    );
    return this.summary();
  }

  releasePrompts(count = 1): UsageSummary {
    if (!Number.isInteger(count) || count <= 0) throw new Error("invalid_prompt_count");
    this.requireEntitlement();
    this.ctx.storage.sql.exec(
      "UPDATE entitlement SET prompt_count = MAX(0, prompt_count - ?) WHERE singleton = 1",
      count,
    );
    return this.summary();
  }

  claimProject(): UsageSummary {
    const entitlement = this.requireEntitlement();
    this.assertWritable(entitlement);
    if (entitlement.project_count >= entitlement.project_limit) throw new Error("project_limit");
    this.ctx.storage.sql.exec(
      "UPDATE entitlement SET project_count = project_count + 1 WHERE singleton = 1",
    );
    return this.summary();
  }

  releaseProject(): UsageSummary {
    this.requireEntitlement();
    this.ctx.storage.sql.exec(
      "UPDATE entitlement SET project_count = MAX(0, project_count - 1) WHERE singleton = 1",
    );
    return this.summary();
  }

  private transition(
    reservationId: string,
    target: "committed" | "released",
  ): UsageReservationResult {
    const entitlement = this.requireEntitlement();
    const row = this.ctx.storage.sql.exec<ReservationRow>(
      "SELECT reservation_id, status, units FROM reservations WHERE reservation_id = ?",
      reservationId,
    ).toArray()[0];
    if (!row) throw new Error("reservation_not_found");
    if (row.status === "reserved") {
      this.ctx.storage.sql.exec(
        "UPDATE reservations SET status = ?, updated_at = ? WHERE reservation_id = ?",
        target,
        new Date().toISOString(),
        reservationId,
      );
      row.status = target;
    } else if (row.status !== target) {
      throw new Error("reservation_already_finalized");
    }
    return this.result(row.reservation_id, row.status, row.units, entitlement);
  }

  private entitlement(): EntitlementRow | null {
    return this.ctx.storage.sql.exec<EntitlementRow>(
      `SELECT plan_key, subscription_status, workspace_status, allowance, project_limit,
        prompt_limit, source_limit, cycle_started_at, cycle_ends_at, read_only_until,
        project_count, prompt_count
       FROM entitlement WHERE singleton = 1`,
    ).toArray()[0] ?? null;
  }

  private requireEntitlement(): EntitlementRow {
    const row = this.entitlement();
    if (!row) throw new Error("entitlement_not_configured");
    return row;
  }

  private assertWritable(row: EntitlementRow): void {
    if (row.workspace_status !== "active") throw new Error("workspace_read_only");
    if (!["active", "trialing"].includes(row.subscription_status)) {
      throw new Error("payment_required");
    }
    const now = Date.now();
    if (Date.parse(row.cycle_started_at) > now || Date.parse(row.cycle_ends_at) <= now) {
      throw new Error("billing_cycle_inactive");
    }
  }

  private totals(cycleStartedAt: string): { committed: number; reserved: number } {
    const rows = this.ctx.storage.sql.exec<{ status: string; units: number }>(
      `SELECT status, COALESCE(SUM(units), 0) AS units
       FROM reservations WHERE cycle_started_at = ? AND status != 'released'
       GROUP BY status`,
      cycleStartedAt,
    ).toArray();
    return {
      committed: Number(rows.find((row) => row.status === "committed")?.units ?? 0),
      reserved: Number(rows.find((row) => row.status === "reserved")?.units ?? 0),
    };
  }

  private result(
    reservationId: string,
    status: "reserved" | "committed" | "released",
    units: number,
    entitlement: EntitlementRow,
  ): UsageReservationResult {
    const totals = this.totals(entitlement.cycle_started_at);
    return {
      reservationId,
      status,
      units,
      used: totals.committed,
      reserved: totals.reserved,
      remaining: Math.max(0, entitlement.allowance - totals.committed - totals.reserved),
      cycleStartedAt: entitlement.cycle_started_at,
    };
  }

  private summary(row = this.requireEntitlement()): UsageSummary {
    const totals = this.totals(row.cycle_started_at);
    return {
      planKey: row.plan_key,
      subscriptionStatus: row.subscription_status,
      workspaceStatus: row.workspace_status,
      allowance: row.allowance,
      projectLimit: row.project_limit,
      promptLimit: row.prompt_limit,
      sourceLimit: row.source_limit,
      cycleStartedAt: row.cycle_started_at,
      cycleEndsAt: row.cycle_ends_at,
      readOnlyUntil: row.read_only_until,
      projectCount: row.project_count,
      promptCount: row.prompt_count,
      committed: totals.committed,
      reserved: totals.reserved,
      remaining: Math.max(0, row.allowance - totals.committed - totals.reserved),
    };
  }
}
