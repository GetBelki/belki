import { nowIso } from "./http";

export interface AuditInput {
  id?: string;
  createdAt?: string;
  workspaceId?: string | null;
  userId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PreparedAudit {
  id: string;
  createdAt: string;
  statement: D1PreparedStatement;
}

export function prepareAudit(
  db: D1Database,
  input: AuditInput,
): PreparedAudit {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? nowIso();
  return {
    id,
    createdAt,
    statement: db
      .prepare(
        `INSERT INTO audit_log (
          id, workspace_id, user_id, action, resource_type, resource_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.workspaceId ?? null,
        input.userId ?? null,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        JSON.stringify(input.metadata ?? {}),
        createdAt,
      ),
  };
}

export async function writeAudit(
  db: D1Database,
  input: AuditInput,
): Promise<void> {
  await prepareAudit(db, input).statement.run();
}
