import { nowIso } from "../lib/http";

export const SOURCE_DISCOVERY_WINDOW_DAYS = 31;
export const SOURCE_DISCOVERY_WINDOWS_PER_RUN = 12;

interface SourceDiscoveryStateRow {
  status: "pending" | "backfilling" | "ready";
  cursor_date: string | null;
  through_date: string | null;
}

export interface SourceDiscoveryBackfillResult {
  days: number;
  ready: number;
  failed: number;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function sourceDiscoveryBackfillEstimatedMinutes(
  cursorDate: string | null,
  throughDate: string | null,
): number {
  if (!cursorDate || !throughDate || cursorDate > throughDate) return 0;
  const cursor = Date.parse(`${cursorDate}T00:00:00.000Z`);
  const through = Date.parse(`${throughDate}T00:00:00.000Z`);
  const remainingDays = Math.floor((through - cursor) / 86_400_000) + 1;
  const daysPerRun = SOURCE_DISCOVERY_WINDOW_DAYS
    * SOURCE_DISCOVERY_WINDOWS_PER_RUN;
  return Math.max(1, Math.ceil(remainingDays / daysPerRun));
}

export async function syncSourceDiscoveryFirstSeen(
  db: D1Database,
  snapshotId: string,
): Promise<void> {
  const updatedAt = nowIso();
  await db.batch([
    db.prepare(
      `INSERT INTO analytics_citation_url_first_seen (
        tracking_source, canonical_url, registrable_domain,
        first_seen_at, first_seen_date, updated_at
      )
      SELECT fact.tracking_source, citation.canonical_url,
        MIN(citation.registrable_domain), MIN(citation.captured_at),
        substr(MIN(citation.captured_at), 1, 10), ?
      FROM analytics_snapshot_facts fact
      JOIN analytics_citation_occurrences citation
        ON citation.snapshot_id = fact.snapshot_id
      WHERE fact.snapshot_id = ?
        AND citation.canonical_url IS NOT NULL
      GROUP BY fact.tracking_source, citation.canonical_url
      HAVING MIN(citation.registrable_domain) IS NOT NULL
      ON CONFLICT(tracking_source, canonical_url) DO UPDATE SET
        registrable_domain = CASE
          WHEN excluded.first_seen_at < first_seen_at
            THEN excluded.registrable_domain
          ELSE registrable_domain
        END,
        first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
        first_seen_date = MIN(first_seen_date, excluded.first_seen_date),
        updated_at = excluded.updated_at`,
    ).bind(updatedAt, snapshotId),
    db.prepare(
      `INSERT INTO analytics_citation_domain_first_seen (
        tracking_source, registrable_domain,
        first_seen_at, first_seen_date, updated_at
      )
      SELECT fact.tracking_source, citation.registrable_domain,
        MIN(citation.captured_at), substr(MIN(citation.captured_at), 1, 10), ?
      FROM analytics_snapshot_facts fact
      JOIN analytics_citation_occurrences citation
        ON citation.snapshot_id = fact.snapshot_id
      WHERE fact.snapshot_id = ?
        AND citation.registrable_domain IS NOT NULL
      GROUP BY fact.tracking_source, citation.registrable_domain
      ON CONFLICT(tracking_source, registrable_domain) DO UPDATE SET
        first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
        first_seen_date = MIN(first_seen_date, excluded.first_seen_date),
        updated_at = excluded.updated_at`,
    ).bind(updatedAt, snapshotId),
  ]);
}

function firstSeenWindowStatements(
  db: D1Database,
  from: string,
  toExclusive: string,
  updatedAt: string,
): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT INTO analytics_citation_url_first_seen (
        tracking_source, canonical_url, registrable_domain,
        first_seen_at, first_seen_date, updated_at
      )
      SELECT fact.tracking_source, citation.canonical_url,
        MIN(citation.registrable_domain), MIN(citation.captured_at),
        substr(MIN(citation.captured_at), 1, 10), ?
      FROM analytics_snapshot_facts fact
      JOIN analytics_citation_occurrences citation
        ON citation.snapshot_id = fact.snapshot_id
      JOIN projects project
        ON project.id = fact.project_id AND project.deleted_at IS NULL
      JOIN workspaces workspace
        ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
      WHERE fact.metric_date >= ? AND fact.metric_date < ?
        AND citation.canonical_url IS NOT NULL
      GROUP BY fact.tracking_source, citation.canonical_url
      HAVING MIN(citation.registrable_domain) IS NOT NULL
      ON CONFLICT(tracking_source, canonical_url) DO UPDATE SET
        registrable_domain = CASE
          WHEN excluded.first_seen_at < first_seen_at
            THEN excluded.registrable_domain
          ELSE registrable_domain
        END,
        first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
        first_seen_date = MIN(first_seen_date, excluded.first_seen_date),
        updated_at = excluded.updated_at`,
    ).bind(updatedAt, from, toExclusive),
    db.prepare(
      `INSERT INTO analytics_citation_domain_first_seen (
        tracking_source, registrable_domain,
        first_seen_at, first_seen_date, updated_at
      )
      SELECT fact.tracking_source, citation.registrable_domain,
        MIN(citation.captured_at), substr(MIN(citation.captured_at), 1, 10), ?
      FROM analytics_snapshot_facts fact
      JOIN analytics_citation_occurrences citation
        ON citation.snapshot_id = fact.snapshot_id
      JOIN projects project
        ON project.id = fact.project_id AND project.deleted_at IS NULL
      JOIN workspaces workspace
        ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
      WHERE fact.metric_date >= ? AND fact.metric_date < ?
        AND citation.registrable_domain IS NOT NULL
      GROUP BY fact.tracking_source, citation.registrable_domain
      ON CONFLICT(tracking_source, registrable_domain) DO UPDATE SET
        first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
        first_seen_date = MIN(first_seen_date, excluded.first_seen_date),
        updated_at = excluded.updated_at`,
    ).bind(updatedAt, from, toExclusive),
  ];
}

export async function backfillSourceDiscoveryFirstSeen(
  env: Env,
): Promise<SourceDiscoveryBackfillResult> {
  const db = env.CONTROL_DB;
  let state = await db.prepare(
    `SELECT status, cursor_date, through_date
     FROM source_discovery_backfill WHERE singleton_id = 1`,
  ).first<SourceDiscoveryStateRow>();
  if (state?.status === "ready") return { days: 0, ready: 1, failed: 0 };

  const updatedAt = nowIso();
  if (!state?.cursor_date || !state.through_date) {
    const bounds = await db.prepare(
      `SELECT MIN(fact.metric_date) AS first_date,
        MAX(fact.metric_date) AS last_date
       FROM analytics_snapshot_facts fact
       JOIN projects project
         ON project.id = fact.project_id AND project.deleted_at IS NULL
       JOIN workspaces workspace
         ON workspace.id = project.workspace_id AND workspace.status != 'deleted'
       WHERE fact.citation_count > 0`,
    ).first<{ first_date: string | null; last_date: string | null }>();
    if (!bounds?.first_date || !bounds.last_date) {
      await db.prepare(
        `UPDATE source_discovery_backfill
         SET status = 'ready', cursor_date = NULL, through_date = NULL,
           error_message = NULL, updated_at = ?
         WHERE singleton_id = 1`,
      ).bind(updatedAt).run();
      return { days: 0, ready: 1, failed: 0 };
    }
    await db.prepare(
      `UPDATE source_discovery_backfill
       SET status = 'backfilling', cursor_date = ?, through_date = ?,
         error_message = NULL, updated_at = ?
       WHERE singleton_id = 1`,
    ).bind(bounds.first_date, bounds.last_date, updatedAt).run();
    state = {
      status: "backfilling",
      cursor_date: bounds.first_date,
      through_date: bounds.last_date,
    };
  }

  let cursor = state.cursor_date;
  const through = state.through_date;
  if (!cursor || !through) return { days: 0, ready: 0, failed: 1 };

  try {
    let processedDays = 0;
    for (
      let window = 0;
      window < SOURCE_DISCOVERY_WINDOWS_PER_RUN && cursor <= through;
      window += 1
    ) {
      const toExclusive = addUtcDays(cursor, SOURCE_DISCOVERY_WINDOW_DAYS);
      await db.batch(firstSeenWindowStatements(db, cursor, toExclusive, updatedAt));
      processedDays += SOURCE_DISCOVERY_WINDOW_DAYS;
      cursor = toExclusive;
    }
    const ready = cursor > through;
    await db.prepare(
      `UPDATE source_discovery_backfill
       SET status = ?, cursor_date = ?, error_message = NULL, updated_at = ?
       WHERE singleton_id = 1`,
    ).bind(ready ? "ready" : "backfilling", cursor, nowIso()).run();
    return { days: processedDays, ready: ready ? 1 : 0, failed: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.prepare(
      `UPDATE source_discovery_backfill
       SET status = 'pending', error_message = ?, updated_at = ?
       WHERE singleton_id = 1`,
    ).bind(message.slice(0, 1_000), nowIso()).run();
    console.error(JSON.stringify({
      level: "error",
      event: "source_discovery.backfill_failed",
      error: message,
    }));
    return { days: 0, ready: 0, failed: 1 };
  }
}
