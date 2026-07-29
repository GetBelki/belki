import {
  MAX_PROJECT_TAGS,
  MAX_PROMPT_TAGS,
  promptTagColorIndex,
  promptTagKey,
  uniquePromptTagNames,
} from "../../shared/prompt-tags";
import { ApiError } from "./http";

export interface PromptTagRecord {
  id: string;
  name: string;
  normalized_name: string;
  color_index: number;
}

interface ResolvedPromptTags {
  tags: PromptTagRecord[];
  missing: PromptTagRecord[];
}

export async function resolvePromptTags(
  db: D1Database,
  projectId: string,
  names: string[],
): Promise<ResolvedPromptTags> {
  const requested = uniquePromptTagNames(names);
  if (!requested.length) return { tags: [], missing: [] };
  const catalog = await db
    .prepare(
      `SELECT id, name, normalized_name, color_index
       FROM prompt_tags WHERE project_id = ?`,
    )
    .bind(projectId)
    .all<PromptTagRecord>();
  const byName = new Map(catalog.results.map((tag) => [tag.normalized_name, tag]));
  const missing = requested
    .filter((name) => !byName.has(promptTagKey(name)))
    .map((name) => ({
      id: crypto.randomUUID(),
      name,
      normalized_name: promptTagKey(name),
      color_index: promptTagColorIndex(name),
    }));
  if (catalog.results.length + missing.length > MAX_PROJECT_TAGS) {
    throw new ApiError(
      409,
      "prompt_tag_limit_reached",
      `Projects can have up to ${MAX_PROJECT_TAGS} prompt tags.`,
    );
  }
  return {
    missing,
    tags: requested.map(
      (name) =>
        byName.get(promptTagKey(name)) ??
        missing.find((tag) => tag.normalized_name === promptTagKey(name))!,
    ),
  };
}

export async function promptTagAssignments(
  db: D1Database,
  projectId: string,
  queryIds: string[],
): Promise<Map<string, Set<string>>> {
  const uniqueIds = [...new Set(queryIds)];
  if (!uniqueIds.length) return new Map();
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT q.id AS query_id, t.normalized_name
       FROM tracked_queries q
       LEFT JOIN tracked_query_tags qt ON qt.tracked_query_id = q.id
       LEFT JOIN prompt_tags t ON t.id = qt.tag_id
       WHERE q.project_id = ? AND q.deleted_at IS NULL
         AND q.id IN (${placeholders})`,
    )
    .bind(projectId, ...uniqueIds)
    .all<{ query_id: string; normalized_name: string | null }>();
  const assignments = new Map<string, Set<string>>();
  for (const row of rows.results) {
    const tags = assignments.get(row.query_id) ?? new Set<string>();
    if (row.normalized_name) tags.add(row.normalized_name);
    assignments.set(row.query_id, tags);
  }
  if (assignments.size !== uniqueIds.length) {
    throw new ApiError(404, "query_not_found", "One or more prompts were not found.");
  }
  return assignments;
}

export function assertPromptTagCapacity(
  assignments: Map<string, Set<string>>,
  tags: PromptTagRecord[],
): void {
  for (const assigned of assignments.values()) {
    const combined = new Set(assigned);
    for (const tag of tags) combined.add(tag.normalized_name);
    if (combined.size > MAX_PROMPT_TAGS) {
      throw new ApiError(
        409,
        "prompt_tag_limit_reached",
        `Prompts can have up to ${MAX_PROMPT_TAGS} tags.`,
      );
    }
  }
}

export function insertPromptTagStatements(
  db: D1Database,
  projectId: string,
  tags: PromptTagRecord[],
  now: string,
): D1PreparedStatement[] {
  return tags.map((tag) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO prompt_tags (
          id, project_id, name, normalized_name, color_index, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tag.id,
        projectId,
        tag.name,
        tag.normalized_name,
        tag.color_index,
        now,
        now,
      ),
  );
}

export function assignPromptTagStatements(
  db: D1Database,
  projectId: string,
  queryIds: string[],
  tags: PromptTagRecord[],
  now: string,
): D1PreparedStatement[] {
  const uniqueIds = [...new Set(queryIds)];
  if (!uniqueIds.length || !tags.length) return [];
  const queryPlaceholders = uniqueIds.map(() => "?").join(",");
  const tagNames = tags.map((tag) => tag.normalized_name);
  const tagPlaceholders = tagNames.map(() => "?").join(",");
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO tracked_query_tags (
          tracked_query_id, tag_id, created_at
        )
        SELECT q.id, t.id, ?
        FROM tracked_queries q
        CROSS JOIN prompt_tags t
        WHERE q.project_id = ? AND q.deleted_at IS NULL
          AND q.id IN (${queryPlaceholders})
          AND t.project_id = ?
          AND t.normalized_name IN (${tagPlaceholders})`,
      )
      .bind(now, projectId, ...uniqueIds, projectId, ...tagNames),
  ];
}

export function removePromptTagStatements(
  db: D1Database,
  projectId: string,
  queryIds: string[],
  tagNames: string[],
): D1PreparedStatement[] {
  const uniqueIds = [...new Set(queryIds)];
  const normalized = uniquePromptTagNames(tagNames).map(promptTagKey);
  if (!uniqueIds.length || !normalized.length) return [];
  const queryPlaceholders = uniqueIds.map(() => "?").join(",");
  const tagPlaceholders = normalized.map(() => "?").join(",");
  return [
    db
      .prepare(
        `DELETE FROM tracked_query_tags
         WHERE tracked_query_id IN (${queryPlaceholders})
           AND tag_id IN (
             SELECT id FROM prompt_tags
             WHERE project_id = ?
               AND normalized_name IN (${tagPlaceholders})
           )`,
      )
      .bind(...uniqueIds, projectId, ...normalized),
    db
      .prepare(
        `DELETE FROM prompt_tags
         WHERE project_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM tracked_query_tags qt WHERE qt.tag_id = prompt_tags.id
           )`,
      )
      .bind(projectId),
  ];
}
