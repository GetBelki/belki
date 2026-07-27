import { z } from "zod";

export const RoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const DailyScheduleSchema = z.object({
  cadence: z.literal("daily"),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
});

export const WeeklyScheduleSchema = z.object({
  cadence: z.literal("weekly"),
  weekday: z.number().int().min(0).max(6),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
});

export const ScheduleSchema = z.discriminatedUnion("cadence", [
  DailyScheduleSchema,
  WeeklyScheduleSchema,
]);
export type Schedule = z.infer<typeof ScheduleSchema>;

export const SetupSchema = z.object({
  bootstrapToken: z.string().min(16),
  workspaceName: z.string().trim().min(2).max(120),
  displayName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(320),
  password: z.string().min(12).max(256),
  timezone: z.string().min(1).max(100).default("UTC"),
  monthlyRunCap: z.number().int().min(1_000).max(100_000_000).default(1_000_000),
});

export const LoginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(256),
});

export const InviteSchema = z.object({
  email: z.string().trim().email().max(320),
  role: RoleSchema.exclude(["owner"]),
});

export const AcceptInviteSchema = z.object({
  token: z.string().min(32),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(256),
});

export const CompletePasswordResetSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(12).max(256),
});

export const ProjectInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  primaryDomain: z.string().trim().max(253).optional().nullable(),
  ownedBrandName: z.string().trim().min(1).max(120),
  ownedBrandAliases: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  competitorBrands: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        aliases: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
        domains: z.array(z.string().trim().min(1).max(253)).max(50).default([]),
      }),
    )
    .max(100)
    .default([]),
  htmlCaptureEnabled: z.boolean().default(false),
});

export const ProjectUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  primaryDomain: z.string().trim().max(253).optional().nullable(),
  htmlCaptureEnabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const BrandInputSchema = z.object({
  kind: z.enum(["owned", "competitor"]),
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  domains: z.array(z.string().trim().min(1).max(253)).max(50).default([]),
});

export const QueryInputSchema = z.object({
  queryText: z.string().trim().min(1).max(2_000),
  locationCode: z.number().int(),
  languageCode: z.string().trim().min(1).max(20),
  forceWebSearch: z.boolean().default(true),
  schedule: ScheduleSchema,
});

export const QueryUpdateSchema = QueryInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);

export const MembershipUpdateSchema = z.object({
  role: RoleSchema.exclude(["owner"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const ManualRunSchema = z.object({
  captureHtml: z.boolean().default(false),
});

export const AlertRuleInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  eventType: z.enum([
    "run_failed",
    "own_citation_lost",
    "brand_mention_lost",
    "competitor_citation_gained",
    "product_block_changed",
    "visibility_drop",
  ]),
  threshold: z.number().min(0).max(100).optional().nullable(),
  trackedBrandId: z.string().uuid().optional().nullable(),
  channels: z.array(z.enum(["in_app", "webhook"])).min(1).default(["in_app"]),
});

export const WebhookDestinationInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  url: z.string().url().refine((value) => value.startsWith("https://"), "HTTPS is required"),
});

export const ExportInputSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  format: z.enum(["csv", "ndjson"]),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
});

export const RunStatusSchema = z.enum([
  "queued",
  "submitting",
  "submission_unknown",
  "submitted",
  "awaiting_result",
  "normalizing",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export interface Principal {
  userId: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: Role;
  sessionId: string;
}

export interface JobQueueMessage {
  jobId: string;
}

export interface NormalizeQueueMessage {
  jobId: string;
  taskId: string;
  rawR2Key: string;
  contentEncoding: "gzip" | "identity";
}

export interface RollupQueueMessage {
  snapshotId: string;
  shardId: number;
}

export interface ExportQueueMessage {
  exportId: string;
}

export interface NotificationQueueMessage {
  deliveryId: string;
}

export interface ApiErrorShape {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
