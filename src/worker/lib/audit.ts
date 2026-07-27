import { nowIso } from "./http";

export async function writeAudit(
  db: D1Database,
  input: {
    workspaceId?: string | null;
    userId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (
        id, workspace_id, user_id, action, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.workspaceId ?? null,
      input.userId ?? null,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
      JSON.stringify(input.metadata ?? {}),
      nowIso(),
    )
    .run();
}
