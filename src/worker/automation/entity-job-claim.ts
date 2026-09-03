interface EntityJobClaimResult {
  meta: { changes: number };
}

interface EntityJobClaimStatement {
  bind(...values: unknown[]): EntityJobClaimStatement;
  run(): Promise<EntityJobClaimResult>;
}

interface EntityJobClaimDatabase {
  prepare(query: string): EntityJobClaimStatement;
}

export async function claimEntityExtractionJob(
  db: EntityJobClaimDatabase,
  jobId: string,
  timestamp: string,
): Promise<boolean> {
  const claimed = await db.prepare(
    `UPDATE entity_extraction_jobs SET status = 'processing', attempts = attempts + 1,
      started_at = COALESCE(started_at, ?), error_message = NULL, updated_at = ?
     WHERE id = ? AND status IN ('queued', 'failed')`,
  ).bind(timestamp, timestamp, jobId).run();
  return claimed.meta.changes === 1;
}
