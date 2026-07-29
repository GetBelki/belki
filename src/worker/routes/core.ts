import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  BrandInputSchema,
  BulkQueryInputSchema,
  ManualRunSchema,
  ProjectInputSchema,
  ProjectUpdateSchema,
  QueryInputSchema,
  QueryUpdateSchema,
  type Schedule,
} from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import { requireRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { createSignedJobTag } from "../lib/crypto";
import { normalizeHostname } from "../lib/domain";
import { ApiError, jsonParse, nowIso } from "../lib/http";
import { listProjects } from "../lib/projects";
import { calculateNextRun } from "../lib/schedule";

const IdParamSchema = z.object({ id: z.string().uuid() });
const ProjectIdParamSchema = z.object({ projectId: z.string().uuid() });
const QueryListSchema = z.object({
  projectId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface ProjectOwnershipRow {
  id: string;
  html_capture_enabled: number;
}

async function requireProject(
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<ProjectOwnershipRow> {
  const project = await db
    .prepare(
      `SELECT id, html_capture_enabled
       FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    )
    .bind(projectId, workspaceId)
    .first<ProjectOwnershipRow>();
  if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
  return project;
}

function scheduleFromCurrent(row: {
  schedule_cadence: "daily" | "weekly";
  schedule_time: string;
  schedule_weekday: number | null;
  schedule_timezone: string;
}): Schedule {
  return row.schedule_cadence === "weekly"
    ? {
        cadence: "weekly",
        time: row.schedule_time,
        timezone: row.schedule_timezone,
        weekday: row.schedule_weekday ?? 1,
      }
    : {
        cadence: "daily",
        time: row.schedule_time,
        timezone: row.schedule_timezone,
      };
}

export const coreRoutes = new Hono<AppEnv>();

coreRoutes.get("/projects", async (c) => {
  const principal = c.get("principal");
  return c.json({
    data: await listProjects(c.env.CONTROL_DB, principal.workspaceId),
  });
});

coreRoutes.post("/projects", zValidator("json", ProjectInputSchema), async (c) => {
  const principal = requireRole(c, "editor");
  const input = c.req.valid("json");
  const projectId = crypto.randomUUID();
  const brandId = crypto.randomUUID();
  const now = nowIso();
  const primaryDomain = normalizeHostname(input.primaryDomain).registrableDomain;
  const statements = [
    c.env.CONTROL_DB.prepare(
      `INSERT INTO projects (
        id, workspace_id, name, primary_domain, html_capture_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      projectId,
      principal.workspaceId,
      input.name,
      primaryDomain,
      input.htmlCaptureEnabled ? 1 : 0,
      now,
      now,
    ),
    c.env.CONTROL_DB.prepare(
      `INSERT INTO tracked_brands (
        id, project_id, kind, name, aliases_json, domains_json, created_at, updated_at
      ) VALUES (?, ?, 'owned', ?, ?, ?, ?, ?)`,
    ).bind(
      brandId,
      projectId,
      input.ownedBrandName,
      JSON.stringify(input.ownedBrandAliases),
      JSON.stringify(primaryDomain ? [primaryDomain] : []),
      now,
      now,
    ),
  ];
  for (const competitor of input.competitorBrands) {
    statements.push(
      c.env.CONTROL_DB.prepare(
        `INSERT INTO tracked_brands (
          id, project_id, kind, name, aliases_json, domains_json, created_at, updated_at
        ) VALUES (?, ?, 'competitor', ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        projectId,
        competitor.name,
        JSON.stringify(competitor.aliases),
        JSON.stringify(
          competitor.domains
            .map((domain) => normalizeHostname(domain).registrableDomain)
            .filter(Boolean),
        ),
        now,
        now,
      ),
    );
  }
  await c.env.CONTROL_DB.batch(statements);
  await writeAudit(c.env.CONTROL_DB, {
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    action: "project.created",
    resourceType: "project",
    resourceId: projectId,
  });
  return c.json({ data: { id: projectId } }, 201);
});

coreRoutes.get(
  "/projects/:id",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    await requireProject(c.env.CONTROL_DB, principal.workspaceId, id);
    const [project, brands] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT * FROM projects
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
        .bind(id, principal.workspaceId)
        .first(),
      c.env.CONTROL_DB.prepare(
        `SELECT id, kind, name, aliases_json, domains_json, created_at, updated_at
         FROM tracked_brands WHERE project_id = ? ORDER BY kind DESC, name`,
      )
        .bind(id)
        .all(),
    ]);
    return c.json({
      data: {
        project,
        brands: brands.results.map((brand) => ({
          ...brand,
          aliases: jsonParse(String(brand.aliases_json), []),
          domains: jsonParse(String(brand.domains_json), []),
        })),
      },
    });
  },
);

coreRoutes.patch(
  "/projects/:id",
  zValidator("param", IdParamSchema),
  zValidator("json", ProjectUpdateSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await requireProject(c.env.CONTROL_DB, principal.workspaceId, id);
    const current = await c.env.CONTROL_DB.prepare(
      "SELECT name, primary_domain, html_capture_enabled FROM projects WHERE id = ?",
    )
      .bind(id)
      .first<{ name: string; primary_domain: string | null; html_capture_enabled: number }>();
    if (!current) throw new ApiError(404, "project_not_found", "Project not found.");
    const primaryDomain = input.primaryDomain === undefined
      ? current.primary_domain
      : normalizeHostname(input.primaryDomain).registrableDomain;
    await c.env.CONTROL_DB.prepare(
      `UPDATE projects
       SET name = ?, primary_domain = ?, html_capture_enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        input.name ?? current.name,
        primaryDomain,
        input.htmlCaptureEnabled === undefined
          ? current.html_capture_enabled
          : input.htmlCaptureEnabled ? 1 : 0,
        nowIso(),
        id,
      )
      .run();
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "project.updated",
      resourceType: "project",
      resourceId: id,
    });
    return c.json({ data: { id } });
  },
);

coreRoutes.post(
  "/projects/:projectId/brands",
  zValidator("param", ProjectIdParamSchema),
  zValidator("json", BrandInputSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    await requireProject(c.env.CONTROL_DB, principal.workspaceId, projectId);
    const id = crypto.randomUUID();
    const now = nowIso();
    const domains = input.domains
      .map((domain) => normalizeHostname(domain).registrableDomain)
      .filter((domain): domain is string => Boolean(domain));
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO tracked_brands (
        id, project_id, kind, name, aliases_json, domains_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        projectId,
        input.kind,
        input.name,
        JSON.stringify(input.aliases),
        JSON.stringify([...new Set(domains)]),
        now,
        now,
      )
      .run();
    return c.json({ data: { id } }, 201);
  },
);

coreRoutes.patch(
  "/brands/:id",
  zValidator("param", IdParamSchema),
  zValidator("json", BrandInputSchema.partial()),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT b.kind, b.name, b.aliases_json, b.domains_json
       FROM tracked_brands b JOIN projects p ON p.id = b.project_id
       WHERE b.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
    )
      .bind(id, principal.workspaceId)
      .first<{
        kind: "owned" | "competitor";
        name: string;
        aliases_json: string;
        domains_json: string;
      }>();
    if (!current) throw new ApiError(404, "brand_not_found", "Tracked brand not found.");
    const domains = input.domains?.map(
      (domain) => normalizeHostname(domain).registrableDomain,
    ).filter((domain): domain is string => Boolean(domain));
    await c.env.CONTROL_DB.prepare(
      `UPDATE tracked_brands
       SET kind = ?, name = ?, aliases_json = ?, domains_json = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        input.kind ?? current.kind,
        input.name ?? current.name,
        JSON.stringify(input.aliases ?? jsonParse<string[]>(current.aliases_json, [])),
        JSON.stringify(domains ? [...new Set(domains)] : jsonParse(current.domains_json, [])),
        nowIso(),
        id,
      )
      .run();
    return c.json({ data: { id } });
  },
);

coreRoutes.delete(
  "/brands/:id",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id } = c.req.valid("param");
    const result = await c.env.CONTROL_DB.prepare(
      `DELETE FROM tracked_brands
       WHERE id = ? AND project_id IN (
         SELECT id FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
       )`,
    )
      .bind(id, principal.workspaceId)
      .run();
    if (result.meta.changes === 0) {
      throw new ApiError(404, "brand_not_found", "Tracked brand not found.");
    }
    return c.json({ data: { deleted: true } });
  },
);

coreRoutes.delete(
  "/projects/:id",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const { id } = c.req.valid("param");
    await requireProject(c.env.CONTROL_DB, principal.workspaceId, id);
    const now = nowIso();
    await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        "UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?",
      ).bind(now, now, id),
      c.env.CONTROL_DB.prepare(
        "UPDATE tracked_queries SET deleted_at = ?, is_active = 0, updated_at = ? WHERE project_id = ?",
      ).bind(now, now, id),
    ]);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "project.deletion_requested",
      resourceType: "project",
      resourceId: id,
    });
    return c.json({ data: { deleted: true } });
  },
);

coreRoutes.get(
  "/queries",
  zValidator("query", QueryListSchema),
  async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("query");
    const clauses = ["p.workspace_id = ?", "q.deleted_at IS NULL"];
    const bindings: Array<string | number> = [principal.workspaceId];
    if (input.projectId) {
      clauses.push("q.project_id = ?");
      bindings.push(input.projectId);
    }
    if (input.cursor) {
      clauses.push("q.id > ?");
      bindings.push(input.cursor);
    }
    bindings.push(input.limit + 1);
    const rows = await c.env.CONTROL_DB.prepare(
      `SELECT
        q.*, p.name AS project_name,
        MAX(s.captured_at) AS last_snapshot_at,
        COUNT(DISTINCT s.id) AS snapshot_count,
        (
          SELECT j.status
          FROM crawl_jobs j
          WHERE j.tracked_query_id = q.id
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT 1
        ) AS latest_run_status
      FROM tracked_queries q
      JOIN projects p ON p.id = q.project_id
      LEFT JOIN snapshot_index s ON s.tracked_query_id = q.id
      WHERE ${clauses.join(" AND ")}
      GROUP BY q.id
      ORDER BY q.id
      LIMIT ?`,
    )
      .bind(...bindings)
      .all<{ id: string }>();
    const results = rows.results.slice(0, input.limit);
    return c.json({
      data: results,
      page: {
        nextCursor:
          rows.results.length > input.limit
            ? results.at(-1)?.id ?? ""
            : null,
      },
    });
  },
);

coreRoutes.get(
  "/queries/:id",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const query = await c.env.CONTROL_DB.prepare(
      `SELECT
        q.*, p.name AS project_name,
        MAX(s.captured_at) AS last_snapshot_at,
        COUNT(DISTINCT s.id) AS snapshot_count,
        (
          SELECT j.status
          FROM crawl_jobs j
          WHERE j.tracked_query_id = q.id
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT 1
        ) AS latest_run_status
      FROM tracked_queries q
      JOIN projects p ON p.id = q.project_id
      LEFT JOIN snapshot_index s ON s.tracked_query_id = q.id
      WHERE q.id = ? AND p.workspace_id = ? AND q.deleted_at IS NULL
        AND p.deleted_at IS NULL
      GROUP BY q.id`,
    )
      .bind(id, principal.workspaceId)
      .first();
    if (!query) throw new ApiError(404, "query_not_found", "Tracked query not found.");
    return c.json({ data: query });
  },
);

coreRoutes.post(
  "/projects/:projectId/queries/bulk",
  zValidator("param", ProjectIdParamSchema),
  zValidator("json", BulkQueryInputSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    await requireProject(c.env.CONTROL_DB, principal.workspaceId, projectId);

    const uniquePrompts = new Map<string, string>();
    for (const queryText of input.queryTexts) {
      const normalized = queryText.trim().toLowerCase();
      if (!uniquePrompts.has(normalized)) {
        uniquePrompts.set(normalized, queryText.trim());
      }
    }

    const normalizedPrompts = [...uniquePrompts.keys()];
    const placeholders = normalizedPrompts.map(() => "?").join(", ");
    const existing = normalizedPrompts.length
      ? await c.env.CONTROL_DB.prepare(
          `SELECT query_text
           FROM tracked_queries
           WHERE project_id = ? AND deleted_at IS NULL
             AND lower(trim(query_text)) IN (${placeholders})`,
        )
          .bind(projectId, ...normalizedPrompts)
          .all<{ query_text: string }>()
      : { results: [] };
    const existingPrompts = new Set(
      existing.results.map((row) => row.query_text.trim().toLowerCase()),
    );
    const promptsToCreate = [...uniquePrompts.entries()]
      .filter(([normalized]) => !existingPrompts.has(normalized))
      .map(([, queryText]) => queryText);

    if (promptsToCreate.length === 0) {
      return c.json({
        data: {
          ids: [],
          createdCount: 0,
          skippedCount: input.queryTexts.length,
        },
      });
    }

    const shard = await c.env.CONTROL_DB.prepare(
      `SELECT shard_id FROM shard_registry
       WHERE status = 'active'
       ORDER BY assigned_queries ASC, estimated_bytes ASC, shard_id ASC
       LIMIT 1`,
    ).first<{ shard_id: number }>();
    if (!shard) throw new ApiError(503, "no_shard_available", "No snapshot shard is available.");

    const now = nowIso();
    const nextRunAt = calculateNextRun(input.schedule);
    const records = promptsToCreate.map((queryText) => ({
      id: crypto.randomUUID(),
      queryText,
    }));
    const statements = records.map((record) =>
      c.env.CONTROL_DB.prepare(
        `INSERT INTO tracked_queries (
          id, project_id, query_text, location_code, language_code, force_web_search,
          schedule_cadence, schedule_time, schedule_weekday, schedule_timezone,
          next_run_at, shard_id, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        record.id,
        projectId,
        record.queryText,
        input.locationCode,
        input.languageCode,
        input.forceWebSearch ? 1 : 0,
        input.schedule.cadence,
        input.schedule.time,
        input.schedule.cadence === "weekly" ? input.schedule.weekday : null,
        input.schedule.timezone,
        nextRunAt,
        shard.shard_id,
        now,
        now,
      ),
    );
    statements.push(
      c.env.CONTROL_DB.prepare(
        `UPDATE shard_registry
         SET assigned_queries = assigned_queries + ?, updated_at = ?
         WHERE shard_id = ?`,
      ).bind(records.length, now, shard.shard_id),
    );
    await c.env.CONTROL_DB.batch(statements);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "query.bulk_created",
      resourceType: "project",
      resourceId: projectId,
      metadata: {
        projectId,
        cadence: input.schedule.cadence,
        createdCount: records.length,
        skippedCount: input.queryTexts.length - records.length,
      },
    });
    return c.json(
      {
        data: {
          ids: records.map((record) => record.id),
          createdCount: records.length,
          skippedCount: input.queryTexts.length - records.length,
        },
      },
      201,
    );
  },
);

coreRoutes.post(
  "/projects/:projectId/queries",
  zValidator("param", ProjectIdParamSchema),
  zValidator("json", QueryInputSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    await requireProject(c.env.CONTROL_DB, principal.workspaceId, projectId);
    const shard = await c.env.CONTROL_DB.prepare(
      `SELECT shard_id FROM shard_registry
       WHERE status = 'active'
       ORDER BY assigned_queries ASC, estimated_bytes ASC, shard_id ASC
       LIMIT 1`,
    ).first<{ shard_id: number }>();
    if (!shard) throw new ApiError(503, "no_shard_available", "No snapshot shard is available.");

    const queryId = crypto.randomUUID();
    const now = nowIso();
    const nextRunAt = calculateNextRun(input.schedule);
    await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        `INSERT INTO tracked_queries (
          id, project_id, query_text, location_code, language_code, force_web_search,
          schedule_cadence, schedule_time, schedule_weekday, schedule_timezone,
          next_run_at, shard_id, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        queryId,
        projectId,
        input.queryText,
        input.locationCode,
        input.languageCode,
        input.forceWebSearch ? 1 : 0,
        input.schedule.cadence,
        input.schedule.time,
        input.schedule.cadence === "weekly" ? input.schedule.weekday : null,
        input.schedule.timezone,
        nextRunAt,
        shard.shard_id,
        now,
        now,
      ),
      c.env.CONTROL_DB.prepare(
        `UPDATE shard_registry
         SET assigned_queries = assigned_queries + 1, updated_at = ?
         WHERE shard_id = ?`,
      ).bind(now, shard.shard_id),
    ]);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "query.created",
      resourceType: "tracked_query",
      resourceId: queryId,
      metadata: { projectId, cadence: input.schedule.cadence },
    });
    return c.json({ data: { id: queryId, nextRunAt, shardId: shard.shard_id } }, 201);
  },
);

coreRoutes.patch(
  "/queries/:id",
  zValidator("param", IdParamSchema),
  zValidator("json", QueryUpdateSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT q.*
       FROM tracked_queries q JOIN projects p ON p.id = q.project_id
       WHERE q.id = ? AND p.workspace_id = ? AND q.deleted_at IS NULL
         AND p.deleted_at IS NULL`,
    )
      .bind(id, principal.workspaceId)
      .first<{
        query_text: string;
        location_code: number;
        language_code: string;
        force_web_search: number;
        schedule_cadence: "daily" | "weekly";
        schedule_time: string;
        schedule_weekday: number | null;
        schedule_timezone: string;
        next_run_at: string;
      }>();
    if (!current) throw new ApiError(404, "query_not_found", "Tracked query not found.");
    const schedule = input.schedule ?? scheduleFromCurrent(current);
    const nextRunAt = input.schedule ? calculateNextRun(schedule) : current.next_run_at;
    await c.env.CONTROL_DB.prepare(
      `UPDATE tracked_queries SET
        query_text = ?, location_code = ?, language_code = ?, force_web_search = ?,
        schedule_cadence = ?, schedule_time = ?, schedule_weekday = ?,
        schedule_timezone = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        input.queryText ?? current.query_text,
        input.locationCode ?? current.location_code,
        input.languageCode ?? current.language_code,
        input.forceWebSearch === undefined
          ? current.force_web_search
          : input.forceWebSearch ? 1 : 0,
        schedule.cadence,
        schedule.time,
        schedule.cadence === "weekly" ? schedule.weekday : null,
        schedule.timezone,
        nextRunAt,
        nowIso(),
        id,
      )
      .run();
    return c.json({ data: { id, nextRunAt } });
  },
);

coreRoutes.delete(
  "/queries/:id",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id } = c.req.valid("param");
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT q.shard_id FROM tracked_queries q JOIN projects p ON p.id = q.project_id
       WHERE q.id = ? AND p.workspace_id = ? AND q.deleted_at IS NULL`,
    )
      .bind(id, principal.workspaceId)
      .first<{ shard_id: number }>();
    if (!current) throw new ApiError(404, "query_not_found", "Tracked query not found.");
    const now = nowIso();
    await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        `UPDATE tracked_queries SET is_active = 0, deleted_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(now, now, id),
      c.env.CONTROL_DB.prepare(
        `UPDATE shard_registry
         SET assigned_queries = MAX(assigned_queries - 1, 0), updated_at = ?
         WHERE shard_id = ?`,
      ).bind(now, current.shard_id),
    ]);
    return c.json({ data: { deleted: true } });
  },
);

coreRoutes.patch(
  "/queries/:id/status",
  zValidator("param", IdParamSchema),
  zValidator("json", z.object({ isActive: z.boolean() })),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id } = c.req.valid("param");
    const { isActive } = c.req.valid("json");
    const result = await c.env.CONTROL_DB.prepare(
      `UPDATE tracked_queries
       SET is_active = ?, updated_at = ?
       WHERE id = ? AND project_id IN (
         SELECT id FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
       ) AND deleted_at IS NULL`,
    )
      .bind(isActive ? 1 : 0, nowIso(), id, principal.workspaceId)
      .run();
    if (result.meta.changes === 0) {
      throw new ApiError(404, "query_not_found", "Tracked query not found.");
    }
    return c.json({ data: { id, isActive } });
  },
);

coreRoutes.post(
  "/queries/:id/runs",
  zValidator("param", IdParamSchema),
  zValidator("json", ManualRunSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const query = await c.env.CONTROL_DB.prepare(
      `SELECT q.id, q.project_id, q.shard_id, p.html_capture_enabled
       FROM tracked_queries q
       JOIN projects p ON p.id = q.project_id
       WHERE q.id = ? AND p.workspace_id = ? AND q.deleted_at IS NULL AND p.deleted_at IS NULL`,
    )
      .bind(id, principal.workspaceId)
      .first<{
        id: string;
        project_id: string;
        shard_id: number;
        html_capture_enabled: number;
      }>();
    if (!query) throw new ApiError(404, "query_not_found", "Tracked query not found.");

    const jobId = crypto.randomUUID();
    const tag = await createSignedJobTag(jobId, c.env.APP_CRYPTO_KEY);
    const now = nowIso();
    const captureHtml = input.captureHtml || query.html_capture_enabled === 1;
    const deliveryMethod = captureHtml ? "standard_priority" : "live";
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO crawl_jobs (
        id, workspace_id, project_id, tracked_query_id, shard_id, run_type,
        delivery_method, status, scheduled_for, provider_tag, capture_html,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'manual', ?, 'queued', ?, ?, ?, ?, ?)`,
    )
      .bind(
        jobId,
        principal.workspaceId,
        query.project_id,
        query.id,
        query.shard_id,
        deliveryMethod,
        now,
        tag,
        captureHtml ? 1 : 0,
        now,
        now,
      )
      .run();
    await (captureHtml ? c.env.STANDARD_QUEUE : c.env.LIVE_QUEUE).send({ jobId });
    return c.json({ data: { jobId, status: "queued", deliveryMethod } }, 202);
  },
);

coreRoutes.get(
  "/runs/:id",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const job = await c.env.CONTROL_DB.prepare(
      `SELECT j.*
       FROM crawl_jobs j
       WHERE j.id = ? AND j.workspace_id = ?`,
    )
      .bind(id, principal.workspaceId)
      .first();
    if (!job) throw new ApiError(404, "run_not_found", "Run not found.");
    return c.json({ data: job });
  },
);
