import type { ProjectEventType } from "../../shared/project-events";
import type { TrackingSource } from "../../shared/tracking-sources";
import { normalizeProviderModel } from "../../shared/project-event-helpers";
import { nowIso } from "./http";

export interface ProjectEventInput {
  id?: string;
  projectId: string;
  type: ProjectEventType;
  trackingSource?: TrackingSource | null;
  occurredAt: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  actorUserId?: string | null;
}

export function projectEventStatement(
  db: D1Database,
  input: ProjectEventInput,
): D1PreparedStatement {
  const createdAt = nowIso();
  return db.prepare(
    `INSERT INTO project_events (
      id, project_id, event_type, tracking_source, event_date, occurred_at,
      payload_json, origin, actor_user_id, dedupe_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'system', ?, ?, ?, ?)
    ON CONFLICT(project_id, dedupe_key) DO NOTHING`,
  ).bind(
    input.id ?? crypto.randomUUID(),
    input.projectId,
    input.type,
    input.trackingSource ?? null,
    input.occurredAt.slice(0, 10),
    input.occurredAt,
    JSON.stringify(input.payload),
    input.actorUserId ?? null,
    input.dedupeKey,
    createdAt,
    createdAt,
  );
}

export function modelDetectedEventStatement(
  db: D1Database,
  input: {
    projectId: string;
    trackingSource: TrackingSource;
    model: string | null | undefined;
    occurredAt: string;
  },
): D1PreparedStatement | null {
  const model = normalizeProviderModel(input.model);
  if (!model) return null;
  const updatedAt = nowIso();
  return db.prepare(
    `INSERT INTO project_events (
      id, project_id, event_type, tracking_source, event_date, occurred_at,
      payload_json, origin, actor_user_id, dedupe_key, created_at, updated_at
    ) VALUES (?, ?, 'model_detected', ?, ?, ?, ?, 'system', NULL, ?, ?, ?)
    ON CONFLICT(project_id, dedupe_key) DO UPDATE SET
      event_date = CASE
        WHEN excluded.occurred_at < project_events.occurred_at
          THEN excluded.event_date ELSE project_events.event_date END,
      occurred_at = MIN(project_events.occurred_at, excluded.occurred_at),
      payload_json = CASE
        WHEN excluded.occurred_at < project_events.occurred_at
          THEN excluded.payload_json ELSE project_events.payload_json END,
      updated_at = excluded.updated_at`,
  ).bind(
    crypto.randomUUID(),
    input.projectId,
    input.trackingSource,
    input.occurredAt.slice(0, 10),
    input.occurredAt,
    JSON.stringify({ model: model.display, normalizedModel: model.key }),
    `model:${input.trackingSource}:${model.key}`,
    updatedAt,
    updatedAt,
  );
}
