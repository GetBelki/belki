import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  AlertRuleInputSchema,
  ExportInputSchema,
  WebhookDestinationInputSchema,
  ProductEnrichmentSettingsSchema,
  ProjectBillingAlertsSchema,
  EntityActionSchema,
  EntityExtractionSettingsSchema,
} from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import { requireRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { hmac } from "../lib/crypto";
import { ApiError, jsonParse, nowIso } from "../lib/http";
import { projectTrackingSources } from "../lib/tracking-sources";
import { preserveBrandMetricsHistory } from "../lib/brand-metrics-state";
import { emailDeliveryConfigured } from "../lib/email-config";
import { configuredPublicAppOrigin } from "../lib/public-origin";
import { hasConfiguredCaptureProviderType } from "../providers/accounts";
import { paymentProviderConfiguration } from "../payments/accounts";

const IdParamSchema = z.object({ id: z.string().uuid() });

async function assertProject(
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND archived_at IS NULL")
    .bind(projectId, workspaceId)
    .first();
  if (!row) throw new ApiError(404, "project_not_found", "Project not found.");
}

function assertSafeWebhookUrl(raw: string): void {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./u.test(host) ||
    /^10\./u.test(host) ||
    /^192\.168\./u.test(host) ||
    /^169\.254\./u.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host);
  if (blocked) throw new ApiError(422, "unsafe_webhook_url", "Private webhook targets are not allowed.");
}

export const automationRoutes = new Hono<AppEnv>();

automationRoutes.get(
  "/projects/:projectId/billing-alerts",
  zValidator("param", z.object({ projectId: z.string().uuid() })),
  async (c) => {
    const principal = requireRole(c, "admin");
    const { projectId } = c.req.valid("param");
    await assertProject(c.env.CONTROL_DB, principal.workspaceId, projectId);
    const [project, enrichment, entities] = await Promise.all([
      c.env.CONTROL_DB.prepare(
        `SELECT product_enrichment_warning_usd, entity_extraction_warning_usd
         FROM projects WHERE id = ?`,
      ).bind(projectId).first<{
        product_enrichment_warning_usd: number;
        entity_extraction_warning_usd: number;
      }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT COUNT(*) AS tasks, COALESCE(SUM(request_cost_usd), 0) AS cost
         FROM product_enrichment_jobs
         WHERE project_id = ? AND request_cost_usd > 0
           AND COALESCE(submitted_at, created_at) >= strftime('%Y-%m-01T00:00:00.000Z', 'now')`,
      ).bind(projectId).first<{ tasks: number; cost: number }>(),
      c.env.CONTROL_DB.prepare(
        `SELECT SUM(tasks) AS tasks, SUM(cost) AS cost FROM (
          SELECT COUNT(*) AS tasks, COALESCE(SUM(chunk.estimated_cost_usd), 0) AS cost
          FROM entity_extraction_chunks chunk
          JOIN entity_extraction_jobs job ON job.id = chunk.job_id
          WHERE job.project_id = ? AND job.run_type = 'live'
            AND chunk.status = 'completed'
            AND chunk.completed_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
          UNION ALL
          SELECT COALESCE(SUM(charged_tasks), 0), COALESCE(SUM(estimated_cost_usd), 0)
          FROM deleted_entity_extraction_usage_daily
          WHERE project_id = ? AND usage_date >= strftime('%Y-%m-01', 'now')
        ) usage`,
      ).bind(projectId, projectId).first<{ tasks: number; cost: number }>(),
    ]);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
    const productThreshold = Number(project.product_enrichment_warning_usd);
    const entityThreshold = Number(project.entity_extraction_warning_usd);
    const productCost = Number(enrichment?.cost ?? 0);
    const entityCost = Number(entities?.cost ?? 0);
    return c.json({
      data: {
        productEnrichment: {
          threshold: productThreshold,
          monthToDateTasks: Number(enrichment?.tasks ?? 0),
          monthToDateCost: productCost,
          exceeded: productThreshold > 0 && productCost >= productThreshold,
          estimated: false,
        },
        entityExtraction: {
          threshold: entityThreshold,
          monthToDateTasks: Number(entities?.tasks ?? 0),
          monthToDateCost: entityCost,
          exceeded: entityThreshold > 0 && entityCost >= entityThreshold,
          estimated: true,
        },
      },
    });
  },
);

automationRoutes.patch(
  "/projects/:projectId/billing-alerts",
  zValidator("param", z.object({ projectId: z.string().uuid() })),
  zValidator("json", ProjectBillingAlertsSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const { projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    await assertProject(c.env.CONTROL_DB, principal.workspaceId, projectId);
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT product_enrichment_warning_usd, entity_extraction_warning_usd
       FROM projects WHERE id = ?`,
    ).bind(projectId).first<{
      product_enrichment_warning_usd: number;
      entity_extraction_warning_usd: number;
    }>();
    if (!current) throw new ApiError(404, "project_not_found", "Project not found.");
    const productEnrichmentWarningUsd = input.productEnrichmentWarningUsd
      ?? current.product_enrichment_warning_usd;
    const entityExtractionWarningUsd = input.entityExtractionWarningUsd
      ?? current.entity_extraction_warning_usd;
    await c.env.CONTROL_DB.prepare(
      `UPDATE projects SET product_enrichment_warning_usd = ?,
        entity_extraction_warning_usd = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      productEnrichmentWarningUsd,
      entityExtractionWarningUsd,
      nowIso(),
      projectId,
    ).run();
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "project.billing_alerts_updated",
      resourceType: "project",
      resourceId: projectId,
      metadata: { productEnrichmentWarningUsd, entityExtractionWarningUsd },
    });
    return c.json({
      data: { projectId, productEnrichmentWarningUsd, entityExtractionWarningUsd },
    });
  },
);

automationRoutes.get("/alerts", async (c) => {
  const principal = c.get("principal");
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT a.*, p.name AS project_name, q.query_text,
      rule.tracking_source
     FROM alerts a
     JOIN projects p ON p.id = a.project_id
     JOIN alert_rules rule ON rule.id = a.alert_rule_id
     LEFT JOIN tracked_queries q ON q.id = a.tracked_query_id
     WHERE p.workspace_id = ?
     ORDER BY a.created_at DESC LIMIT 200`,
  )
    .bind(principal.workspaceId)
    .all();
  return c.json({ data: rows.results });
});

automationRoutes.patch(
  "/alerts/:id/read",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const result = await c.env.CONTROL_DB.prepare(
      `UPDATE alerts SET is_read = 1
       WHERE id = ? AND project_id IN (
         SELECT id FROM projects WHERE workspace_id = ?
       )`,
    )
      .bind(id, principal.workspaceId)
      .run();
    if (result.meta.changes === 0) throw new ApiError(404, "alert_not_found", "Alert not found.");
    return c.json({ data: { id, isRead: true } });
  },
);

automationRoutes.get("/settings/entity-extraction", async (c) => {
  const principal = requireRole(c, "admin");
  const [workspace, usage] = await Promise.all([
    c.env.CONTROL_DB.prepare(
      `SELECT entity_extraction_enabled, entity_auto_track_enabled,
        entity_extraction_warning_usd
       FROM workspaces WHERE id = ?`,
    ).bind(principal.workspaceId).first<{
      entity_extraction_enabled: number;
      entity_auto_track_enabled: number;
      entity_extraction_warning_usd: number;
    }>(),
    c.env.CONTROL_DB.prepare(
      `SELECT SUM(tasks) AS tasks, SUM(cost) AS cost FROM (
        SELECT COUNT(*) AS tasks, COALESCE(SUM(chunk.estimated_cost_usd), 0) AS cost
        FROM entity_extraction_chunks chunk
        JOIN entity_extraction_jobs job ON job.id = chunk.job_id
        WHERE job.workspace_id = ? AND job.run_type = 'live'
          AND chunk.status = 'completed'
          AND chunk.completed_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
        UNION ALL
        SELECT COALESCE(SUM(charged_tasks), 0), COALESCE(SUM(estimated_cost_usd), 0)
        FROM deleted_entity_extraction_usage_daily
        WHERE workspace_id = ? AND usage_date >= strftime('%Y-%m-01', 'now')
      ) usage`,
    ).bind(principal.workspaceId, principal.workspaceId).first<{ tasks: number; cost: number }>(),
  ]);
  if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
  const threshold = Number(workspace.entity_extraction_warning_usd);
  const cost = Number(usage?.cost ?? 0);
  return c.json({
    data: {
      enabled: workspace.entity_extraction_enabled === 1,
      autoTrackEnabled: workspace.entity_auto_track_enabled === 1,
      monthlyWarningUsd: threshold,
      monthToDateTasks: Number(usage?.tasks ?? 0),
      monthToDateCost: cost,
      warningExceeded: threshold > 0 && cost >= threshold,
      costIsEstimated: true,
    },
  });
});

automationRoutes.patch(
  "/settings/entity-extraction",
  zValidator("json", EntityExtractionSettingsSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const input = c.req.valid("json");
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT entity_extraction_enabled, entity_auto_track_enabled,
        entity_extraction_warning_usd FROM workspaces WHERE id = ?`,
    ).bind(principal.workspaceId).first<{
      entity_extraction_enabled: number;
      entity_auto_track_enabled: number;
      entity_extraction_warning_usd: number;
    }>();
    if (!current) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
    const enabled = input.enabled ?? current.entity_extraction_enabled === 1;
    const autoTrackEnabled =
      input.autoTrackEnabled ?? current.entity_auto_track_enabled === 1;
    const threshold =
      input.monthlyWarningUsd ?? current.entity_extraction_warning_usd;
    const now = nowIso();
    const statements: D1PreparedStatement[] = [
      c.env.CONTROL_DB.prepare(
        `UPDATE workspaces SET entity_extraction_enabled = ?,
          entity_auto_track_enabled = ?, entity_extraction_warning_usd = ?,
          updated_at = ? WHERE id = ?`,
      ).bind(
        enabled ? 1 : 0,
        autoTrackEnabled ? 1 : 0,
        threshold,
        now,
        principal.workspaceId,
      ),
    ];
    if (!enabled) {
      statements.push(c.env.CONTROL_DB.prepare(
        `UPDATE entity_extraction_jobs SET status = 'cancelled',
          error_message = 'Workspace entity extraction is paused.', updated_at = ?
         WHERE workspace_id = ? AND status IN ('queued', 'failed')`,
      ).bind(now, principal.workspaceId));
    }
    await c.env.CONTROL_DB.batch(statements);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "entity_extraction.settings_updated",
      resourceType: "workspace",
      resourceId: principal.workspaceId,
      metadata: { enabled, autoTrackEnabled, monthlyWarningUsd: threshold },
    });
    return c.json({ data: { enabled, autoTrackEnabled, monthlyWarningUsd: threshold } });
  },
);

automationRoutes.patch(
  "/entities/:id",
  zValidator("param", IdParamSchema),
  zValidator("json", EntityActionSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const entity = await c.env.CONTROL_DB.prepare(
      `SELECT entity.* FROM project_entities entity
       JOIN projects project ON project.id = entity.project_id
       WHERE entity.id = ? AND project.workspace_id = ? AND project.deleted_at IS NULL`,
    ).bind(id, principal.workspaceId).first<{
      id: string;
      project_id: string;
      canonical_name: string;
      aliases_json: string;
      domains_json: string;
      entity_type: string;
      status: string;
    }>();
    if (!entity) throw new ApiError(404, "entity_not_found", "Entity not found.");
    const now = nowIso();
    if (input.action === "track") {
      if (!['brand', 'company', 'organization'].includes(entity.entity_type)) {
        throw new ApiError(422, "entity_not_trackable", "Only brands and organizations can be tracked.");
      }
      await c.env.CONTROL_DB.batch([
        c.env.CONTROL_DB.prepare(
          `INSERT OR IGNORE INTO tracked_brands (
            id, project_id, kind, name, aliases_json, domains_json, created_at, updated_at
          ) VALUES (?, ?, 'competitor', ?, ?, ?, ?, ?)`,
        ).bind(
          entity.id,
          entity.project_id,
          entity.canonical_name,
          entity.aliases_json,
          entity.domains_json,
          now,
          now,
        ),
        c.env.CONTROL_DB.prepare(
          `UPDATE project_entities SET status = 'tracked', relationship = 'competitor',
            tracked_brand_id = ?, updated_at = ? WHERE id = ?`,
        ).bind(entity.id, now, entity.id),
      ]);
      await preserveBrandMetricsHistory(c.env.CONTROL_DB, entity.project_id);
    } else if (input.action === "ignore") {
      await c.env.CONTROL_DB.prepare(
        "UPDATE project_entities SET status = 'ignored', updated_at = ? WHERE id = ?",
      ).bind(now, entity.id).run();
    } else if (input.action === "restore") {
      await c.env.CONTROL_DB.prepare(
        `UPDATE project_entities SET status = CASE WHEN tracked_brand_id IS NULL
          THEN 'candidate' ELSE 'tracked' END, updated_at = ? WHERE id = ?`,
      ).bind(now, entity.id).run();
    } else {
      const target = await c.env.CONTROL_DB.prepare(
        `SELECT id, aliases_json, domains_json FROM project_entities
         WHERE id = ? AND project_id = ? AND status != 'merged'`,
      ).bind(input.targetEntityId, entity.project_id).first<{
        id: string;
        aliases_json: string;
        domains_json: string;
      }>();
      if (!target || target.id === entity.id) {
        throw new ApiError(422, "invalid_merge_target", "Choose another active entity in this project.");
      }
      const mentions = await c.env.CONTROL_DB.prepare(
        "SELECT * FROM entity_mentions WHERE entity_id = ? ORDER BY captured_at",
      ).bind(entity.id).all<Record<string, string | number>>();
      for (const mention of mentions.results) {
        await c.env.CONTROL_DB.prepare(
          `INSERT INTO entity_mentions (
            id, snapshot_id, workspace_id, project_id, tracked_query_id, entity_id,
            surface_text, occurrence_count, entity_type, relationship, confidence,
            evidence_json, sources_json, captured_at, created_at, extractor_version,
            evidence_tier, relationship_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(snapshot_id, entity_id, extractor_version) DO UPDATE SET
            occurrence_count = entity_mentions.occurrence_count + excluded.occurrence_count,
            confidence = MAX(entity_mentions.confidence, excluded.confidence),
            evidence_tier = CASE
              WHEN entity_mentions.evidence_tier = 'strong' OR excluded.evidence_tier = 'strong'
                THEN 'strong'
              WHEN entity_mentions.evidence_tier = 'moderate' OR excluded.evidence_tier = 'moderate'
                THEN 'moderate'
              ELSE 'weak' END`,
        ).bind(
          crypto.randomUUID(), mention.snapshot_id, mention.workspace_id,
          mention.project_id, mention.tracked_query_id, target.id, mention.surface_text,
          mention.occurrence_count, mention.entity_type, mention.relationship,
          mention.confidence, mention.evidence_json, mention.sources_json,
          mention.captured_at, mention.created_at, mention.extractor_version,
          mention.evidence_tier, mention.relationship_reason,
        ).run();
      }
      await c.env.CONTROL_DB.batch([
        c.env.CONTROL_DB.prepare("DELETE FROM entity_mentions WHERE entity_id = ?").bind(entity.id),
        c.env.CONTROL_DB.prepare(
          `UPDATE project_entities SET aliases_json = ?, domains_json = ?, updated_at = ? WHERE id = ?`,
        ).bind(
          JSON.stringify([...new Set([
            ...jsonParse<string[]>(target.aliases_json, []),
            ...jsonParse<string[]>(entity.aliases_json, []),
            entity.canonical_name,
          ])]),
          JSON.stringify([...new Set([
            ...jsonParse<string[]>(target.domains_json, []),
            ...jsonParse<string[]>(entity.domains_json, []),
          ])]),
          now,
          target.id,
        ),
        c.env.CONTROL_DB.prepare(
          `UPDATE project_entities SET
            snapshot_count = (SELECT COUNT(DISTINCT snapshot_id) FROM entity_mentions
              WHERE entity_id = ? AND extractor_version = (
                SELECT active_entity_extractor_version FROM projects WHERE id = entity_mentions.project_id)),
            prompt_count = (SELECT COUNT(DISTINCT tracked_query_id) FROM entity_mentions
              WHERE entity_id = ? AND extractor_version = (
                SELECT active_entity_extractor_version FROM projects WHERE id = entity_mentions.project_id)),
            competitor_snapshot_count = (SELECT COUNT(DISTINCT snapshot_id) FROM entity_mentions
              WHERE entity_id = ? AND relationship = 'competitor' AND extractor_version = (
                SELECT active_entity_extractor_version FROM projects WHERE id = entity_mentions.project_id)),
            competitor_prompt_count = (SELECT COUNT(DISTINCT tracked_query_id) FROM entity_mentions
              WHERE entity_id = ? AND relationship = 'competitor' AND extractor_version = (
                SELECT active_entity_extractor_version FROM projects WHERE id = entity_mentions.project_id)),
            updated_at = ? WHERE id = ?`,
        ).bind(target.id, target.id, target.id, target.id, now, target.id),
        c.env.CONTROL_DB.prepare(
          `UPDATE project_entities SET status = 'merged', merged_into_id = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(target.id, now, entity.id),
      ]);
    }
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: `entity.${input.action}`,
      resourceType: "project_entity",
      resourceId: entity.id,
      metadata: input.action === "merge" ? { targetEntityId: input.targetEntityId } : undefined,
    });
    return c.json({ data: { id: entity.id, action: input.action } });
  },
);

automationRoutes.get(
  "/projects/:id/alert-rules",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    await assertProject(c.env.CONTROL_DB, principal.workspaceId, id);
    const rows = await c.env.CONTROL_DB.prepare(
      "SELECT * FROM alert_rules WHERE project_id = ? ORDER BY created_at DESC",
    )
      .bind(id)
      .all();
    return c.json({ data: rows.results });
  },
);

automationRoutes.post(
  "/projects/:id/alert-rules",
  zValidator("param", IdParamSchema),
  zValidator("json", AlertRuleInputSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const { id: projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    await assertProject(c.env.CONTROL_DB, principal.workspaceId, projectId);
    const enabledSources = await projectTrackingSources(c.env, projectId);
    if (!enabledSources.includes(input.source)) {
      throw new ApiError(
        422,
        "tracking_source_disabled",
        "Enable this tracking source in Project Settings first.",
      );
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO alert_rules (
        id, project_id, name, event_type, threshold, tracked_brand_id,
        tracking_source, is_enabled, channels_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(
        id,
        projectId,
        input.name,
        input.eventType,
        input.threshold ?? null,
        input.trackedBrandId ?? null,
        input.source,
        JSON.stringify(input.channels),
        now,
        now,
      )
      .run();
    return c.json({ data: { id } }, 201);
  },
);

automationRoutes.get("/webhook-destinations", async (c) => {
  const principal = requireRole(c, "admin");
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT id, name, url, is_enabled, created_at, updated_at
     FROM webhook_destinations WHERE workspace_id = ? ORDER BY name`,
  )
    .bind(principal.workspaceId)
    .all();
  return c.json({ data: rows.results });
});

automationRoutes.post(
  "/webhook-destinations",
  zValidator("json", WebhookDestinationInputSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const input = c.req.valid("json");
    assertSafeWebhookUrl(input.url);
    const id = crypto.randomUUID();
    const now = nowIso();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO webhook_destinations (
        id, workspace_id, name, url, is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(id, principal.workspaceId, input.name, input.url, now, now)
      .run();
    const signingSecret = await hmac(id, c.env.APP_CRYPTO_KEY);
    return c.json({ data: { id, signingSecret } }, 201);
  },
);

automationRoutes.get("/exports", async (c) => {
  const principal = c.get("principal");
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT id, project_id, format, status, row_count, error_message,
      expires_at, created_at, updated_at
     FROM exports WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(principal.workspaceId)
    .all();
  return c.json({ data: rows.results });
});

automationRoutes.post(
  "/exports",
  zValidator("json", ExportInputSchema),
  async (c) => {
    const principal = requireRole(c, "editor");
    const input = c.req.valid("json");
    if (input.projectId) {
      await assertProject(c.env.CONTROL_DB, principal.workspaceId, input.projectId);
      if (input.source) {
        const enabledSources = await projectTrackingSources(c.env, input.projectId);
        if (!enabledSources.includes(input.source)) {
          throw new ApiError(
            422,
            "tracking_source_disabled",
            "Enable this tracking source in Project Settings first.",
          );
        }
      }
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    await c.env.CONTROL_DB.prepare(
      `INSERT INTO exports (
        id, workspace_id, requested_by_user_id, project_id, format,
        status, filters_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
      .bind(
        id,
        principal.workspaceId,
        principal.userId,
        input.projectId ?? null,
        input.format,
        JSON.stringify({
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          source: input.source,
        }),
        now,
        now,
      )
      .run();
    await c.env.EXPORT_QUEUE.send({ exportId: id });
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "export.requested",
      resourceType: "export",
      resourceId: id,
    });
    return c.json({ data: { id, status: "queued" } }, 202);
  },
);

automationRoutes.get(
  "/exports/:id/download",
  zValidator("param", IdParamSchema),
  async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const row = await c.env.CONTROL_DB.prepare(
      `SELECT r2_key, format, expires_at FROM exports
       WHERE id = ? AND workspace_id = ? AND status = 'completed'`,
    )
      .bind(id, principal.workspaceId)
      .first<{ r2_key: string; format: string; expires_at: string }>();
    if (!row || Date.parse(row.expires_at) < Date.now()) {
      throw new ApiError(404, "export_not_found", "Export is unavailable or expired.");
    }
    const object = await c.env.EVIDENCE_BUCKET.get(row.r2_key);
    if (!object) throw new ApiError(404, "export_not_found", "Export file not found.");
    return new Response(object.body, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="ai-tracker-${id}.${row.format}.gz"`,
        "cache-control": "private, no-store",
      },
    });
  },
);

automationRoutes.get("/settings/locales", async (c) => {
  const rows = await c.env.CONTROL_DB.prepare(
    `SELECT kind, code, name, payload_json, refreshed_at
     FROM locale_catalog ORDER BY kind, name`,
  ).all();
  return c.json({ data: rows.results });
});

automationRoutes.get("/settings/product-enrichment", async (c) => {
  const principal = requireRole(c, "admin");
  const workspace = await c.env.CONTROL_DB.prepare(
    `SELECT product_enrichment_enabled, product_enrichment_warning_usd
     FROM workspaces WHERE id = ?`,
  )
    .bind(principal.workspaceId)
    .first<{
      product_enrichment_enabled: number;
      product_enrichment_warning_usd: number;
    }>();
  if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
  const usage = await c.env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS tasks, COALESCE(SUM(request_cost_usd), 0) AS cost
     FROM product_enrichment_jobs
     WHERE workspace_id = ? AND request_cost_usd > 0
       AND COALESCE(submitted_at, created_at) >= strftime('%Y-%m-01T00:00:00.000Z', 'now')`,
  )
    .bind(principal.workspaceId)
    .first<{ tasks: number; cost: number }>();
  const cost = Number(usage?.cost ?? 0);
  const threshold = Number(workspace.product_enrichment_warning_usd);
  return c.json({
    data: {
      enabled: workspace.product_enrichment_enabled === 1,
      monthlyWarningUsd: threshold,
      monthToDateTasks: Number(usage?.tasks ?? 0),
      monthToDateCost: cost,
      warningExceeded: threshold > 0 && cost >= threshold,
    },
  });
});

automationRoutes.patch(
  "/settings/product-enrichment",
  zValidator("json", ProductEnrichmentSettingsSchema),
  async (c) => {
    const principal = requireRole(c, "admin");
    const input = c.req.valid("json");
    const current = await c.env.CONTROL_DB.prepare(
      `SELECT product_enrichment_enabled, product_enrichment_warning_usd
       FROM workspaces WHERE id = ?`,
    )
      .bind(principal.workspaceId)
      .first<{
        product_enrichment_enabled: number;
        product_enrichment_warning_usd: number;
      }>();
    if (!current) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
    const enabled = input.enabled ?? (current.product_enrichment_enabled === 1);
    const threshold = input.monthlyWarningUsd ?? current.product_enrichment_warning_usd;
    const updatedAt = nowIso();
    const statements: D1PreparedStatement[] = [
      c.env.CONTROL_DB.prepare(
        `UPDATE workspaces SET product_enrichment_enabled = ?,
          product_enrichment_warning_usd = ?, updated_at = ? WHERE id = ?`,
      ).bind(enabled ? 1 : 0, threshold, updatedAt, principal.workspaceId),
    ];
    if (!enabled) {
      statements.push(
        c.env.CONTROL_DB.prepare(
          `UPDATE product_enrichment_jobs SET status = 'cancelled', active_slot = NULL,
            error_code = 'workspace_paused', error_message = 'Workspace product enrichment is paused.',
            updated_at = ?
           WHERE workspace_id = ? AND status IN ('queued', 'submission_unknown')`,
        ).bind(updatedAt, principal.workspaceId),
        c.env.CONTROL_DB.prepare(
          `UPDATE product_enrichment_targets SET
            status = CASE WHEN latest_snapshot_id IS NULL THEN 'paused' ELSE 'available' END,
            current_job_id = CASE
              WHEN current_job_id IN (
                SELECT id FROM product_enrichment_jobs
                WHERE workspace_id = ? AND status = 'cancelled'
              ) THEN NULL ELSE current_job_id END,
            updated_at = ? WHERE workspace_id = ?`,
        ).bind(principal.workspaceId, updatedAt, principal.workspaceId),
      );
    }
    await c.env.CONTROL_DB.batch(statements);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "product_enrichment.settings_updated",
      resourceType: "workspace",
      resourceId: principal.workspaceId,
    });
    return c.json({ data: { enabled, monthlyWarningUsd: threshold } });
  },
);

automationRoutes.get("/settings/health", async (c) => {
  const principal = requireRole(c, "admin");
  const [workspace, jobs, shards, dlq, payments] = await Promise.all([
    c.env.CONTROL_DB.prepare(
      `SELECT id, name, public_base_url, monthly_run_cap, timezone
       FROM workspaces WHERE id = ?`,
    )
      .bind(principal.workspaceId)
      .first<{
        id: string;
        name: string;
        public_base_url: string;
        monthly_run_cap: number;
        timezone: string;
      }>(),
    c.env.CONTROL_DB.prepare(
      `SELECT status, COUNT(*) AS count FROM crawl_jobs
       WHERE workspace_id = ?
         AND julianday(created_at) >= julianday('now', '-24 hours')
       GROUP BY status`,
    )
      .bind(principal.workspaceId)
      .all(),
    c.env.CONTROL_DB.prepare(
      "SELECT * FROM shard_registry ORDER BY shard_id",
    ).all(),
    c.env.CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count FROM ingest_events
       WHERE status = 'failed'
         AND julianday(received_at) >= julianday('now', '-24 hours')`,
    ).first(),
    paymentProviderConfiguration(c.env),
  ]);
  const defaultPayment = payments.accounts.find(
    (account) => account.id === payments.defaultProviderAccountId,
  );
  return c.json({
    data: {
      workspace,
      jobs: jobs.results,
      shards: shards.results,
      failedIngestEvents: dlq,
      provider: {
        dataForSeo: {
          configured: await hasConfiguredCaptureProviderType(c.env, "dataforseo"),
          source: "provider_registry",
          account: "Platform DataForSEO account",
        },
        payments: {
          configured: !payments.required || Boolean(
            payments.enabled && defaultPayment?.credentialConfigured,
          ),
          mode: String(c.env.PAYMENT_MODE),
          provider: defaultPayment?.provider ?? null,
          providerLabel: defaultPayment?.providerLabel ?? null,
          environment: defaultPayment?.environment ?? null,
          planChangesEnabled: String(c.env.BILLING_PLAN_CHANGES_ENABLED) === "true",
          source: defaultPayment?.credentialSource ?? null,
        },
        email: {
          configured: emailDeliveryConfigured(c.env),
          source: "worker_binding",
        },
      },
      publicOrigin: {
        configured: configuredPublicAppOrigin(c.env),
        stored: workspace?.public_base_url ?? null,
      },
    },
  });
});
