import type {
  BillingPlanDefinitionInput,
  ManagedPaymentPlanKey,
  PaymentEnvironment,
  PaymentInstallationMode,
  PaymentProvider,
  PaymentProviderAccountInput,
  PaymentProviderAccountUpdate,
  PaymentProviderCatalogueUpdate,
  PaymentProviderCredentialInput,
} from "../../shared/contracts";
import {
  PAYMENT_PROVIDER_LABELS,
} from "../../shared/payment-providers";
import { DEFAULT_BILLING_PLANS } from "../../shared/billing-plans";
import { TRACKING_SOURCES, type TrackingSource } from "../../shared/tracking-sources";
import { decryptPaymentCredential, encryptPaymentCredential } from "../lib/payment-credential-vault";
import { ApiError, jsonParse, nowIso } from "../lib/http";
import { optionalBinding } from "../lib/stripe";
import { PAYMENT_PROVIDER_ADAPTERS, paymentProviderAdapter } from "./registry";
import type {
  PaymentProviderPlanCatalogue,
  PaymentProviderTestResult,
  ResolvedPaymentProviderAccount,
} from "./types";

interface PaymentProviderAccountRow {
  id: string;
  provider: PaymentProvider;
  label: string;
  environment: PaymentEnvironment;
  status: "active" | "disabled";
  credential_source: "environment" | "database";
  configuration_source: "environment" | "database";
  active_credential_version: number | null;
  is_default: number;
  adapter_version: string;
  configuration_json: string;
  webhook_endpoint_key: string;
  last_test_status: "passed" | "failed" | null;
  last_tested_at: string | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

interface PaymentCredentialRow {
  algorithm: string;
  key_version: number;
  ciphertext: string;
  nonce: string;
}

interface PaymentPlanRow {
  provider_account_id: string;
  billing_plan_id: ManagedPaymentPlanKey;
  name: string;
  description: string;
  sort_order: number;
  is_featured: number;
  monthly_units: number;
  project_limit: number;
  prompt_limit: number;
  source_limit: number;
  allowed_sources_json: string;
  external_reference: string;
  external_product_id: string | null;
  currency: string;
  amount_minor: number;
  billing_interval: "month";
}

interface BillingPlanRow {
  id: ManagedPaymentPlanKey;
  name: string;
  description: string;
  sort_order: number;
  is_featured: number;
  status: "active" | "archived";
  monthly_units: number;
  project_limit: number;
  prompt_limit: number;
  source_limit: number;
  allowed_sources_json: string;
}

interface PaymentConfigurationRow {
  mode: PaymentInstallationMode;
  enabled: number;
  default_provider_account_id: string | null;
}

const LEGACY_STRIPE_ACCOUNT_ID = "stripe:legacy:v1";

function deploymentManaged(env: Env): boolean {
  return String(env.DEPLOYMENT_MODE) === "managed";
}

function paymentKillSwitchEnabled(env: Env): boolean {
  return String(env.PAYMENT_MODE) !== "disabled";
}

function stripeEnvironmentFromBindings(env: Env): PaymentEnvironment | null {
  const value = optionalBinding(env, "STRIPE_ENVIRONMENT");
  return value === "test" || value === "live" ? value : null;
}

export function legacyStripePaymentInput(
  env: Env,
): Extract<PaymentProviderAccountInput, { provider: "stripe" }> | null {
  const environment = stripeEnvironmentFromBindings(env);
  const secretKey = optionalBinding(env, "STRIPE_SECRET_KEY");
  const webhookSecret = optionalBinding(env, "STRIPE_WEBHOOK_SECRET");
  const starter = optionalBinding(env, "STRIPE_STARTER_PRICE_ID");
  const studio = optionalBinding(env, "STRIPE_STUDIO_PRICE_ID");
  const agency = optionalBinding(env, "STRIPE_AGENCY_PRICE_ID");
  const billingPortalConfigurationId = optionalBinding(
    env,
    "STRIPE_BILLING_ACTION_PORTAL_CONFIGURATION_ID",
  );
  if (
    !environment || !secretKey || !webhookSecret || !starter || !studio || !agency ||
    !billingPortalConfigurationId
  ) {
    return null;
  }
  return {
    provider: "stripe",
    label: "Platform Stripe account",
    environment,
    credentials: { secretKey, webhookSecret },
    currency: "EUR",
    plans: DEFAULT_BILLING_PLANS.map((plan) => ({ ...plan })),
    catalogue: [
      { planId: "starter", externalReference: starter, amountMinor: 1_000 },
      { planId: "studio", externalReference: studio, amountMinor: 2_900 },
      { planId: "agency", externalReference: agency, amountMinor: 14_900 },
    ],
    configuration: { billingPortalConfigurationId },
  };
}

function inputCatalogue(input: PaymentProviderAccountInput): PaymentProviderPlanCatalogue {
  const definitions = new Map(input.plans.map((plan) => [plan.id, plan]));
  if (
    input.catalogue.length !== input.plans.length ||
    input.plans.some((plan) => !input.catalogue.some((mapping) => mapping.planId === plan.id))
  ) {
    throw new ApiError(422, "payment_plan_mapping_invalid", "Every active billing plan requires exactly one provider mapping.");
  }
  return Object.fromEntries(input.catalogue.map((mapping) => {
    const definition = definitions.get(mapping.planId);
    if (!definition) {
      throw new ApiError(422, "payment_plan_mapping_invalid", `Payment mapping ${mapping.planId} has no plan definition.`);
    }
    return [mapping.planId, {
      ...definition,
      planKey: mapping.planId,
      externalReference: mapping.externalReference,
      externalProductId: input.provider === "dodo" ? mapping.externalReference : null,
      currency: input.currency,
      amountMinor: mapping.amountMinor,
      billingInterval: "month" as const,
    }];
  }));
}

function inputCredentials(input: PaymentProviderAccountInput): PaymentProviderCredentialInput {
  return input.provider === "stripe"
    ? { provider: "stripe", credentials: input.credentials }
    : { provider: "dodo", credentials: input.credentials };
}

function catalogueFromRows(rows: PaymentPlanRow[]): PaymentProviderPlanCatalogue | null {
  if (!rows.length) return null;
  const parsed = rows.map((row) => ({
    row,
    allowedSources: jsonParse<TrackingSource[]>(row.allowed_sources_json, [])
      .filter((source) => TRACKING_SOURCES.includes(source)),
  }));
  if (parsed.some(({ allowedSources }) => !allowedSources.length)) return null;
  return Object.fromEntries(parsed.map(({ row, allowedSources }) => {
    return [row.billing_plan_id, {
      id: row.billing_plan_id,
      planKey: row.billing_plan_id,
      name: row.name,
      description: row.description,
      sortOrder: Number(row.sort_order),
      featured: row.is_featured === 1,
      monthlyUnits: Number(row.monthly_units),
      projectLimit: Number(row.project_limit),
      promptLimit: Number(row.prompt_limit),
      sourceLimit: Number(row.source_limit),
      allowedSources,
      externalReference: row.external_reference,
      externalProductId: row.external_product_id,
      currency: row.currency,
      amountMinor: Number(row.amount_minor),
      billingInterval: row.billing_interval,
    }];
  }));
}

function resolvedInput(
  accountId: string,
  adapterVersion: string,
  webhookEndpointKey: string,
  input: PaymentProviderAccountInput,
  credentialVersion: number | null,
): ResolvedPaymentProviderAccount {
  return {
    accountId,
    provider: input.provider,
    label: input.label,
    environment: input.environment,
    adapterVersion,
    credentialVersion,
    credentials: inputCredentials(input),
    catalogue: inputCatalogue(input),
    configuration: input.configuration,
    webhookEndpointKey,
  };
}

async function accountRows(env: Env): Promise<PaymentProviderAccountRow[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT id, provider, label, environment, status, credential_source,
      configuration_source, active_credential_version, is_default,
      adapter_version, configuration_json, webhook_endpoint_key,
      last_test_status, last_tested_at, last_test_message, created_at, updated_at
     FROM payment_provider_accounts
     ORDER BY is_default DESC, created_at, id`,
  ).all<PaymentProviderAccountRow>();
  return result.results;
}

async function configurationRow(env: Env): Promise<PaymentConfigurationRow> {
  return await env.CONTROL_DB.prepare(
    "SELECT mode, enabled, default_provider_account_id FROM payment_configuration WHERE id = 'installation'",
  ).first<PaymentConfigurationRow>() ?? {
    mode: "undecided",
    enabled: 0,
    default_provider_account_id: null,
  };
}

function billingPlanDefinition(row: BillingPlanRow): BillingPlanDefinitionInput {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sortOrder: Number(row.sort_order),
    featured: row.is_featured === 1,
    monthlyUnits: Number(row.monthly_units),
    projectLimit: Number(row.project_limit),
    promptLimit: Number(row.prompt_limit),
    sourceLimit: Number(row.source_limit),
    allowedSources: jsonParse<TrackingSource[]>(row.allowed_sources_json, [])
      .filter((source) => TRACKING_SOURCES.includes(source)),
  };
}

async function billingPlanRows(env: Env): Promise<BillingPlanRow[]> {
  return (await env.CONTROL_DB.prepare(
    `SELECT id, name, description, sort_order, is_featured, status,
      monthly_units, project_limit, prompt_limit, source_limit,
      allowed_sources_json
     FROM billing_plans WHERE status = 'active'
     ORDER BY sort_order, id`,
  ).all<BillingPlanRow>()).results;
}

async function planRows(env: Env, accountId?: string): Promise<PaymentPlanRow[]> {
  const statement = accountId
    ? env.CONTROL_DB.prepare(
        `SELECT mapping.provider_account_id, mapping.billing_plan_id,
          plan.name, plan.description, plan.sort_order, plan.is_featured,
          plan.monthly_units, plan.project_limit, plan.prompt_limit,
          plan.source_limit, plan.allowed_sources_json,
          mapping.external_reference, mapping.external_product_id,
          mapping.currency, mapping.amount_minor, mapping.billing_interval
         FROM payment_provider_plan_mappings mapping
         JOIN billing_plans plan ON plan.id = mapping.billing_plan_id
         WHERE mapping.provider_account_id = ? AND plan.status = 'active'
         ORDER BY plan.sort_order, plan.id`,
      ).bind(accountId)
    : env.CONTROL_DB.prepare(
        `SELECT mapping.provider_account_id, mapping.billing_plan_id,
          plan.name, plan.description, plan.sort_order, plan.is_featured,
          plan.monthly_units, plan.project_limit, plan.prompt_limit,
          plan.source_limit, plan.allowed_sources_json,
          mapping.external_reference, mapping.external_product_id,
          mapping.currency, mapping.amount_minor, mapping.billing_interval
         FROM payment_provider_plan_mappings mapping
         JOIN billing_plans plan ON plan.id = mapping.billing_plan_id
         WHERE plan.status = 'active'
         ORDER BY plan.sort_order, plan.id`,
      );
  return (await statement.all<PaymentPlanRow>()).results;
}

function planDefinitionsMatch(
  left: readonly BillingPlanDefinitionInput[],
  right: readonly BillingPlanDefinitionInput[],
): boolean {
  const normalize = (plans: readonly BillingPlanDefinitionInput[]) => [...plans]
    .sort((first, second) => first.sortOrder - second.sortOrder || first.id.localeCompare(second.id))
    .map((plan) => ({ ...plan, allowedSources: [...plan.allowedSources].sort() }));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function environmentAccountConfigured(
  env: Env,
  account: PaymentProviderAccountRow,
  billingPlans: BillingPlanRow[],
): boolean {
  const legacy = legacyStripePaymentInput(env);
  return account.provider === "stripe"
    && account.credential_source === "environment"
    && account.configuration_source === "environment"
    && legacy !== null
    && planDefinitionsMatch(legacy.plans, billingPlans.map(billingPlanDefinition));
}

function databaseAccountConfigured(
  account: PaymentProviderAccountRow,
  plans: PaymentPlanRow[],
  billingPlans: BillingPlanRow[],
): boolean {
  const catalogue = catalogueFromRows(plans.filter((plan) => plan.provider_account_id === account.id));
  return account.credential_source === "database"
    && account.configuration_source === "database"
    && account.active_credential_version !== null
    && catalogue !== null
    && billingPlans.every((plan) => catalogue[plan.id]);
}

function accountConfigured(
  env: Env,
  account: PaymentProviderAccountRow,
  plans: PaymentPlanRow[],
  billingPlans: BillingPlanRow[],
): boolean {
  const definition = PAYMENT_PROVIDER_ADAPTERS[account.provider];
  return definition.implemented && definition.version === account.adapter_version &&
    (environmentAccountConfigured(env, account, billingPlans) ||
      databaseAccountConfigured(account, plans, billingPlans));
}

function publicAccount(
  env: Env,
  account: PaymentProviderAccountRow,
  plans: PaymentPlanRow[],
  billingPlans: BillingPlanRow[],
  subscriptionCount = 0,
) {
  const legacy = account.credential_source === "environment" ? legacyStripePaymentInput(env) : null;
  const effectiveEnvironment = legacy?.environment ?? account.environment;
  const accountPlans = plans.filter((plan) => plan.provider_account_id === account.id);
  return {
    id: account.id,
    provider: account.provider,
    providerLabel: PAYMENT_PROVIDER_LABELS[account.provider],
    label: account.label,
    environment: effectiveEnvironment,
    status: account.status,
    credentialSource: account.credential_source,
    configurationSource: account.configuration_source,
    credentialConfigured: accountConfigured(env, account, plans, billingPlans),
    credentialVersion: account.active_credential_version,
    isDefault: account.is_default === 1,
    adapterVersion: account.adapter_version,
    webhookEndpointKey: account.webhook_endpoint_key,
    webhookPath: `/api/webhooks/payments/${encodeURIComponent(account.webhook_endpoint_key)}`,
    catalogue: billingPlans.map((planDefinition) => {
      const row = accountPlans.find((plan) => plan.billing_plan_id === planDefinition.id);
      const legacyPlan = legacy?.catalogue.find((mapping) => mapping.planId === planDefinition.id);
      const externalReference = legacyPlan?.externalReference ?? row?.external_reference ?? null;
      return {
        planId: planDefinition.id,
        planName: planDefinition.name,
        externalReference,
        currency: legacy?.currency ?? row?.currency ?? null,
        amountMinor: legacyPlan?.amountMinor ?? (row ? Number(row.amount_minor) : null),
        configured: Boolean(externalReference),
      };
    }),
    activeSubscriptions: subscriptionCount,
    lastTestStatus: account.last_test_status,
    lastTestedAt: account.last_tested_at,
    lastTestMessage: account.last_test_message,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
  };
}

async function decryptDatabaseCredential(
  env: Env,
  account: PaymentProviderAccountRow,
): Promise<PaymentProviderCredentialInput> {
  const version = account.active_credential_version;
  if (version === null) {
    throw new ApiError(503, "payment_credentials_missing", "Payment provider credentials are not configured.");
  }
  const encrypted = await env.CONTROL_DB.prepare(
    `SELECT algorithm, key_version, ciphertext, nonce
     FROM payment_provider_credentials
     WHERE provider_account_id = ? AND version = ? AND revoked_at IS NULL`,
  ).bind(account.id, version).first<PaymentCredentialRow>();
  if (!encrypted) {
    throw new ApiError(503, "payment_credentials_missing", "Payment provider credentials are not configured.");
  }
  return decryptPaymentCredential(
    env.APP_CRYPTO_KEY,
    {
      accountId: account.id,
      provider: account.provider,
      environment: account.environment,
      version,
    },
    {
      algorithm: encrypted.algorithm,
      keyVersion: encrypted.key_version,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
    },
  );
}

async function resolvedAccount(
  env: Env,
  account: PaymentProviderAccountRow,
): Promise<ResolvedPaymentProviderAccount> {
  const definition = PAYMENT_PROVIDER_ADAPTERS[account.provider];
  if (!definition.adapter || definition.version !== account.adapter_version) {
    throw new ApiError(
      503,
      "payment_adapter_version_unavailable",
      `Adapter ${account.adapter_version} is not installed for ${definition.label}.`,
    );
  }
  if (account.credential_source === "environment" || account.configuration_source === "environment") {
    const legacy = legacyStripePaymentInput(env);
    if (!legacy || account.provider !== "stripe") {
      throw new ApiError(503, "payment_not_configured", "The legacy Stripe configuration is incomplete.");
    }
    const definitions = await billingPlanRows(env);
    if (!planDefinitionsMatch(legacy.plans, definitions.map(billingPlanDefinition))) {
      throw new ApiError(503, "payment_catalogue_missing", "The legacy Stripe catalogue does not match this installation's billing plans.");
    }
    return resolvedInput(
      account.id,
      account.adapter_version,
      account.webhook_endpoint_key,
      legacy,
      null,
    );
  }
  const [credentials, plans, definitions] = await Promise.all([
    decryptDatabaseCredential(env, account),
    planRows(env, account.id),
    billingPlanRows(env),
  ]);
  const catalogue = catalogueFromRows(plans);
  if (!catalogue || definitions.some((plan) => !catalogue[plan.id])) {
    throw new ApiError(503, "payment_catalogue_missing", "The payment plan catalogue is incomplete.");
  }
  return {
    accountId: account.id,
    provider: account.provider,
    label: account.label,
    environment: account.environment,
    adapterVersion: account.adapter_version,
    credentialVersion: account.active_credential_version,
    credentials,
    catalogue,
    configuration: jsonParse<Record<string, unknown>>(account.configuration_json, {}),
    webhookEndpointKey: account.webhook_endpoint_key,
  };
}

async function accountById(env: Env, accountId: string): Promise<PaymentProviderAccountRow> {
  const account = (await accountRows(env)).find((candidate) => candidate.id === accountId);
  if (!account) throw new ApiError(404, "payment_provider_account_not_found", "Payment provider account not found.");
  return account;
}

export async function paymentProviderConfiguration(env: Env) {
  const [accounts, plans, billingPlans, configuration, subscriptionCounts] = await Promise.all([
    accountRows(env),
    planRows(env),
    billingPlanRows(env),
    configurationRow(env),
    env.CONTROL_DB.prepare(
      `SELECT subscription.provider_account_id, COUNT(*) AS count
       FROM workspace_billing_subscriptions subscription
       JOIN billing_accounts billing ON billing.workspace_id = subscription.workspace_id
       WHERE subscription.external_subscription_id IS NOT NULL
         AND billing.status != 'cancelled'
       GROUP BY subscription.provider_account_id`,
    ).all<{ provider_account_id: string; count: number }>(),
  ]);
  const counts = new Map(subscriptionCounts.results.map((row) => [row.provider_account_id, Number(row.count)]));
  return {
    mode: configuration.mode,
    required: configuration.mode === "managed",
    deploymentMode: deploymentManaged(env) ? "managed" : "self_hosted",
    enabled: configuration.enabled === 1,
    runtimeKillSwitch: paymentKillSwitchEnabled(env),
    defaultProviderAccountId: configuration.default_provider_account_id,
    plans: billingPlans.map(billingPlanDefinition),
    legacyImportAvailable: legacyStripePaymentInput(env) !== null
      && !accounts.some((account) => account.id === LEGACY_STRIPE_ACCOUNT_ID && account.credential_source === "database"),
    providers: Object.values(PAYMENT_PROVIDER_ADAPTERS).map((definition) => ({
      id: definition.id,
      label: definition.label,
      version: definition.version,
      implemented: definition.implemented,
      capabilities: definition.capabilities,
    })),
    accounts: accounts.map((account) => publicAccount(
      env,
      account,
      plans,
      billingPlans,
      counts.get(account.id) ?? 0,
    )),
  };
}

async function hasConfiguredPaymentSelection(env: Env): Promise<boolean> {
  const [accounts, plans, billingPlans, configuration] = await Promise.all([
    accountRows(env),
    planRows(env),
    billingPlanRows(env),
    configurationRow(env),
  ]);
  const selected = accounts.find((account) => account.id === configuration.default_provider_account_id);
  return Boolean(
    configuration.enabled === 1
      && selected
      && selected.status === "active"
      && accountConfigured(env, selected, plans, billingPlans),
  );
}

export async function hasConfiguredPaymentProvider(env: Env): Promise<boolean> {
  const configuration = await configurationRow(env);
  if (configuration.mode === "self_hosted") return true;
  if (configuration.mode === "undecided") return false;
  return hasConfiguredPaymentSelection(env);
}

export async function managedPaymentsEnabled(env: Env): Promise<boolean> {
  const configuration = await configurationRow(env);
  return configuration.mode === "managed"
    && deploymentManaged(env)
    && paymentKillSwitchEnabled(env)
    && await hasConfiguredPaymentProvider(env);
}

export async function resolveDefaultPaymentProviderAccount(
  env: Env,
): Promise<ResolvedPaymentProviderAccount> {
  const configuration = await configurationRow(env);
  if (
    configuration.mode !== "managed" || configuration.enabled !== 1 ||
    !configuration.default_provider_account_id
  ) {
    throw new ApiError(503, "payment_not_configured", "No payment provider is selected for this installation.");
  }
  const account = await accountById(env, configuration.default_provider_account_id);
  if (account.status !== "active") {
    throw new ApiError(503, "payment_provider_disabled", "The selected payment provider account is disabled.");
  }
  return resolvedAccount(env, account);
}

export async function resolvePaymentProviderAccount(
  env: Env,
  accountId: string,
): Promise<ResolvedPaymentProviderAccount> {
  const account = await accountById(env, accountId);
  if (account.status !== "active") {
    throw new ApiError(503, "payment_provider_disabled", "The payment provider account is disabled.");
  }
  return resolvedAccount(env, account);
}

export async function resolvePaymentProviderForWorkspace(
  env: Env,
  workspaceId: string,
): Promise<ResolvedPaymentProviderAccount> {
  const link = await env.CONTROL_DB.prepare(
    "SELECT provider_account_id FROM workspace_billing_subscriptions WHERE workspace_id = ?",
  ).bind(workspaceId).first<{ provider_account_id: string }>();
  return link
    ? resolvePaymentProviderAccount(env, link.provider_account_id)
    : resolveDefaultPaymentProviderAccount(env);
}

export async function resolvePaymentProviderByWebhookEndpoint(
  env: Env,
  endpointKey: string,
): Promise<ResolvedPaymentProviderAccount> {
  const account = (await accountRows(env)).find(
    (candidate) => candidate.webhook_endpoint_key === endpointKey,
  );
  if (!account || account.status !== "active") {
    throw new ApiError(404, "payment_webhook_not_found", "Payment webhook endpoint not found.");
  }
  return resolvedAccount(env, account);
}

async function billingPlanStatements(
  env: Env,
  plans: BillingPlanDefinitionInput[],
  now: string,
): Promise<D1PreparedStatement[]> {
  const [current, paymentAccounts] = await Promise.all([
    billingPlanRows(env),
    env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM payment_provider_accounts")
      .first<{ count: number }>(),
  ]);
  if (planDefinitionsMatch(current.map(billingPlanDefinition), plans)) return [];
  if (Number(paymentAccounts?.count ?? 0) > 0) {
    throw new ApiError(
      409,
      "billing_plans_locked",
      "Billing plan definitions are locked after the first payment account is created. Map the existing plans to the new provider.",
    );
  }
  const planIds = plans.map((plan) => plan.id);
  const placeholders = planIds.map(() => "?").join(",");
  return [
    env.CONTROL_DB.prepare(
      `UPDATE billing_plans SET status = 'archived', is_featured = 0, updated_at = ?
       WHERE status = 'active' AND id NOT IN (${placeholders})`,
    ).bind(now, ...planIds),
    ...plans.map((plan) => env.CONTROL_DB.prepare(
      `INSERT INTO billing_plans (
        id, name, description, sort_order, is_featured, status,
        monthly_units, project_limit, prompt_limit, source_limit,
        allowed_sources_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        sort_order = excluded.sort_order,
        is_featured = excluded.is_featured,
        status = 'active',
        monthly_units = excluded.monthly_units,
        project_limit = excluded.project_limit,
        prompt_limit = excluded.prompt_limit,
        source_limit = excluded.source_limit,
        allowed_sources_json = excluded.allowed_sources_json,
        updated_at = excluded.updated_at`,
    ).bind(
      plan.id,
      plan.name,
      plan.description,
      plan.sortOrder,
      plan.featured ? 1 : 0,
      plan.monthlyUnits,
      plan.projectLimit,
      plan.promptLimit,
      plan.sourceLimit,
      JSON.stringify(plan.allowedSources),
      now,
      now,
    )),
  ];
}

function catalogueStatements(
  env: Env,
  accountId: string,
  input: PaymentProviderAccountInput,
  now: string,
): D1PreparedStatement[] {
  const catalogue = inputCatalogue(input);
  return Object.values(catalogue).map((plan) => {
    return env.CONTROL_DB.prepare(
      `INSERT INTO payment_provider_plan_mappings (
        provider_account_id, billing_plan_id, external_reference, external_product_id,
        currency, amount_minor, billing_interval, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_account_id, billing_plan_id) DO UPDATE SET
        external_reference = excluded.external_reference,
        external_product_id = excluded.external_product_id,
        currency = excluded.currency,
        amount_minor = excluded.amount_minor,
        billing_interval = excluded.billing_interval,
        updated_at = excluded.updated_at`,
    ).bind(
      accountId,
      plan.id,
      plan.externalReference,
      plan.externalProductId,
      plan.currency,
      plan.amountMinor,
      plan.billingInterval,
      now,
      now,
    );
  });
}

async function testInput(
  accountId: string,
  adapterVersion: string,
  endpointKey: string,
  input: PaymentProviderAccountInput,
  credentialVersion: number | null,
): Promise<PaymentProviderTestResult> {
  return paymentProviderAdapter(input.provider).testAccount(
    resolvedInput(accountId, adapterVersion, endpointKey, input, credentialVersion),
  );
}

export async function createPaymentProviderAccount(
  env: Env,
  input: PaymentProviderAccountInput,
  userId: string,
) {
  const definition = PAYMENT_PROVIDER_ADAPTERS[input.provider];
  if (!definition.adapter || !definition.version) {
    throw new ApiError(409, "payment_provider_unavailable", `${definition.label} is not implemented yet.`);
  }
  if (input.webhookEndpointKey) {
    const existingEndpoint = await env.CONTROL_DB.prepare(
      "SELECT 1 AS found FROM payment_provider_accounts WHERE webhook_endpoint_key = ?",
    ).bind(input.webhookEndpointKey).first();
    if (existingEndpoint) {
      throw new ApiError(409, "payment_webhook_endpoint_conflict", "Generate a new payment webhook endpoint and retry.");
    }
  }
  const accountId = crypto.randomUUID();
  const endpointKey = input.webhookEndpointKey ?? crypto.randomUUID();
  const version = 1;
  const test = await testInput(accountId, definition.version, endpointKey, input, version);
  if (test.status !== "passed") {
    throw new ApiError(422, "payment_configuration_rejected", test.message);
  }
  const encrypted = await encryptPaymentCredential(
    env.APP_CRYPTO_KEY,
    { accountId, provider: input.provider, environment: input.environment, version },
    inputCredentials(input),
  );
  const now = nowIso();
  const planDefinitionStatements = await billingPlanStatements(env, input.plans, now);
  const currentlyConfigured = await hasConfiguredPaymentSelection(env);
  const makeDefault = !currentlyConfigured;
  const statements: D1PreparedStatement[] = [];
  if (makeDefault) {
    statements.push(env.CONTROL_DB.prepare(
      "UPDATE payment_provider_accounts SET is_default = 0, updated_at = ? WHERE is_default = 1",
    ).bind(now));
  }
  statements.push(
    ...planDefinitionStatements,
    env.CONTROL_DB.prepare(
      `INSERT INTO payment_provider_accounts (
        id, provider, label, environment, status, credential_source,
        configuration_source, active_credential_version, is_default,
        adapter_version, configuration_json, webhook_endpoint_key,
        last_test_status, last_tested_at, last_test_message,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'database', 'database', ?, ?, ?, ?, ?,
        'passed', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      accountId,
      input.provider,
      input.label,
      input.environment,
      version,
      makeDefault ? 1 : 0,
      definition.version,
      JSON.stringify(input.configuration),
      endpointKey,
      now,
      test.message,
      userId,
      userId,
      now,
      now,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO payment_provider_credentials (
        provider_account_id, version, algorithm, key_version, ciphertext, nonce,
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      accountId,
      version,
      encrypted.algorithm,
      encrypted.keyVersion,
      encrypted.ciphertext,
      encrypted.nonce,
      userId,
      now,
    ),
    ...catalogueStatements(env, accountId, input, now),
  );
  if (makeDefault) {
    statements.push(env.CONTROL_DB.prepare(
      `UPDATE payment_configuration SET mode = 'managed', enabled = 1,
        default_provider_account_id = ?,
        updated_by_user_id = ?, updated_at = ? WHERE id = 'installation'`,
    ).bind(accountId, userId, now));
  }
  await env.CONTROL_DB.batch(statements);
  return publicAccount(
    env,
    await accountById(env, accountId),
    await planRows(env),
    await billingPlanRows(env),
    0,
  );
}

export async function importLegacyStripePaymentAccount(env: Env, userId: string) {
  const input = legacyStripePaymentInput(env);
  if (!input) {
    throw new ApiError(409, "legacy_payment_configuration_missing", "The Worker Stripe configuration is incomplete.");
  }
  let account: PaymentProviderAccountRow;
  try {
    account = await accountById(env, LEGACY_STRIPE_ACCOUNT_ID);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const now = nowIso();
    await env.CONTROL_DB.prepare(
      `INSERT INTO payment_provider_accounts (
        id, provider, label, environment, status, credential_source,
        configuration_source, is_default, adapter_version, configuration_json,
        webhook_endpoint_key, created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, 'stripe', ?, ?, 'active', 'environment', 'environment', 0,
        'stripe-v1', '{}', 'stripe-legacy-v1', ?, ?, ?, ?)`,
    ).bind(
      LEGACY_STRIPE_ACCOUNT_ID,
      input.label,
      input.environment,
      userId,
      userId,
      now,
      now,
    ).run();
    account = await accountById(env, LEGACY_STRIPE_ACCOUNT_ID);
  }
  const version = (account.active_credential_version ?? 0) + 1;
  const test = await testInput(account.id, account.adapter_version, account.webhook_endpoint_key, input, version);
  if (test.status !== "passed") {
    await recordPaymentProviderTest(env, account.id, test);
    throw new ApiError(422, "payment_configuration_rejected", test.message);
  }
  const encrypted = await encryptPaymentCredential(
    env.APP_CRYPTO_KEY,
    { accountId: account.id, provider: "stripe", environment: input.environment, version },
    { provider: "stripe", credentials: input.credentials },
  );
  const now = nowIso();
  const planDefinitionStatements = await billingPlanStatements(env, input.plans, now);
  const makeDefault = !await hasConfiguredPaymentSelection(env);
  const statements: D1PreparedStatement[] = [];
  if (makeDefault) {
    statements.push(env.CONTROL_DB.prepare(
      "UPDATE payment_provider_accounts SET is_default = 0, updated_at = ? WHERE is_default = 1",
    ).bind(now));
  }
  statements.push(
    ...planDefinitionStatements,
    env.CONTROL_DB.prepare(
      `INSERT INTO payment_provider_credentials (
        provider_account_id, version, algorithm, key_version, ciphertext, nonce,
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      account.id,
      version,
      encrypted.algorithm,
      encrypted.keyVersion,
      encrypted.ciphertext,
      encrypted.nonce,
      userId,
      now,
    ),
    ...catalogueStatements(env, account.id, input, now),
    env.CONTROL_DB.prepare(
      `UPDATE payment_provider_accounts SET label = ?, environment = ?,
        credential_source = 'database', configuration_source = 'database',
        active_credential_version = ?, configuration_json = ?, is_default = ?,
        last_test_status = 'passed', last_tested_at = ?, last_test_message = ?,
        updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      input.label,
      input.environment,
      version,
      JSON.stringify(input.configuration),
      makeDefault ? 1 : account.is_default,
      now,
      test.message,
      userId,
      now,
      account.id,
    ),
  );
  if (makeDefault) {
    statements.push(env.CONTROL_DB.prepare(
      `UPDATE payment_configuration SET mode = 'managed', enabled = 1,
        default_provider_account_id = ?,
        updated_by_user_id = ?, updated_at = ? WHERE id = 'installation'`,
    ).bind(account.id, userId, now));
  }
  await env.CONTROL_DB.batch(statements);
  return { id: account.id, credentialVersion: version, ...test };
}

export async function loadPaymentProviderAccount(
  env: Env,
  accountId: string,
): Promise<ResolvedPaymentProviderAccount> {
  return resolvedAccount(env, await accountById(env, accountId));
}

export async function replacePaymentProviderCredential(
  env: Env,
  accountId: string,
  input: PaymentProviderCredentialInput,
  userId: string,
) {
  const account = await accountById(env, accountId);
  if (account.provider !== input.provider) {
    throw new ApiError(409, "payment_provider_mismatch", "Credentials do not match this payment account.");
  }
  if (account.credential_source === "environment" || account.configuration_source === "environment") {
    throw new ApiError(409, "legacy_payment_import_required", "Import the complete legacy Stripe configuration before rotating individual fields.");
  }
  const current = await resolvedAccount(env, account);
  const version = (account.active_credential_version ?? 0) + 1;
  const candidate: ResolvedPaymentProviderAccount = {
    ...current,
    credentialVersion: version,
    credentials: input,
  };
  const test = await paymentProviderAdapter(account.provider).testAccount(candidate);
  if (test.status !== "passed") {
    await recordPaymentProviderTest(env, accountId, test);
    throw new ApiError(422, "payment_configuration_rejected", test.message);
  }
  const encrypted = await encryptPaymentCredential(
    env.APP_CRYPTO_KEY,
    { accountId, provider: account.provider, environment: account.environment, version },
    input,
  );
  const now = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO payment_provider_credentials (
        provider_account_id, version, algorithm, key_version, ciphertext, nonce,
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      accountId,
      version,
      encrypted.algorithm,
      encrypted.keyVersion,
      encrypted.ciphertext,
      encrypted.nonce,
      userId,
      now,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE payment_provider_accounts SET credential_source = 'database',
        active_credential_version = ?, last_test_status = 'passed', last_tested_at = ?,
        last_test_message = ?, updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(version, now, test.message, userId, now, accountId),
  ]);
  return { id: accountId, credentialVersion: version, ...test };
}

export async function replacePaymentProviderCatalogue(
  env: Env,
  accountId: string,
  input: PaymentProviderCatalogueUpdate,
  userId: string,
) {
  const account = await accountById(env, accountId);
  if (account.provider !== input.provider) {
    throw new ApiError(409, "payment_provider_mismatch", "This catalogue does not match the payment account.");
  }
  if (account.credential_source === "environment" || account.configuration_source === "environment") {
    throw new ApiError(409, "legacy_payment_import_required", "Import the complete legacy Stripe configuration before replacing its catalogue.");
  }
  const current = await resolvedAccount(env, account);
  let candidateInput: PaymentProviderAccountInput;
  if (input.provider === "stripe" && current.credentials.provider === "stripe") {
    candidateInput = {
      provider: "stripe",
      label: account.label,
      environment: account.environment,
      credentials: current.credentials.credentials,
      currency: input.currency,
      plans: input.plans,
      catalogue: input.catalogue,
      configuration: input.configuration,
    };
  } else if (input.provider === "dodo" && current.credentials.provider === "dodo") {
    candidateInput = {
      provider: "dodo",
      label: account.label,
      environment: account.environment,
      credentials: current.credentials.credentials,
      currency: input.currency,
      plans: input.plans,
      catalogue: input.catalogue,
      configuration: input.configuration,
    };
  } else {
    throw new ApiError(409, "payment_provider_mismatch", "This catalogue does not match the payment account.");
  }
  const candidate = resolvedInput(
    account.id,
    account.adapter_version,
    account.webhook_endpoint_key,
    candidateInput,
    account.active_credential_version,
  );
  const test = await paymentProviderAdapter(account.provider).testAccount(candidate);
  if (test.status !== "passed") {
    await recordPaymentProviderTest(env, accountId, test);
    throw new ApiError(422, "payment_configuration_rejected", test.message);
  }
  const now = nowIso();
  const planDefinitionStatements = await billingPlanStatements(env, candidateInput.plans, now);
  await env.CONTROL_DB.batch([
    ...planDefinitionStatements,
    ...catalogueStatements(env, account.id, candidateInput, now),
    env.CONTROL_DB.prepare(
      `UPDATE payment_provider_accounts SET configuration_source = 'database',
        configuration_json = ?, last_test_status = 'passed', last_tested_at = ?,
        last_test_message = ?, updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      JSON.stringify(candidateInput.configuration),
      now,
      test.message,
      userId,
      now,
      accountId,
    ),
  ]);
  return { id: accountId, ...test };
}

export async function recordPaymentProviderTest(
  env: Env,
  accountId: string,
  test: PaymentProviderTestResult,
): Promise<void> {
  const now = nowIso();
  await env.CONTROL_DB.prepare(
    `UPDATE payment_provider_accounts SET last_test_status = ?, last_tested_at = ?,
      last_test_message = ?, updated_at = ? WHERE id = ?`,
  ).bind(test.status, now, test.message, now, accountId).run();
}

export async function setDefaultPaymentProviderAccount(
  env: Env,
  accountId: string,
  userId: string,
): Promise<void> {
  const account = await accountById(env, accountId);
  const [plans, billingPlans] = await Promise.all([planRows(env), billingPlanRows(env)]);
  if (
    account.status !== "active" || !accountConfigured(env, account, plans, billingPlans) ||
    account.last_test_status !== "passed"
  ) {
    throw new ApiError(409, "payment_provider_unavailable", "Only an active, configured, successfully tested payment account can be selected.");
  }
  const blockers = await env.CONTROL_DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM billing_accounts billing
       LEFT JOIN workspace_billing_subscriptions subscription
         ON subscription.workspace_id = billing.workspace_id
       WHERE billing.stripe_subscription_id IS NOT NULL
         AND subscription.workspace_id IS NULL) AS subscriptions,
      (SELECT COUNT(*) FROM billing_checkout_sessions
       WHERE status IN ('creating', 'open')
         AND payment_provider_account_id IS NULL) AS checkouts,
      (SELECT COUNT(*) FROM billing_plan_changes
       WHERE status IN ('pending_customer', 'creating', 'updating', 'scheduled', 'releasing')
         AND payment_provider_account_id IS NULL) AS plan_changes,
      (SELECT COUNT(*) FROM billing_events
       WHERE processed_at IS NULL
         AND payment_provider_account_id IS NULL) AS events`,
  ).first<{ subscriptions: number; checkouts: number; plan_changes: number; events: number }>();
  const activeBlockers = Object.entries(blockers ?? {}).filter(([, count]) => Number(count) > 0);
  if (activeBlockers.length) {
    throw new ApiError(
      409,
      "payment_provider_switch_blocked",
      "Link legacy billing state to a payment provider account before changing the installation default.",
      Object.fromEntries(activeBlockers),
    );
  }
  const now = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "UPDATE payment_provider_accounts SET is_default = 0, updated_at = ? WHERE is_default = 1",
    ).bind(now),
    env.CONTROL_DB.prepare(
      `UPDATE payment_provider_accounts SET is_default = 1,
        updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(userId, now, accountId),
    env.CONTROL_DB.prepare(
      `UPDATE payment_configuration SET mode = 'managed', enabled = 1,
        default_provider_account_id = ?,
        updated_by_user_id = ?, updated_at = ? WHERE id = 'installation'`,
    ).bind(accountId, userId, now),
  ]);
}

export async function selectSelfHostedPaymentMode(
  env: Env,
  userId: string,
): Promise<void> {
  const blockers = await env.CONTROL_DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM workspace_billing_subscriptions subscription
       JOIN billing_accounts billing ON billing.workspace_id = subscription.workspace_id
       WHERE subscription.external_subscription_id IS NOT NULL
         AND billing.status NOT IN ('cancelled', 'unpaid')) AS subscriptions,
      (SELECT COUNT(*) FROM billing_checkout_sessions
       WHERE status IN ('creating', 'open')) AS checkouts,
      (SELECT COUNT(*) FROM billing_plan_changes
       WHERE status IN ('pending_customer', 'creating', 'updating', 'scheduled', 'releasing')) AS plan_changes`,
  ).first<{ subscriptions: number; checkouts: number; plan_changes: number }>();
  const activeBlockers = Object.entries(blockers ?? {})
    .filter(([, count]) => Number(count) > 0);
  if (activeBlockers.length) {
    throw new ApiError(
      409,
      "managed_payments_in_use",
      "Cancel or reconcile active payment state before switching the installation to self-hosted mode.",
      Object.fromEntries(activeBlockers),
    );
  }
  const now = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE payment_configuration SET mode = 'self_hosted', enabled = 0,
        default_provider_account_id = NULL, updated_by_user_id = ?, updated_at = ?
       WHERE id = 'installation'`,
    ).bind(userId, now),
    env.CONTROL_DB.prepare(
      "UPDATE payment_provider_accounts SET is_default = 0, updated_at = ? WHERE is_default = 1",
    ).bind(now),
  ]);
}

export async function updatePaymentProviderAccount(
  env: Env,
  accountId: string,
  input: PaymentProviderAccountUpdate,
  userId: string,
): Promise<void> {
  const account = await accountById(env, accountId);
  if (input.status === "disabled" && account.is_default === 1) {
    throw new ApiError(409, "default_payment_provider_cannot_be_disabled", "Select another payment provider before disabling this account.");
  }
  if (input.status === "disabled") {
    const linked = await env.CONTROL_DB.prepare(
      `SELECT workspace_id FROM workspace_billing_subscriptions
       WHERE provider_account_id = ? AND external_subscription_id IS NOT NULL LIMIT 1`,
    ).bind(accountId).first();
    if (linked) {
      throw new ApiError(409, "linked_payment_provider_cannot_be_disabled", "Clear test subscriptions before disabling this payment account.");
    }
  }
  await env.CONTROL_DB.prepare(
    `UPDATE payment_provider_accounts SET label = COALESCE(?, label),
      status = COALESCE(?, status), updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
  ).bind(input.label ?? null, input.status ?? null, userId, nowIso(), accountId).run();
}
