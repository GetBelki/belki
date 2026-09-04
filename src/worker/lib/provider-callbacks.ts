import { nowIso } from "./http";

export type ProviderCallbackClaim = "claimed" | "duplicate" | "conflict";

export async function claimProviderCallback(
  database: D1Database,
  scope: string,
  jobId: string,
  externalTaskId: string,
): Promise<ProviderCallbackClaim> {
  const timestamp = nowIso();
  const inserted = await database.prepare(
    `INSERT OR IGNORE INTO provider_callback_claims (
      scope, job_id, external_task_id, status, claimed_at, updated_at
    ) VALUES (?, ?, ?, 'receiving', ?, ?)`,
  ).bind(scope, jobId, externalTaskId, timestamp, timestamp).run();
  if (inserted.meta.changes === 1) return "claimed";

  const existing = await database.prepare(
    `SELECT external_task_id FROM provider_callback_claims
     WHERE scope = ? AND job_id = ?`,
  ).bind(scope, jobId).first<{ external_task_id: string }>();
  return existing?.external_task_id === externalTaskId ? "duplicate" : "conflict";
}

export async function releaseProviderCallbackClaim(
  database: D1Database,
  scope: string,
  jobId: string,
  externalTaskId: string,
): Promise<void> {
  await database.prepare(
    `DELETE FROM provider_callback_claims
     WHERE scope = ? AND job_id = ? AND external_task_id = ?`,
  ).bind(scope, jobId, externalTaskId).run();
}

export function acceptProviderCallbackClaim(
  database: D1Database,
  scope: string,
  jobId: string,
  externalTaskId: string,
  rawR2Key: string,
): D1PreparedStatement {
  return database.prepare(
    `UPDATE provider_callback_claims SET status = 'accepted', r2_key = ?, updated_at = ?
     WHERE scope = ? AND job_id = ? AND external_task_id = ? AND status = 'receiving'`,
  ).bind(rawR2Key, nowIso(), scope, jobId, externalTaskId);
}
