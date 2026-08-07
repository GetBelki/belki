export async function promptPurgeRequested(
  db: D1Database,
  trackedQueryId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM prompt_purge_jobs WHERE tracked_query_id = ?")
    .bind(trackedQueryId)
    .first<{ found: number }>();
  return Boolean(row);
}
