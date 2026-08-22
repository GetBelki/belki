import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  BrandInputSchema,
  BulkQueryInputSchema,
  ManualRunSchema,
  PromptPurgeInputSchema,
  PromptTagMutationSchema,
  ProjectInputSchema,
  ProjectFeatureSettingsSchema,
  ProjectTrackingSourcesSchema,
  ProjectUpdateSchema,
  QueryInputSchema,
  QueryUpdateSchema,
  WorkspaceUpdateSchema,
  type PlanKey,
  type Schedule,
  type TrackingSource,
} from "../../shared/contracts";
import { DEFAULT_TRACKING_SOURCES } from "../../shared/tracking-sources";
import type { AppEnv } from "../lib/app";
import { requireRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { createSignedJobTag } from "../lib/crypto";
import { normalizeHostname } from "../lib/domain";
import { ApiError, jsonParse, nowIso } from "../lib/http";
import { listProjects } from "../lib/projects";
import {
  assignPromptTagStatements,
  assertPromptTagCapacity,
  insertPromptTagStatements,
  promptTagAssignments,
  removePromptTagStatements,
  resolvePromptTags,
} from "../lib/prompt-tags";
import { calculateNextRun } from "../lib/schedule";
import { manualJobDelivery } from "../lib/job-delivery";
import { fetchDomainFavicon } from "../lib/favicon";
import {
  promptTagKey,
  uniquePromptTagNames,
} from "../../shared/prompt-tags";
import { planAllowsManualRuns } from "../../shared/plan-access";
import { requestPromptPurges } from "../automation/prompt-purges";
import {
  claimProjectSlot,
  claimPromptSlots,
  releaseProjectSlot,
  releasePromptSlots,
  reserveUsage,
  releaseUsage,
  USAGE_UNITS,
} from "../lib/usage";
import {
  assertTrackingSourcesAllowed,
  availableSources,
  planSourceEntitlement,
  projectTrackingSources,
  scheduledForTrackingSource,
  workspaceSourceEntitlement,
} from "../lib/tracking-sources";

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
       FROM projects WHERE id = ? AND workspace_id = ?
         AND deleted_at IS NULL AND archived_at IS NULL`,
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

coreRoutes.get("/favicon", (c) =>
  fetchDomainFavicon(c.req.query("domain")),
);

coreRoutes.patch(
  "/settings/workspace",
  zValidator("json", WorkspaceUpdateSchema),
  async (c) => {
    const principal = requireRole(c, "owner");
    const { name } = c.req.valid("json");
    await c.env.CONTROL_DB.prepare(
      "UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?",
    )
      .bind(name, nowIso(), principal.workspaceId)
      .run();
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "workspace.updated",
      resourceType: "workspace",
      resourceId: principal.workspaceId,
      metadata: { name },
    });
    return c.json({ data: { id: principal.workspaceId, name } });
  },
);

coreRoutes.get("/projects", async (c) => {
  const principal = c.get("principal");
  return c.json({
    data: await listProjects(c.env.CONTROL_DB, principal.workspaceId),
  });
});

coreRoutes.get("/projects/archived", async (c) => {
  const principal = requireRole(c, "admin");
  const projects = await c.env.CONTROL_DB.prepare(
    `SELECT id, name, primary_domain, archived_at
     FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
       AND archived_at IS NOT NULL
     ORDER BY archived_at DESC`,
  ).bind(principal.workspaceId).all();
  return c.json({ data: projects.results });
});

coreRoutes.patch(
  "/projects/:id/restore",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const { id } = c.req.valid("param");
    const project = await c.env.CONTROL_DB.prepare(
      `SELECT id FROM projects WHERE id = ? AND workspace_id = ?
       AND deleted_at IS NULL AND archived_at IS NOT NULL`,
    ).bind(id, principal.workspaceId).first();
    if (!project) throw new ApiError(404, "archived_project_not_found", "Archived project not found.");
    await claimProjectSlot(c.env, principal.workspaceId);
    try {
      const restored = await c.env.CONTROL_DB.prepare(
        `UPDATE projects SET archived_at = NULL, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND archived_at IS NOT NULL`,
      ).bind(nowIso(), id, principal.workspaceId).run();
      if (restored.meta.changes !== 1) {
        await releaseProjectSlot(c.env, principal.workspaceId);
        throw new ApiError(409, "project_already_restored", "This project has already been restored.");
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "project_already_restored")) {
        await releaseProjectSlot(c.env, principal.workspaceId);
      }
      throw error;
    }
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "project.restored",
      resourceType: "project",
      resourceId: id,
    });
    return c.json({ data: { id, restored: true } });
  },
);

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
      `INSERT INTO project_tracking_sources (
        project_id, source, enabled, created_at, updated_at
      ) VALUES (?, 'chatgpt', 1, ?, ?)`,
    ).bind(projectId, now, now),
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
  await claimProjectSlot(c.env, principal.workspaceId);
  try {
    await c.env.CONTROL_DB.batch(statements);
  } catch (error) {
    await releaseProjectSlot(c.env, principal.workspaceId);
    throw error;
  }
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

coreRoutes.get(
  "/projects/:id/settings",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const result = await c.get("timing").measureD1("project_settings_db", () =>
      c.env.CONTROL_DB.prepare(
        `SELECT project.id, project.name, project.primary_domain,
          project.html_capture_enabled,
          product_enrichment_enabled, entity_extraction_enabled,
          entity_auto_track_enabled, raw_retention_days, html_retention_days,
          billing.plan_key, billing.source_limit,
          COALESCE((
            SELECT json_group_array(source.source)
            FROM (
              SELECT source
              FROM project_tracking_sources
              WHERE project_id = project.id AND enabled = 1
              ORDER BY CASE source
                WHEN 'chatgpt' THEN 0 WHEN 'gemini' THEN 1
                WHEN 'google_ai_mode' THEN 2 ELSE 3 END
            ) source
          ), '[]') AS tracking_sources_json
         FROM projects project
         JOIN billing_accounts billing ON billing.workspace_id = project.workspace_id
         WHERE project.id = ? AND project.workspace_id = ?
           AND project.deleted_at IS NULL AND project.archived_at IS NULL
         LIMIT 1`,
      )
        .bind(id, principal.workspaceId)
        .all<{
          id: string;
          name: string;
          primary_domain: string | null;
          html_capture_enabled: number;
          product_enrichment_enabled: number;
          entity_extraction_enabled: number;
          entity_auto_track_enabled: number;
          raw_retention_days: number;
          html_retention_days: number;
          plan_key: PlanKey;
          source_limit: number;
          tracking_sources_json: string;
        }>(),
    );
    const project = result.results[0];
    if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
    const availableTrackingSources = availableSources(c.env);
    const configuredEntitlement = planSourceEntitlement(project.plan_key);
    const sources = jsonParse<TrackingSource[]>(
      project.tracking_sources_json,
      [],
    );
    return c.json({
      data: {
        id: project.id,
        name: project.name,
        primaryDomain: project.primary_domain,
        htmlCaptureEnabled: project.html_capture_enabled === 1,
        productEnrichmentEnabled: project.product_enrichment_enabled === 1,
        entityExtractionEnabled: project.entity_extraction_enabled === 1,
        entityAutoTrackEnabled: project.entity_auto_track_enabled === 1,
        rawRetentionDays: project.raw_retention_days,
        htmlRetentionDays: project.html_retention_days,
        trackingSources: sources.length ? sources : [...DEFAULT_TRACKING_SOURCES],
        availableTrackingSources,
        allowedTrackingSources: configuredEntitlement.allowedSources.filter((source) =>
          availableTrackingSources.includes(source),
        ),
        trackingSourceLimit: Math.min(
          Number(project.source_limit),
          configuredEntitlement.sourceLimit,
        ),
      },
    });
  },
);

coreRoutes.patch(
  "/projects/:id/tracking-sources",
  zValidator("param", IdParamSchema),
  zValidator("json", ProjectTrackingSourcesSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const { id } = c.req.valid("param");
    const { sources } = c.req.valid("json");
    await requireProject(c.env.CONTROL_DB, principal.workspaceId, id);
    await assertTrackingSourcesAllowed(c.env, principal.workspaceId, sources);
    const now = nowIso();
    await c.env.CONTROL_DB.batch(
      ["chatgpt", "gemini", "google_ai_mode", "google_ai_overview"].map((source) =>
        c.env.CONTROL_DB.prepare(
          `INSERT INTO project_tracking_sources (project_id, source, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, source) DO UPDATE SET
             enabled = excluded.enabled, updated_at = excluded.updated_at`,
        ).bind(id, source, sources.includes(source as typeof sources[number]) ? 1 : 0, now, now)
      ),
    );
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "project.tracking_sources_updated",
      resourceType: "project",
      resourceId: id,
      metadata: { sources },
    });
    return c.json({ data: { id, trackingSources: sources } });
  },
);

coreRoutes.patch(
  "/projects/:id/settings",
  zValidator("param", IdParamSchema),
  zValidator("json", ProjectFeatureSettingsSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await requireProject(c.env.CONTROL_DB, principal.workspaceId, id);
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT html_capture_enabled, product_enrichment_enabled,
        entity_extraction_enabled, entity_auto_track_enabled
       FROM projects WHERE id = ?`,
    )
      .bind(id)
      .first<{
        html_capture_enabled: number;
        product_enrichment_enabled: number;
        entity_extraction_enabled: number;
        entity_auto_track_enabled: number;
      }>();
    if (!current) throw new ApiError(404, "project_not_found", "Project not found.");
    const htmlCaptureEnabled = input.htmlCaptureEnabled ?? current.html_capture_enabled === 1;
    const productEnrichmentEnabled = input.productEnrichmentEnabled
      ?? current.product_enrichment_enabled === 1;
    const entityExtractionEnabled = input.entityExtractionEnabled
      ?? current.entity_extraction_enabled === 1;
    const entityAutoTrackEnabled = entityExtractionEnabled
      ? input.entityAutoTrackEnabled ?? current.entity_auto_track_enabled === 1
      : false;
    const updatedAt = nowIso();
    const statements: D1PreparedStatement[] = [
      c.env.CONTROL_DB.prepare(
        `UPDATE projects SET html_capture_enabled = ?, product_enrichment_enabled = ?,
          entity_extraction_enabled = ?, entity_auto_track_enabled = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        htmlCaptureEnabled ? 1 : 0,
        productEnrichmentEnabled ? 1 : 0,
        entityExtractionEnabled ? 1 : 0,
        entityAutoTrackEnabled ? 1 : 0,
        updatedAt,
        id,
      ),
    ];
    if (!productEnrichmentEnabled) {
      statements.push(
        c.env.CONTROL_DB.prepare(
          `UPDATE product_enrichment_jobs SET status = 'cancelled', active_slot = NULL,
            error_code = 'project_paused', error_message = 'Project product enrichment is paused.',
            updated_at = ?
           WHERE project_id = ? AND status = 'queued'`,
        ).bind(updatedAt, id),
        c.env.CONTROL_DB.prepare(
          `UPDATE product_enrichment_targets SET
            status = CASE WHEN latest_snapshot_id IS NULL THEN 'paused' ELSE 'available' END,
            current_job_id = CASE
              WHEN current_job_id IN (
                SELECT id FROM product_enrichment_jobs
                WHERE project_id = ? AND status = 'cancelled'
              ) THEN NULL ELSE current_job_id END,
            updated_at = ? WHERE project_id = ?`,
        ).bind(id, updatedAt, id),
      );
    }
    if (!entityExtractionEnabled) {
      statements.push(c.env.CONTROL_DB.prepare(
        `UPDATE entity_extraction_jobs SET status = 'cancelled',
          error_message = 'Project entity extraction is paused.', updated_at = ?
         WHERE project_id = ? AND status = 'queued'`,
      ).bind(updatedAt, id));
    }
    await c.env.CONTROL_DB.batch(statements);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "project.features_updated",
      resourceType: "project",
      resourceId: id,
      metadata: {
        htmlCaptureEnabled,
        productEnrichmentEnabled,
        entityExtractionEnabled,
        entityAutoTrackEnabled,
      },
    });
    return c.json({
      data: {
        id,
        htmlCaptureEnabled,
        productEnrichmentEnabled,
        entityExtractionEnabled,
        entityAutoTrackEnabled,
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
    const promptCount = await c.env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM tracked_queries WHERE project_id = ? AND deleted_at IS NULL AND is_active = 1",
    ).bind(id).first<{ count: number }>();
    const now = nowIso();
    await c.env.CONTROL_DB.batch([
      c.env.CONTROL_DB.prepare(
        "UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?",
      ).bind(now, now, id),
      c.env.CONTROL_DB.prepare(
        "UPDATE tracked_queries SET deleted_at = ?, is_active = 0, updated_at = ? WHERE project_id = ?",
      ).bind(now, now, id),
    ]);
    await releaseProjectSlot(c.env, principal.workspaceId);
    if (Number(promptCount?.count ?? 0) > 0) {
      await releasePromptSlots(c.env, principal.workspaceId, Number(promptCount?.count ?? 0));
    }
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
  "/projects/:projectId/tags",
  zValidator("param", ProjectIdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { projectId } = c.req.valid("param");
    const [projectResult, tagsResult] = await c.get("timing").measureD1(
      "project_tags_db",
      () => c.env.CONTROL_DB.batch([
        c.env.CONTROL_DB.prepare(
          `SELECT id
           FROM projects
           WHERE id = ? AND workspace_id = ?
             AND deleted_at IS NULL AND archived_at IS NULL
           LIMIT 1`,
        ).bind(projectId, principal.workspaceId),
        c.env.CONTROL_DB.prepare(
          `SELECT
            t.id, t.name, t.color_index,
            COUNT(q.id) AS usage_count
           FROM prompt_tags t
           LEFT JOIN tracked_query_tags qt ON qt.tag_id = t.id
           LEFT JOIN tracked_queries q
             ON q.id = qt.tracked_query_id AND q.deleted_at IS NULL
           WHERE t.project_id = ?
           GROUP BY t.id, t.name, t.color_index
           HAVING COUNT(q.id) > 0
           ORDER BY usage_count DESC, lower(t.name), t.id`,
        ).bind(projectId),
      ]),
    );
    if (!projectResult?.results.length) {
      throw new ApiError(404, "project_not_found", "Project not found.");
    }
    if (!tagsResult) throw new Error("Project tags batch returned no tag result.");
    const tags = tagsResult as D1Result<{
      id: string;
      name: string;
      color_index: number;
      usage_count: number;
    }>;
    return c.json({
      data: tags.results.map((tag) => ({
        id: tag.id,
        name: tag.name,
        colorIndex: tag.color_index,
        usageCount: tag.usage_count,
      })),
    });
  },
);

coreRoutes.patch(
  "/projects/:projectId/queries/tags",
  zValidator("param", ProjectIdParamSchema),
  zValidator("json", PromptTagMutationSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    await requireProject(c.env.CONTROL_DB, principal.workspaceId, projectId);
    const assignments = await promptTagAssignments(
      c.env.CONTROL_DB,
      projectId,
      input.queryIds,
    );
    const now = nowIso();
    if (input.mode === "add") {
      const resolved = await resolvePromptTags(
        c.env.CONTROL_DB,
        projectId,
        input.tagNames,
      );
      assertPromptTagCapacity(assignments, resolved.tags);
      await c.env.CONTROL_DB.batch([
        ...insertPromptTagStatements(
          c.env.CONTROL_DB,
          projectId,
          resolved.missing,
          now,
        ),
        ...assignPromptTagStatements(
          c.env.CONTROL_DB,
          projectId,
          input.queryIds,
          resolved.tags,
          now,
        ),
      ]);
    } else {
      await c.env.CONTROL_DB.batch(
        removePromptTagStatements(
          c.env.CONTROL_DB,
          projectId,
          input.queryIds,
          input.tagNames,
        ),
      );
    }
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "query.tags_updated",
      resourceType: "project",
      resourceId: projectId,
      metadata: {
        mode: input.mode,
        queryCount: input.queryIds.length,
        tagNames: input.tagNames,
      },
    });
    return c.json({
      data: {
        updatedCount: input.queryIds.length,
        mode: input.mode,
      },
    });
  },
);

coreRoutes.post(
  "/projects/:projectId/queries/purge",
  zValidator("param", ProjectIdParamSchema),
  zValidator("json", PromptPurgeInputSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { projectId } = c.req.valid("param");
    const { queryIds } = c.req.valid("json");
    const result = await requestPromptPurges(
      c.env,
      principal,
      projectId,
      queryIds,
    );
    return c.json({ data: result }, 202);
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

    const requestedItems = input.items ?? input.queryTexts!.map((queryText) => ({
      queryText,
      tags: [],
    }));
    const uniquePrompts = new Map<
      string,
      { queryText: string; tags: string[] }
    >();
    for (const item of requestedItems) {
      const queryText = item.queryText.trim();
      const normalized = queryText.toLowerCase();
      const tags = uniquePromptTagNames([...input.tags, ...item.tags]);
      const current = uniquePrompts.get(normalized);
      if (current) {
        current.tags = uniquePromptTagNames([...current.tags, ...tags]);
      } else {
        uniquePrompts.set(normalized, { queryText, tags });
      }
    }

    const normalizedPrompts = [...uniquePrompts.keys()];
    const placeholders = normalizedPrompts.map(() => "?").join(", ");
    const existing = normalizedPrompts.length
      ? await c.env.CONTROL_DB.prepare(
          `SELECT id, query_text
           FROM tracked_queries
           WHERE project_id = ? AND deleted_at IS NULL
             AND lower(trim(query_text)) IN (${placeholders})`,
        )
          .bind(projectId, ...normalizedPrompts)
          .all<{ id: string; query_text: string }>()
      : { results: [] };
    const existingPrompts = new Map(
      existing.results.map((row) => [
        row.query_text.trim().toLowerCase(),
        row.id,
      ]),
    );
    const promptsToCreate = [...uniquePrompts.entries()]
      .filter(([normalized]) => !existingPrompts.has(normalized))
      .map(([normalized, prompt]) => ({ normalized, ...prompt }));

    const now = nowIso();
    const nextRunAt = calculateNextRun(input.schedule);
    const records = promptsToCreate.map((prompt) => ({
      id: crypto.randomUUID(),
      ...prompt,
    }));
    const shard = records.length
      ? await c.env.CONTROL_DB.prepare(
          `SELECT shard_id FROM shard_registry
           WHERE status = 'active'
           ORDER BY assigned_queries ASC, estimated_bytes ASC, shard_id ASC
           LIMIT 1`,
        ).first<{ shard_id: number }>()
      : null;
    if (records.length && !shard) {
      throw new ApiError(503, "no_shard_available", "No snapshot shard is available.");
    }
    const duplicateTargets = [...uniquePrompts.entries()]
      .map(([normalized, prompt]) => ({
        id: existingPrompts.get(normalized),
        ...prompt,
      }))
      .filter(
        (target): target is { id: string; queryText: string; tags: string[] } =>
          Boolean(target.id),
      );
    const targetPrompts = [
      ...records.map((record) => ({ id: record.id, tags: record.tags })),
      ...duplicateTargets.map((target) => ({
        id: target.id,
        tags: target.tags,
      })),
    ];
    const allTagNames = uniquePromptTagNames(
      targetPrompts.flatMap((target) => target.tags),
    );
    const resolvedTags = await resolvePromptTags(
      c.env.CONTROL_DB,
      projectId,
      allTagNames,
    );
    const tagsByName = new Map(
      resolvedTags.tags.map((tag) => [tag.normalized_name, tag]),
    );
    if (duplicateTargets.length && resolvedTags.tags.length) {
      const assignments = await promptTagAssignments(
        c.env.CONTROL_DB,
        projectId,
        duplicateTargets.map((target) => target.id),
      );
      for (const target of duplicateTargets) {
        assertPromptTagCapacity(
          new Map([[target.id, assignments.get(target.id) ?? new Set()]]),
          target.tags.map((name) => tagsByName.get(promptTagKey(name))!),
        );
      }
    }
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
        shard!.shard_id,
        now,
        now,
      ),
    );
    statements.unshift(
      ...insertPromptTagStatements(
        c.env.CONTROL_DB,
        projectId,
        resolvedTags.missing,
        now,
      ),
    );
    if (records.length) statements.push(
      c.env.CONTROL_DB.prepare(
        `UPDATE shard_registry
         SET assigned_queries = assigned_queries + ?, updated_at = ?
         WHERE shard_id = ?`,
      ).bind(records.length, now, shard!.shard_id),
    );
    const tagGroups = new Map<
      string,
      { ids: string[]; tags: typeof resolvedTags.tags }
    >();
    for (const target of targetPrompts) {
      const tags = target.tags
        .map((name) => tagsByName.get(promptTagKey(name)))
        .filter((tag): tag is (typeof resolvedTags.tags)[number] => Boolean(tag));
      if (!tags.length) continue;
      const signature = tags
        .map((tag) => tag.normalized_name)
        .sort()
        .join("\u0000");
      const group = tagGroups.get(signature) ?? { ids: [], tags };
      group.ids.push(target.id);
      tagGroups.set(signature, group);
    }
    for (const group of tagGroups.values()) {
      statements.push(
        ...assignPromptTagStatements(
          c.env.CONTROL_DB,
          projectId,
          group.ids,
          group.tags,
          now,
        ),
      );
    }
    if (!statements.length) {
      return c.json({
        data: {
          ids: [],
          createdCount: 0,
          skippedCount: requestedItems.length,
        },
      });
    }
    if (records.length) await claimPromptSlots(c.env, principal.workspaceId, records.length);
    try {
      await c.env.CONTROL_DB.batch(statements);
    } catch (error) {
      if (records.length) await releasePromptSlots(c.env, principal.workspaceId, records.length);
      throw error;
    }
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
        skippedCount: requestedItems.length - records.length,
        tagNames: allTagNames,
        taggedPromptCount: targetPrompts.filter((target) => target.tags.length)
          .length,
      },
    });
    return c.json(
      {
        data: {
          ids: records.map((record) => record.id),
          createdCount: records.length,
          skippedCount: requestedItems.length - records.length,
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
    const resolvedTags = await resolvePromptTags(
      c.env.CONTROL_DB,
      projectId,
      input.tags,
    );
    await claimPromptSlots(c.env, principal.workspaceId);
    try {
      await c.env.CONTROL_DB.batch([
      ...insertPromptTagStatements(
        c.env.CONTROL_DB,
        projectId,
        resolvedTags.missing,
        now,
      ),
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
      ...assignPromptTagStatements(
        c.env.CONTROL_DB,
        projectId,
        [queryId],
        resolvedTags.tags,
        now,
      ),
      ]);
    } catch (error) {
      await releasePromptSlots(c.env, principal.workspaceId);
      throw error;
    }
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "query.created",
      resourceType: "tracked_query",
      resourceId: queryId,
      metadata: {
        projectId,
        cadence: input.schedule.cadence,
        tagNames: input.tags,
      },
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
      `SELECT project_id FROM tracked_queries
       WHERE id = ? AND project_id IN (
         SELECT id FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
       )
       UNION ALL
       SELECT project_id FROM prompt_purge_jobs
       WHERE tracked_query_id = ? AND workspace_id = ?
       LIMIT 1`,
    )
      .bind(id, principal.workspaceId, id, principal.workspaceId)
      .first<{ project_id: string }>();
    if (!current) throw new ApiError(404, "query_not_found", "Tracked query not found.");
    const active = await c.env.CONTROL_DB.prepare(
      "SELECT is_active FROM tracked_queries WHERE id = ?",
    ).bind(id).first<{ is_active: number }>();
    const result = await requestPromptPurges(
      c.env,
      principal,
      current.project_id,
      [id],
    );
    if (active?.is_active === 1) await releasePromptSlots(c.env, principal.workspaceId);
    return c.json({ data: result }, 202);
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
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT query.is_active FROM tracked_queries query
       JOIN projects project ON project.id = query.project_id
       WHERE query.id = ? AND project.workspace_id = ? AND query.deleted_at IS NULL
         AND project.deleted_at IS NULL AND project.archived_at IS NULL`,
    ).bind(id, principal.workspaceId).first<{ is_active: number }>();
    if (!current) throw new ApiError(404, "query_not_found", "Tracked query not found.");
    const claimedSlot = isActive && current.is_active !== 1;
    if (claimedSlot) await claimPromptSlots(c.env, principal.workspaceId);
    let result: D1Result;
    try {
      result = await c.env.CONTROL_DB.prepare(
        `UPDATE tracked_queries
         SET is_active = ?, updated_at = ?
         WHERE id = ? AND project_id IN (
           SELECT id FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
             AND archived_at IS NULL
         ) AND deleted_at IS NULL`,
      )
        .bind(isActive ? 1 : 0, nowIso(), id, principal.workspaceId)
        .run();
    } catch (error) {
      if (claimedSlot) await releasePromptSlots(c.env, principal.workspaceId);
      throw error;
    }
    if (result.meta.changes === 0) {
      if (claimedSlot) await releasePromptSlots(c.env, principal.workspaceId);
      throw new ApiError(404, "query_not_found", "Tracked query not found.");
    }
    if (!isActive && current.is_active === 1) await releasePromptSlots(c.env, principal.workspaceId);
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
    const { planKey } = await workspaceSourceEntitlement(c.env, principal.workspaceId);
    if (!planAllowsManualRuns(planKey)) {
      throw new ApiError(403, "manual_runs_unavailable", "Managed plans use scheduled tracking.");
    }
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
    const enabledSources = await projectTrackingSources(c.env, query.project_id);
    if (!enabledSources.includes(input.source)) {
      throw new ApiError(409, "tracking_source_disabled", "Enable this tracking source in Project Settings first.");
    }

    const jobId = crypto.randomUUID();
    const tag = await createSignedJobTag(jobId, c.env.APP_CRYPTO_KEY);
    const now = nowIso();
    const delivery = manualJobDelivery(
      input.source,
      input.captureHtml || query.html_capture_enabled === 1,
    );
    const usageInput = {
      reservationId: jobId,
      sku: delivery.sku,
      units: USAGE_UNITS[delivery.sku],
      resourceType: "crawl_job",
      resourceId: jobId,
    } as const;
    await reserveUsage(c.env, principal.workspaceId, usageInput);
    try {
      await c.env.CONTROL_DB.prepare(
        `INSERT INTO crawl_jobs (
          id, workspace_id, project_id, tracked_query_id, shard_id, tracking_source, run_type,
          delivery_method, status, scheduled_for, provider_tag, capture_html,
          provider_account_id, usage_reservation_id, usage_units, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          jobId,
          principal.workspaceId,
          query.project_id,
          query.id,
          query.shard_id,
          input.source,
          delivery.deliveryMethod,
          scheduledForTrackingSource(now, input.source),
          tag,
          delivery.captureHtml ? 1 : 0,
          "dataforseo:platform:v1",
          jobId,
          usageInput.units,
          now,
          now,
        )
        .run();
      await (delivery.queue === "standard" ? c.env.STANDARD_QUEUE : c.env.LIVE_QUEUE)
        .send({ jobId });
    } catch (error) {
      await c.env.CONTROL_DB.prepare(
        `UPDATE crawl_jobs SET status = 'failed', error_code = 'queue_failed',
          error_message = ?, updated_at = ? WHERE id = ? AND status = 'queued'`,
      ).bind(String(error).slice(0, 1000), nowIso(), jobId).run();
      await releaseUsage(c.env, principal.workspaceId, usageInput);
      throw error;
    }
    return c.json({
      data: { jobId, status: "queued", deliveryMethod: delivery.deliveryMethod },
    }, 202);
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
