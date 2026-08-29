import type {
  BillingPlanDefinitionInput,
  ManagedPaymentPlanKey,
  PaymentEnvironment,
  PaymentProvider,
  PaymentProviderCredentialInput,
  SubscriptionStatus,
} from "../../shared/contracts";

export interface PaymentProviderPlan extends BillingPlanDefinitionInput {
  planKey: ManagedPaymentPlanKey;
  externalReference: string;
  externalProductId: string | null;
  currency: string;
  amountMinor: number;
  billingInterval: "month";
}

export type PaymentProviderPlanCatalogue = Record<
  string,
  PaymentProviderPlan
>;

export interface ResolvedPaymentProviderAccount {
  accountId: string;
  provider: PaymentProvider;
  label: string;
  environment: PaymentEnvironment;
  adapterVersion: string;
  credentialVersion: number | null;
  credentials: PaymentProviderCredentialInput;
  catalogue: PaymentProviderPlanCatalogue;
  configuration: Record<string, unknown>;
  webhookEndpointKey: string;
}

export interface PaymentProviderTestResult {
  status: "passed" | "failed";
  message: string;
  details?: Record<string, unknown>;
}

export interface PaymentSubscriptionSnapshot {
  externalSubscriptionId: string;
  externalCustomerId: string;
  externalItemId: string | null;
  externalPlanReference: string;
  planKey: ManagedPaymentPlanKey;
  quantity: number;
  status: SubscriptionStatus;
  rawStatus: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  currentPeriodStartUnix: number;
  currentPeriodEndUnix: number;
  cancelAtPeriodEnd: boolean;
  externalScheduledChangeId: string | null;
  hasTrial: boolean;
  hasDiscount: boolean;
  taxHandlingReady: boolean;
  providerState: Record<string, unknown>;
  object: Record<string, unknown>;
}

export type PaymentWebhookKind =
  | "checkout_completed"
  | "checkout_failed"
  | "subscription_changed"
  | "subscription_deleted"
  | "scheduled_change_changed"
  | "invoice_changed"
  | "ignored";

export interface PaymentWebhookEvent {
  externalEventId: string;
  eventType: string;
  environment: PaymentEnvironment;
  kind: PaymentWebhookKind;
  object: Record<string, unknown>;
  workspaceId: string | null;
  checkoutAttemptId: string | null;
  externalCheckoutId: string | null;
  externalSubscriptionId: string | null;
}

export interface PaymentCheckoutRequest {
  attemptId: string;
  workspaceId: string;
  planKey: ManagedPaymentPlanKey;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export interface PaymentCheckoutResult {
  externalSessionId: string;
  url: string;
  expiresAt: string | null;
  providerState: Record<string, unknown>;
}

export interface PaymentActionResult {
  url: string;
  externalActionId: string | null;
}

export interface PaymentPlanChangeSessionRequest {
  actionId: string;
  workspaceId: string;
  externalCustomerId: string;
  externalSubscriptionId: string;
  externalItemId: string | null;
  targetPlanKey: ManagedPaymentPlanKey;
  returnUrl: string;
  completionUrl: string;
}

export interface PaymentCancellationSessionRequest {
  externalCustomerId: string;
  externalSubscriptionId: string;
  returnUrl: string;
  completionUrl: string;
}

export interface PaymentScheduledPlanChangeRequest {
  changeId: string;
  workspaceId: string;
  targetPlanKey: ManagedPaymentPlanKey;
  subscription: PaymentSubscriptionSnapshot;
  existingExternalScheduleId: string | null;
}

export interface PaymentScheduledPlanChangeResult {
  externalScheduleId: string;
  providerState: Record<string, unknown>;
}

export interface PaymentProviderAdapter {
  provider: PaymentProvider;
  version: string;
  testAccount(account: ResolvedPaymentProviderAccount): Promise<PaymentProviderTestResult>;
  createCheckout(
    account: ResolvedPaymentProviderAccount,
    input: PaymentCheckoutRequest,
  ): Promise<PaymentCheckoutResult>;
  expireCheckout?(
    account: ResolvedPaymentProviderAccount,
    externalSessionId: string,
    idempotencyKey: string,
  ): Promise<void>;
  retrieveSubscription(
    account: ResolvedPaymentProviderAccount,
    externalSubscriptionId: string,
  ): Promise<Record<string, unknown>>;
  normalizeSubscription(
    account: ResolvedPaymentProviderAccount,
    object: Record<string, unknown>,
  ): PaymentSubscriptionSnapshot;
  createManagementSession(
    account: ResolvedPaymentProviderAccount,
    externalCustomerId: string,
    returnUrl: string,
  ): Promise<PaymentActionResult>;
  createPlanChangeSession(
    account: ResolvedPaymentProviderAccount,
    input: PaymentPlanChangeSessionRequest,
  ): Promise<PaymentActionResult>;
  createCancellationSession(
    account: ResolvedPaymentProviderAccount,
    input: PaymentCancellationSessionRequest,
  ): Promise<PaymentActionResult>;
  schedulePlanChange(
    account: ResolvedPaymentProviderAccount,
    input: PaymentScheduledPlanChangeRequest,
  ): Promise<PaymentScheduledPlanChangeResult>;
  releaseScheduledPlanChange(
    account: ResolvedPaymentProviderAccount,
    externalSubscriptionId: string,
    externalScheduleId: string,
    idempotencyKey: string,
  ): Promise<void>;
  reactivateSubscription(
    account: ResolvedPaymentProviderAccount,
    externalSubscriptionId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>>;
  verifyAndParseWebhook(
    account: ResolvedPaymentProviderAccount,
    payload: string,
    headers: Headers,
  ): Promise<PaymentWebhookEvent>;
}
