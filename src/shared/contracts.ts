import { z } from "zod";
import {
  MAX_PROMPT_TAG_LENGTH,
  MAX_PROMPT_TAGS,
  normalizePromptTagName,
  uniquePromptTagNames,
} from "./prompt-tags";
import { TRACKING_SOURCES } from "./tracking-sources";

export const TrackingSourceSchema = z.enum(TRACKING_SOURCES);
export type TrackingSource = z.infer<typeof TrackingSourceSchema>;

export const RoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const WorkspaceStatusSchema = z.enum([
  "pending_payment",
  "active",
  "read_only",
  "suspended",
  "deleted",
]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

export const MembershipStatusSchema = z.enum(["active", "suspended", "removed"]);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

export const PlanKeySchema = z.enum(["self_hosted", "starter", "studio", "agency", "custom"]);
export type PlanKey = z.infer<typeof PlanKeySchema>;

export const PaymentModeSchema = z.enum(["disabled", "stripe_managed", "stripe_direct"]);
export type PaymentMode = z.infer<typeof PaymentModeSchema>;

export const StripeEnvironmentSchema = z.enum(["test", "live"]);
export type StripeEnvironment = z.infer<typeof StripeEnvironmentSchema>;

export const SubscriptionStatusSchema = z.enum([
  "pending",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "cancelled",
  "paused",
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const UsageSkuSchema = z.enum([
  "llm_standard",
  "llm_priority_html",
  "llm_live",
  "entity_extraction",
  "product_enrichment",
]);
export type UsageSku = z.infer<typeof UsageSkuSchema>;

export const UsageReservationStatusSchema = z.enum(["reserved", "committed", "released"]);
export type UsageReservationStatus = z.infer<typeof UsageReservationStatusSchema>;

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

export const WorkspaceSelectionSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const SignupCodeRedeemSchema = z.object({
  code: z.string().min(32),
  email: z.string().trim().email().max(320),
  workspaceName: z.string().trim().min(2).max(120),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(256),
  timezone: z.string().min(1).max(100).default("UTC"),
});

export const SignupCodeCreateSchema = z.object({
  email: z.string().trim().email().max(320),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const PasswordResetRequestSchema = z.object({
  email: z.string().trim().email().max(320),
});

export const BillingCheckoutSchema = z.object({
  planKey: PlanKeySchema.exclude(["self_hosted", "custom"]),
});

export const BillingPlanChangeSchema = z.object({
  planKey: PlanKeySchema.exclude(["self_hosted", "custom"]),
  replacePending: z.boolean().default(false),
});

export const BillingPlanChangePreviewSchema = z.object({
  planKey: PlanKeySchema.exclude(["self_hosted", "custom"]),
});

export const BillingCancellationSchema = z.object({
  replacePending: z.boolean().default(false),
});

export const InviteSchema = z.object({
  email: z.string().trim().email().max(320),
  role: RoleSchema.exclude(["owner"]),
  sendEmail: z.boolean().default(false),
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

export const WorkspaceUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120),
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

export const ProjectFeatureSettingsSchema = z.object({
  htmlCaptureEnabled: z.boolean().optional(),
  productEnrichmentEnabled: z.boolean().optional(),
  entityExtractionEnabled: z.boolean().optional(),
  entityAutoTrackEnabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const ProjectTrackingSourcesSchema = z.object({
  sources: z.array(TrackingSourceSchema).min(1).max(TRACKING_SOURCES.length)
    .transform((sources) => [...new Set(sources)]),
});

export const ProjectBillingAlertsSchema = z.object({
  productEnrichmentWarningUsd: z.number().finite().min(0).max(1_000_000).optional(),
  entityExtractionWarningUsd: z.number().finite().min(0).max(1_000_000).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const ProductEnrichmentSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  monthlyWarningUsd: z.number().finite().min(0).max(1_000_000).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const EntityExtractionSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  autoTrackEnabled: z.boolean().optional(),
  monthlyWarningUsd: z.number().finite().min(0).max(1_000_000).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const EntityActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("track") }),
  z.object({ action: z.literal("ignore") }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("merge"), targetEntityId: z.string().uuid() }),
]);

export const ProductEnrichmentPreferenceSchema = z.object({
  projectId: z.string().uuid(),
  automaticRefreshEnabled: z.boolean(),
});

export const ProductEnrichmentRequestSchema = z.object({
  projectId: z.string().uuid(),
  locationCode: z.number().int(),
  languageCode: z.string().trim().min(1).max(20),
});

export const BrandInputSchema = z.object({
  kind: z.enum(["owned", "competitor"]),
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  domains: z.array(z.string().trim().min(1).max(253)).max(50).default([]),
});

export const PromptTagNameSchema = z.string().transform(normalizePromptTagName).pipe(
  z.string().min(1).max(MAX_PROMPT_TAG_LENGTH),
);

export const PromptTagsSchema = z
  .array(PromptTagNameSchema)
  .max(MAX_PROMPT_TAGS)
  .default([])
  .transform(uniquePromptTagNames);

export const QueryInputSchema = z.object({
  queryText: z.string().trim().min(1).max(2_000),
  locationCode: z.number().int(),
  languageCode: z.string().trim().min(1).max(20),
  forceWebSearch: z.boolean().default(true),
  schedule: ScheduleSchema,
  tags: PromptTagsSchema,
});

export const BulkQueryInputSchema = QueryInputSchema.omit({
  queryText: true,
}).extend({
  queryTexts: z
    .array(z.string().trim().min(1).max(2_000))
    .min(1)
    .max(50)
    .optional(),
  items: z
    .array(
      z.object({
        queryText: z.string().trim().min(1).max(2_000),
        tags: PromptTagsSchema,
      }),
    )
    .min(1)
    .max(50)
    .optional(),
}).superRefine((value, context) => {
  if (Boolean(value.queryTexts) === Boolean(value.items)) {
    context.addIssue({
      code: "custom",
      message: "Provide either queryTexts or items.",
    });
  }
  for (const [index, item] of (value.items ?? []).entries()) {
    if (uniquePromptTagNames([...value.tags, ...item.tags]).length > MAX_PROMPT_TAGS) {
      context.addIssue({
        code: "custom",
        message: `Prompt ${index + 1} has more than ${MAX_PROMPT_TAGS} tags.`,
        path: ["items", index, "tags"],
      });
    }
  }
});

export const QueryUpdateSchema = QueryInputSchema.omit({ tags: true }).partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);

export const QueryActivitySchema = z.object({
  active: z.boolean(),
});

export const PromptTagMutationSchema = z.object({
  queryIds: z.array(z.string().uuid()).min(1).max(50),
  tagNames: z.array(PromptTagNameSchema).min(1).max(MAX_PROMPT_TAGS).transform(
    uniquePromptTagNames,
  ),
  mode: z.enum(["add", "remove"]),
});

export const PromptPurgeInputSchema = z.object({
  queryIds: z
    .array(z.string().uuid())
    .min(1)
    .max(50)
    .transform((values) => [...new Set(values)]),
});

export const MembershipUpdateSchema = z.object({
  role: RoleSchema.exclude(["owner"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const ManualRunSchema = z.object({
  captureHtml: z.boolean().default(false),
  source: TrackingSourceSchema.default("chatgpt"),
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
  source: TrackingSourceSchema.default("chatgpt"),
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
  source: TrackingSourceSchema.optional(),
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
  workspaceStatus: WorkspaceStatus;
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

export interface PromptPurgeQueueMessage {
  purgeJobId: string;
}

export interface EntityExtractionQueueMessage {
  jobId: string;
}

export interface AdAssetQueueMessage {
  sourceUrl: string;
  kind: "creative" | "favicon";
}

export type ProductEnrichmentQueueMessage =
  | { kind: "submit"; jobId: string }
  | {
      kind: "normalize";
      jobId: string;
      taskId: string;
      rawR2Key: string;
      contentEncoding: "gzip" | "identity";
    };

export interface ApiErrorShape {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
