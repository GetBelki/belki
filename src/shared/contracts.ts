import { z } from "zod";
import {
  MAX_PROMPT_TAG_LENGTH,
  MAX_PROMPT_TAGS,
  normalizePromptTagName,
  uniquePromptTagNames,
} from "./prompt-tags";
import { TRACKING_SOURCES } from "./tracking-sources";
import { normalizePublicAppOrigin } from "./public-origin";
import { CAPTURE_PROVIDERS } from "./capture-providers";
import {
  PAYMENT_ENVIRONMENTS,
  PAYMENT_PROVIDERS,
} from "./payment-providers";
import { normalizeCurrencyCode } from "./currency";
import { MAX_BILLING_PLANS } from "./billing-plans";

export const TrackingSourceSchema = z.enum(TRACKING_SOURCES);
export type TrackingSource = z.infer<typeof TrackingSourceSchema>;

export const CaptureProviderSchema = z.enum(CAPTURE_PROVIDERS);
export type CaptureProvider = z.infer<typeof CaptureProviderSchema>;

const ProviderLabelSchema = z.string().trim().min(2).max(120);
const ProviderSecretSchema = z.string().min(1).max(4_096);
const DataForSeoCredentialSchema = z.object({
  login: ProviderSecretSchema,
  password: ProviderSecretSchema,
});
const BrightDataCredentialSchema = z.object({ apiToken: ProviderSecretSchema });
const OlostepCredentialSchema = z.object({ apiKey: ProviderSecretSchema });
const CloroCredentialSchema = z.object({ apiKey: ProviderSecretSchema });
const OxylabsCredentialSchema = z.object({
  username: ProviderSecretSchema,
  password: ProviderSecretSchema,
});

export const CaptureProviderAccountInputSchema = z.discriminatedUnion(
  "provider",
  [
    z.object({
      provider: z.literal("dataforseo"),
      label: ProviderLabelSchema,
      credentials: DataForSeoCredentialSchema,
    }),
    z.object({
      provider: z.literal("brightdata"),
      label: ProviderLabelSchema,
      credentials: BrightDataCredentialSchema,
    }),
    z.object({
      provider: z.literal("olostep"),
      label: ProviderLabelSchema,
      credentials: OlostepCredentialSchema,
    }),
    z.object({
      provider: z.literal("cloro"),
      label: ProviderLabelSchema,
      credentials: CloroCredentialSchema,
    }),
    z.object({
      provider: z.literal("oxylabs"),
      label: ProviderLabelSchema,
      credentials: OxylabsCredentialSchema,
    }),
  ],
);
export type CaptureProviderAccountInput = z.infer<
  typeof CaptureProviderAccountInputSchema
>;

export const CaptureProviderCredentialInputSchema = z.discriminatedUnion(
  "provider",
  [
    z.object({
      provider: z.literal("dataforseo"),
      credentials: DataForSeoCredentialSchema,
    }),
    z.object({
      provider: z.literal("brightdata"),
      credentials: BrightDataCredentialSchema,
    }),
    z.object({
      provider: z.literal("olostep"),
      credentials: OlostepCredentialSchema,
    }),
    z.object({
      provider: z.literal("cloro"),
      credentials: CloroCredentialSchema,
    }),
    z.object({
      provider: z.literal("oxylabs"),
      credentials: OxylabsCredentialSchema,
    }),
  ],
);
export type CaptureProviderCredentialInput = z.infer<
  typeof CaptureProviderCredentialInputSchema
>;

export const CaptureProviderAccountUpdateSchema = z.object({
  label: ProviderLabelSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const CaptureProviderRouteUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  providerAccountId: z.string().trim().min(1).max(200).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const PaymentProviderSchema = z.enum(PAYMENT_PROVIDERS);
export type PaymentProvider = z.infer<typeof PaymentProviderSchema>;

export const PaymentEnvironmentSchema = z.enum(PAYMENT_ENVIRONMENTS);
export type PaymentEnvironment = z.infer<typeof PaymentEnvironmentSchema>;

export const PaymentInstallationModeSchema = z.enum(["undecided", "self_hosted", "managed"]);
export type PaymentInstallationMode = z.infer<typeof PaymentInstallationModeSchema>;

export const BillingPlanIdSchema = z.string().trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u);
export const ManagedPaymentPlanKeySchema = BillingPlanIdSchema.refine(
  (value) => value !== "self_hosted",
  "Managed plan IDs cannot use the self_hosted reserved value.",
);
export type ManagedPaymentPlanKey = z.infer<typeof ManagedPaymentPlanKeySchema>;

const PaymentSecretSchema = z.string().trim().min(8).max(4_096);
const StripePriceIdSchema = z.string().trim().regex(/^price_[A-Za-z0-9_]+$/u).max(255);
const StripePortalConfigurationIdSchema = z.string().trim().regex(/^bpc_[A-Za-z0-9_]+$/u).max(255);
const DodoProductIdSchema = z.string().trim().regex(/^pdt_[A-Za-z0-9_]+$/u).max(255);
const StandardWebhookSecretSchema = z.string().trim().regex(/^whsec_[A-Za-z0-9+/=_-]+$/u).max(4_096);
export const PaymentCurrencySchema = z.string().transform((value, context) => {
  try {
    return normalizeCurrencyCode(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid payment currency.",
    });
    return z.NEVER;
  }
});
const PaymentAmountMinorSchema = z.number().int().positive().max(1_000_000_000);
const BillingAllowedSourcesSchema = z.array(TrackingSourceSchema)
  .min(1)
  .max(TRACKING_SOURCES.length)
  .transform((sources) => [...new Set(sources)]);

export const BillingPlanDefinitionInputSchema = z.object({
  id: ManagedPaymentPlanKeySchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).default(""),
  sortOrder: z.number().int().min(0).max(MAX_BILLING_PLANS - 1),
  featured: z.boolean().default(false),
  monthlyUnits: z.number().int().positive().max(1_000_000_000),
  projectLimit: z.number().int().positive().max(1_000_000),
  promptLimit: z.number().int().positive().max(1_000_000),
  sourceLimit: z.number().int().positive().max(TRACKING_SOURCES.length),
  allowedSources: BillingAllowedSourcesSchema,
}).superRefine((plan, context) => {
  if (plan.sourceLimit > plan.allowedSources.length) {
    context.addIssue({
      code: "custom",
      path: ["sourceLimit"],
      message: "Source limit cannot exceed the number of allowed tracking sources.",
    });
  }
});
export type BillingPlanDefinitionInput = z.infer<typeof BillingPlanDefinitionInputSchema>;

export const BillingPlanCatalogueInputSchema = z.array(BillingPlanDefinitionInputSchema)
  .min(1)
  .max(MAX_BILLING_PLANS)
  .superRefine((plans, context) => {
    const uniqueIds = new Set(plans.map((plan) => plan.id));
    const uniqueNames = new Set(plans.map((plan) => plan.name.toLocaleLowerCase()));
    const uniqueOrders = new Set(plans.map((plan) => plan.sortOrder));
    if (uniqueIds.size !== plans.length) {
      context.addIssue({ code: "custom", message: "Billing plan IDs must be unique." });
    }
    if (uniqueNames.size !== plans.length) {
      context.addIssue({ code: "custom", message: "Billing plan names must be unique." });
    }
    if (uniqueOrders.size !== plans.length) {
      context.addIssue({ code: "custom", message: "Billing plan order values must be unique." });
    }
    if (plans.filter((plan) => plan.featured).length > 1) {
      context.addIssue({ code: "custom", message: "Only one billing plan can be featured." });
    }
  });

function paymentCatalogueSchema(externalReference: z.ZodType<string>) {
  return z.array(z.object({
    planId: ManagedPaymentPlanKeySchema,
    externalReference,
    amountMinor: PaymentAmountMinorSchema,
  })).min(1).max(MAX_BILLING_PLANS).superRefine((plans, context) => {
    if (new Set(plans.map((plan) => plan.planId)).size !== plans.length) {
      context.addIssue({ code: "custom", message: "Each billing plan can be mapped only once." });
    }
    if (new Set(plans.map((plan) => plan.externalReference)).size !== plans.length) {
      context.addIssue({ code: "custom", message: "Provider Price/Product IDs must be unique." });
    }
  });
}

export const StripePaymentCredentialSchema = z.object({
  secretKey: PaymentSecretSchema,
  webhookSecret: PaymentSecretSchema,
});

export const StripePaymentCatalogueSchema = paymentCatalogueSchema(StripePriceIdSchema);

export const DodoPaymentCredentialSchema = z.object({
  apiKey: PaymentSecretSchema,
  webhookSecret: StandardWebhookSecretSchema,
});

export const DodoPaymentCatalogueSchema = paymentCatalogueSchema(DodoProductIdSchema);

export const PaymentProviderAccountInputSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("stripe"),
    label: ProviderLabelSchema,
    environment: PaymentEnvironmentSchema,
    webhookEndpointKey: z.string().uuid().optional(),
    credentials: StripePaymentCredentialSchema,
    currency: PaymentCurrencySchema,
    plans: BillingPlanCatalogueInputSchema,
    catalogue: StripePaymentCatalogueSchema,
    configuration: z.object({
      billingPortalConfigurationId: StripePortalConfigurationIdSchema,
    }),
  }),
  z.object({
    provider: z.literal("dodo"),
    label: ProviderLabelSchema,
    environment: PaymentEnvironmentSchema,
    webhookEndpointKey: z.string().uuid().optional(),
    credentials: DodoPaymentCredentialSchema,
    currency: PaymentCurrencySchema,
    plans: BillingPlanCatalogueInputSchema,
    catalogue: DodoPaymentCatalogueSchema,
    configuration: z.object({}),
  }),
]);
export type PaymentProviderAccountInput = z.infer<typeof PaymentProviderAccountInputSchema>;

export const PaymentProviderCredentialInputSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("stripe"),
    credentials: StripePaymentCredentialSchema,
  }),
  z.object({
    provider: z.literal("dodo"),
    credentials: DodoPaymentCredentialSchema,
  }),
]);
export type PaymentProviderCredentialInput = z.infer<typeof PaymentProviderCredentialInputSchema>;

export const PaymentProviderAccountUpdateSchema = z.object({
  label: ProviderLabelSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");
export type PaymentProviderAccountUpdate = z.infer<typeof PaymentProviderAccountUpdateSchema>;

export const PaymentProviderCatalogueUpdateSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("stripe"),
    currency: PaymentCurrencySchema,
    plans: BillingPlanCatalogueInputSchema,
    catalogue: StripePaymentCatalogueSchema,
    configuration: z.object({
      billingPortalConfigurationId: StripePortalConfigurationIdSchema,
    }),
  }),
  z.object({
    provider: z.literal("dodo"),
    currency: PaymentCurrencySchema,
    plans: BillingPlanCatalogueInputSchema,
    catalogue: DodoPaymentCatalogueSchema,
    configuration: z.object({}),
  }),
]);
export type PaymentProviderCatalogueUpdate = z.infer<typeof PaymentProviderCatalogueUpdateSchema>;

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

export const PlanKeySchema = z.union([z.literal("self_hosted"), ManagedPaymentPlanKeySchema]);
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
  planKey: ManagedPaymentPlanKeySchema,
});

export const BillingPlanChangeSchema = z.object({
  planKey: ManagedPaymentPlanKeySchema,
  replacePending: z.boolean().default(false),
});

export const BillingPlanChangePreviewSchema = z.object({
  planKey: ManagedPaymentPlanKeySchema,
});

export const BillingCancellationSchema = z.object({
  replacePending: z.boolean().default(false),
});

export const InviteSchema = z.object({
  email: z.string().trim().email().max(320),
  role: RoleSchema.exclude(["owner"]),
  sendEmail: z.boolean().default(false),
});

export const InvitationTokenSchema = z.object({
  token: z.string().min(32),
});

export const AcceptInviteSchema = InvitationTokenSchema.extend({
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(256),
});

export const CompletePasswordResetSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(12).max(256),
});

export const PublicAppOriginSchema = z.string().trim().max(2_048).transform((value, context) => {
  try {
    return normalizePublicAppOrigin(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Enter a valid public application URL.",
    });
    return z.NEVER;
  }
});

export const WorkspaceUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  publicBaseUrl: PublicAppOriginSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

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
