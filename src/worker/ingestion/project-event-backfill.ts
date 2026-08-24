import type { TrackingSource } from "../../shared/tracking-sources";
import {
  TRACKING_SOURCES,
} from "../../shared/tracking-sources";
import {
  promptChangeFromAudit,
  trackingSourceDelta,
} from "../../shared/project-event-helpers";
import { jsonParse, nowIso } from "../lib/http";
import {
  modelDetectedEventStatement,
  projectEventStatement,
} from "../lib/project-events";

// Keep the audit replay in one D1 transaction: at most one event and one
// project-state update per row, plus the global cursor.
const AUDIT_BATCH_SIZE = 40;
const MODEL_BATCH_SIZE = 500;
const MODEL_PROJECTS_PER_TICK = 4;
const STATEMENT_BATCH_SIZE = 100;

interface AuditBackfillState {
  cursor_created_at: string | null;
  cursor_id: string | null;
  completed: number;
}

interface AuditBackfillRow {
  id: string;
  user_id: string | null;
  action:
    | "query.created"
    | "query.bulk_created"
    | "query.purge_requested"
    | "project.tracking_sources_updated";
  resource_id: string | null;
  metadata_json: string;
  created_at: string;
}

interface ProjectBackfillRow {
  project_id: string;
  known_tracking_sources_json: string;
  model_cursor_captured_at: string | null;
  model_cursor_snapshot_id: string | null;
}

interface ModelFactRow {
  snapshot_id: string;
  tracking_source: TrackingSource;
  captured_at: string;
  provider_model: string;
}

export interface ProjectEventBackfillResult {
  auditRows: number;
  modelProjects: number;
  modelSnapshots: number;
  failed: number;
}

function projectIdFromAudit(row: AuditBackfillRow): string | null {
  if (row.action === "project.tracking_sources_updated") {
    return row.resource_id;
  }
  const metadata = jsonParse<Record<string, unknown>>(row.metadata_json, {});
  return typeof metadata.projectId === "string" ? metadata.projectId : null;
}

function sourceList(value: unknown): TrackingSource[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (source): source is TrackingSource =>
      typeof source === "string" &&
      TRACKING_SOURCES.includes(source as TrackingSource),
  ))];
}

async function runStatementBatches(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let index = 0; index < statements.length; index += STATEMENT_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + STATEMENT_BATCH_SIZE));
  }
}

async function backfillAuditEvents(db: D1Database): Promise<{
  rows: number;
  failed: number;
}> {
  const state = await db.prepare(
    `SELECT cursor_created_at, cursor_id, completed
     FROM project_event_audit_backfill WHERE singleton_id = 1`,
  ).first<AuditBackfillState>();
  if (!state || state.completed === 1) return { rows: 0, failed: 0 };

  try {
    const result = await db.prepare(
      `SELECT id, user_id, action, resource_id, metadata_json, created_at
       FROM audit_log
       WHERE action IN (
         'query.created', 'query.bulk_created', 'query.purge_requested',
         'project.tracking_sources_updated'
       )
         AND (
           ? IS NULL OR created_at > ? OR (created_at = ? AND id > ?)
         )
       ORDER BY created_at, id
       LIMIT ?`,
    ).bind(
      state.cursor_created_at,
      state.cursor_created_at,
      state.cursor_created_at,
      state.cursor_id,
      AUDIT_BATCH_SIZE,
    ).all<AuditBackfillRow>();
    const rows = result.results;
    if (!rows.length) {
      await db.prepare(
        `UPDATE project_event_audit_backfill
         SET completed = 1, error_message = NULL, updated_at = ?
         WHERE singleton_id = 1`,
      ).bind(nowIso()).run();
      return { rows: 0, failed: 0 };
    }

    const projectIds = [...new Set(rows.map(projectIdFromAudit).filter(
      (projectId): projectId is string => Boolean(projectId),
    ))];
    const projectStates = projectIds.length
      ? await db.prepare(
          `SELECT project_id, known_tracking_sources_json,
            model_cursor_captured_at, model_cursor_snapshot_id
           FROM project_event_backfill_projects
           WHERE project_id IN (${projectIds.map(() => "?").join(",")})`,
        ).bind(...projectIds).all<ProjectBackfillRow>()
      : { results: [] as ProjectBackfillRow[] };
    const stateByProject = new Map(projectStates.results.map((project) => [
      project.project_id,
      project,
    ]));
    const knownSources = new Map(projectStates.results.map((project) => [
      project.project_id,
      sourceList(jsonParse<unknown>(project.known_tracking_sources_json, [])),
    ]));
    const changedSourceProjects = new Set<string>();
    const statements: D1PreparedStatement[] = [];

    for (const row of rows) {
      const projectId = projectIdFromAudit(row);
      if (!projectId || !stateByProject.has(projectId)) continue;
      if (row.action === "project.tracking_sources_updated") {
        const metadata = jsonParse<Record<string, unknown>>(row.metadata_json, {});
        if (!Array.isArray(metadata.sources)) continue;
        const nextSources = sourceList(metadata.sources);
        const previousSources = knownSources.get(projectId) ?? ["chatgpt"];
        const delta = trackingSourceDelta(previousSources, nextSources);
        knownSources.set(projectId, nextSources);
        changedSourceProjects.add(projectId);
        if (!delta.addedSources.length && !delta.removedSources.length) continue;
        statements.push(projectEventStatement(db, {
          projectId,
          type: "tracking_sources_changed",
          occurredAt: row.created_at,
          payload: delta,
          dedupeKey: `audit:${row.id}`,
          actorUserId: row.user_id,
        }));
        continue;
      }
      const counts = promptChangeFromAudit(row.action, row.metadata_json);
      if (!counts) continue;
      statements.push(projectEventStatement(db, {
        projectId,
        type: "prompt_set_changed",
        occurredAt: row.created_at,
        payload: counts,
        dedupeKey: `audit:${row.id}`,
        actorUserId: row.user_id,
      }));
    }

    const last = rows.at(-1)!;
    const finalStatements: D1PreparedStatement[] = [...changedSourceProjects].map(
      (projectId) => db.prepare(
        `UPDATE project_event_backfill_projects
         SET known_tracking_sources_json = ?, error_message = NULL, updated_at = ?
         WHERE project_id = ?`,
      ).bind(JSON.stringify(knownSources.get(projectId) ?? []), nowIso(), projectId),
    );
    finalStatements.push(db.prepare(
      `UPDATE project_event_audit_backfill
       SET cursor_created_at = ?, cursor_id = ?, completed = ?,
         error_message = NULL, updated_at = ?
       WHERE singleton_id = 1`,
    ).bind(
      last.created_at,
      last.id,
      rows.length < AUDIT_BATCH_SIZE ? 1 : 0,
      nowIso(),
    ));
    await db.batch([...statements, ...finalStatements]);
    return { rows: rows.length, failed: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.prepare(
      `UPDATE project_event_audit_backfill
       SET error_message = ?, updated_at = ? WHERE singleton_id = 1`,
    ).bind(message.slice(0, 1_000), nowIso()).run();
    console.error(JSON.stringify({
      level: "error",
      event: "project_events.audit_backfill_failed",
      error: message,
    }));
    return { rows: 0, failed: 1 };
  }
}

async function backfillProjectModels(
  db: D1Database,
): Promise<{ projects: number; snapshots: number; failed: number }> {
  const candidates = await db.prepare(
    `SELECT state.project_id, state.known_tracking_sources_json,
       state.model_cursor_captured_at, state.model_cursor_snapshot_id
     FROM project_event_backfill_projects state
     JOIN projects project ON project.id = state.project_id
     JOIN analytics_read_model_projects analytics
       ON analytics.project_id = state.project_id
     WHERE state.model_completed = 0
       AND project.deleted_at IS NULL
       AND analytics.status = 'ready'
     ORDER BY state.updated_at, state.project_id
     LIMIT ?`,
  ).bind(MODEL_PROJECTS_PER_TICK).all<ProjectBackfillRow>();

  let snapshots = 0;
  let failed = 0;
  for (const project of candidates.results) {
    try {
      const facts = await db.prepare(
        `SELECT snapshot_id, tracking_source, captured_at, provider_model
         FROM analytics_snapshot_facts
         WHERE project_id = ?
           AND provider_model IS NOT NULL
           AND trim(provider_model) != ''
           AND (
             ? IS NULL OR captured_at > ?
             OR (captured_at = ? AND snapshot_id > ?)
           )
         ORDER BY captured_at, snapshot_id
         LIMIT ?`,
      ).bind(
        project.project_id,
        project.model_cursor_captured_at,
        project.model_cursor_captured_at,
        project.model_cursor_captured_at,
        project.model_cursor_snapshot_id,
        MODEL_BATCH_SIZE,
      ).all<ModelFactRow>();
      snapshots += facts.results.length;
      const statements: D1PreparedStatement[] = [];
      const seen = new Set<string>();
      for (const fact of facts.results) {
        const key = `${fact.tracking_source}:${fact.provider_model.trim().toLocaleLowerCase("en-US")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const event = modelDetectedEventStatement(db, {
          projectId: project.project_id,
          trackingSource: fact.tracking_source,
          model: fact.provider_model,
          occurredAt: fact.captured_at,
        });
        if (event) statements.push(event);
      }
      const last = facts.results.at(-1);
      statements.push(db.prepare(
        `UPDATE project_event_backfill_projects
         SET model_cursor_captured_at = COALESCE(?, model_cursor_captured_at),
           model_cursor_snapshot_id = COALESCE(?, model_cursor_snapshot_id),
           model_completed = ?, error_message = NULL, updated_at = ?
         WHERE project_id = ?`,
      ).bind(
        last?.captured_at ?? null,
        last?.snapshot_id ?? null,
        facts.results.length < MODEL_BATCH_SIZE ? 1 : 0,
        nowIso(),
        project.project_id,
      ));
      await runStatementBatches(db, statements);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await db.prepare(
        `UPDATE project_event_backfill_projects
         SET error_message = ?, updated_at = ? WHERE project_id = ?`,
      ).bind(message.slice(0, 1_000), nowIso(), project.project_id).run();
      console.error(JSON.stringify({
        level: "error",
        event: "project_events.model_backfill_failed",
        projectId: project.project_id,
        error: message,
      }));
    }
  }
  return {
    projects: candidates.results.length,
    snapshots,
    failed,
  };
}

export async function backfillProjectEvents(
  env: Env,
): Promise<ProjectEventBackfillResult> {
  const audit = await backfillAuditEvents(env.CONTROL_DB);
  const models = await backfillProjectModels(env.CONTROL_DB);
  return {
    auditRows: audit.rows,
    modelProjects: models.projects,
    modelSnapshots: models.snapshots,
    failed: audit.failed + models.failed,
  };
}
