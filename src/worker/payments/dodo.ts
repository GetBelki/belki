import type {
  ManagedPaymentPlanKey,
  SubscriptionStatus,
} from "../../shared/contracts";
import { ApiError, jsonParse } from "../lib/http";
import { verifyStandardWebhookSignature } from "../lib/standard-webhook-signature";
import type {
  PaymentProviderAdapter,
  PaymentProviderPlan,
  PaymentProviderTestResult,
  PaymentSubscriptionSnapshot,
  PaymentWebhookEvent,
  ResolvedPaymentProviderAccount,
} from "./types";

const MAX_DODO_BODY_BYTES = 1024 * 1024;
const DODO_TIMEOUT_MS = 10_000;

function accountPlans(account: ResolvedPaymentProviderAccount) {
  return Object.values(account.catalogue).sort((left, right) =>
    left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)
  );
}

function accountPlan(
  account: ResolvedPaymentProviderAccount,
  planKey: ManagedPaymentPlanKey,
): PaymentProviderPlan {
  const plan = account.catalogue[planKey];
  if (!plan) {
    throw new ApiError(503, "billing_not_configured", `Plan ${planKey} is not mapped in ${account.label}.`);
  }
  return plan;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dodoCredentials(account: ResolvedPaymentProviderAccount) {
  if (account.provider !== "dodo" || account.credentials.provider !== "dodo") {
    throw new ApiError(503, "payment_provider_mismatch", "The selected payment account is not a Dodo Payments account.");
  }
  return account.credentials.credentials;
}

function dodoApiOrigin(account: ResolvedPaymentProviderAccount): string {
  return account.environment === "live"
    ? "https://live.dodopayments.com"
    : "https://test.dodopayments.com";
}

async function boundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_DODO_BODY_BYTES) {
    throw new ApiError(502, "dodo_error", "Dodo Payments returned an oversized response.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_DODO_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(502, "dodo_error", "Dodo Payments returned an oversized response.");
    }
    text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
}

async function dodoRequest<T extends Record<string, unknown>>(
  account: ResolvedPaymentProviderAccount,
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const response = await fetch(`${dodoApiOrigin(account)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${dodoCredentials(account).apiKey}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(DODO_TIMEOUT_MS),
  });
  const text = await boundedText(response);
  const payload = text
    ? jsonParse<T & { message?: unknown; error?: unknown }>(text, {} as T)
    : {} as T & { message?: unknown; error?: unknown };
  if (!response.ok) {
    const nestedError = objectValue(payload.error);
    const message = stringValue(payload.message) ?? stringValue(nestedError.message) ??
      "Dodo Payments rejected the request.";
    console.error(JSON.stringify({
      level: "error",
      message: "dodo_request_failed",
      path,
      method,
      status: response.status,
    }));
    if (response.status === 404) throw new ApiError(404, "dodo_resource_not_found", message);
    if (response.status === 409) throw new ApiError(409, "dodo_conflict", message);
    if (response.status === 422) throw new ApiError(422, "dodo_validation_error", message);
    throw new ApiError(502, "dodo_error", message);
  }
  return payload;
}

function planFromProduct(
  account: ResolvedPaymentProviderAccount,
  productId: string,
): ManagedPaymentPlanKey | null {
  return accountPlans(account).find(
    (plan) => plan.externalReference === productId,
  )?.id ?? null;
}

function normalizeStatus(value: string | null): SubscriptionStatus {
  if (value === "active") return "active";
  if (value === "pending") return "pending";
  if (value === "on_hold") return "past_due";
  if (value === "paused") return "paused";
  if (value === "failed") return "unpaid";
  if (value === "cancelled" || value === "expired") return "cancelled";
  return "pending";
}

function isoDate(value: unknown, field: string): { iso: string; unix: number } {
  const raw = stringValue(value);
  const milliseconds = raw ? Date.parse(raw) : Number.NaN;
  if (!raw || !Number.isFinite(milliseconds)) {
    throw new ApiError(409, "unsupported_subscription", `Dodo subscription data is missing ${field}.`);
  }
  return { iso: new Date(milliseconds).toISOString(), unix: Math.floor(milliseconds / 1_000) };
}

function scheduledChange(object: Record<string, unknown>): Record<string, unknown> {
  return objectValue(object.scheduled_change);
}

function metadataFrom(object: Record<string, unknown>): Record<string, unknown> {
  return objectValue(object.metadata);
}

async function testDodoAccount(
  account: ResolvedPaymentProviderAccount,
): Promise<PaymentProviderTestResult> {
  try {
    const credentials = dodoCredentials(account);
    if (!credentials.webhookSecret.startsWith("whsec_")) {
      throw new Error("The Dodo webhook signing secret must start with whsec_.");
    }
    let businessId: string | null = null;
    for (const plan of accountPlans(account)) {
      const reference = plan.externalReference;
      const product = await dodoRequest<Record<string, unknown>>(
        account,
        `/products/${encodeURIComponent(reference)}`,
      );
      const price = objectValue(product.price);
      businessId ??= stringValue(product.business_id);
      const interval = stringValue(price.payment_frequency_interval)?.toLowerCase();
      const intervalCount = numberValue(price.payment_frequency_count);
      const amount = numberValue(price.price ?? price.pre_tax_amount);
      const currency = stringValue(price.currency)?.toUpperCase();
      const failures = [
        product.product_id !== reference ? "wrong product" : null,
        product.is_recurring !== true || price.type !== "recurring_price" ? "not recurring" : null,
        currency !== plan.currency ? `currency does not match ${plan.currency}` : null,
        amount !== plan.amountMinor ? "wrong amount" : null,
        interval !== "month" || intervalCount !== 1 ? "not monthly" : null,
        price.tax_inclusive !== false ? "price must exclude tax" : null,
      ].filter(Boolean);
      if (failures.length) {
        throw new Error(`${plan.name} Dodo product is invalid: ${failures.join(", ")}.`);
      }
    }
    return {
      status: "passed",
      message: `Dodo Payments ${account.environment} credentials and product catalogue verified.`,
      details: businessId ? { businessId } : undefined,
    };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Dodo Payments configuration check failed.",
    };
  }
}

function webhookKind(eventType: string, metadata: Record<string, unknown>): PaymentWebhookEvent["kind"] {
  const checkoutAttempt = stringValue(metadata.checkout_attempt_id);
  if (eventType === "payment.succeeded" || eventType === "payment.success") {
    return checkoutAttempt ? "checkout_completed" : "invoice_changed";
  }
  if (eventType === "payment.failed" || eventType === "payment.cancelled") {
    return checkoutAttempt ? "checkout_failed" : "invoice_changed";
  }
  if (eventType === "subscription.cancelled" || eventType === "subscription.expired") {
    return "subscription_deleted";
  }
  if (eventType.startsWith("subscription.")) return "subscription_changed";
  return "ignored";
}

export const dodoPaymentAdapter: PaymentProviderAdapter = {
  provider: "dodo",
  version: "dodo-v1",
  testAccount: testDodoAccount,
  async createCheckout(account, input) {
    const session = await dodoRequest<Record<string, unknown>>(account, "/checkouts", {
      method: "POST",
      body: {
        product_cart: [{
          product_id: accountPlan(account, input.planKey).externalReference,
          quantity: 1,
        }],
        customer: {
          email: input.customerEmail,
          name: input.customerEmail.split("@", 1)[0] || "Belki customer",
        },
        return_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          workspace_id: input.workspaceId,
          plan_key: input.planKey,
          checkout_attempt_id: input.attemptId,
        },
      },
    });
    const externalSessionId = stringValue(session.session_id);
    const url = stringValue(session.checkout_url) ?? stringValue(session.url);
    if (!externalSessionId || !url) {
      throw new ApiError(502, "payment_provider_error", "Dodo Payments did not return a complete Checkout session.");
    }
    return {
      externalSessionId,
      url,
      expiresAt: null,
      providerState: {
        paymentId: stringValue(session.payment_id),
      },
    };
  },
  retrieveSubscription(account, externalSubscriptionId) {
    return dodoRequest(account, `/subscriptions/${encodeURIComponent(externalSubscriptionId)}`);
  },
  normalizeSubscription(account, object): PaymentSubscriptionSnapshot {
    const id = stringValue(object.subscription_id) ?? stringValue(object.id);
    const customer = objectValue(object.customer);
    const customerId = stringValue(customer.customer_id) ?? stringValue(object.customer_id);
    const productId = stringValue(object.product_id);
    const planKey = productId ? planFromProduct(account, productId) : null;
    const start = isoDate(object.previous_billing_date, "the current period start");
    const end = isoDate(object.next_billing_date, "the current period end");
    if (!id || !customerId || !productId || !planKey) {
      throw new ApiError(409, "unsupported_subscription", "Dodo subscription data does not match the Belki product catalogue.");
    }
    const schedule = scheduledChange(object);
    const scheduleId = stringValue(schedule.id);
    const rawStatus = stringValue(object.status) ?? "unknown";
    return {
      externalSubscriptionId: id,
      externalCustomerId: customerId,
      externalItemId: null,
      externalPlanReference: productId,
      planKey,
      quantity: numberValue(object.quantity) ?? 1,
      status: normalizeStatus(rawStatus),
      rawStatus,
      currentPeriodStart: start.iso,
      currentPeriodEnd: end.iso,
      currentPeriodStartUnix: start.unix,
      currentPeriodEndUnix: end.unix,
      cancelAtPeriodEnd: object.cancel_at_next_billing_date === true,
      externalScheduledChangeId: scheduleId,
      hasTrial: (numberValue(object.trial_period_days) ?? 0) > 0,
      hasDiscount: stringValue(object.discount_id) !== null ||
        (numberValue(object.discount_cycles_remaining) ?? 0) > 0 ||
        arrayValue(object.discounts).length > 0,
      taxHandlingReady: object.tax_inclusive === false,
      providerState: {
        scheduledChange: scheduleId ? schedule : null,
        paymentMethodId: stringValue(object.payment_method_id),
      },
      object,
    };
  },
  async createManagementSession(account, externalCustomerId, returnUrl) {
    const session = await dodoRequest<Record<string, unknown>>(
      account,
      `/customers/${encodeURIComponent(externalCustomerId)}/customer-portal/session?return_url=${encodeURIComponent(returnUrl)}`,
      { method: "POST" },
    );
    const url = stringValue(session.link);
    if (!url) throw new ApiError(502, "payment_provider_error", "Dodo Payments did not return a customer portal URL.");
    return { url, externalActionId: null };
  },
  async createPlanChangeSession(account, input) {
    const result = await dodoRequest<Record<string, unknown>>(
      account,
      `/subscriptions/${encodeURIComponent(input.externalSubscriptionId)}/change-plan`,
      {
        method: "POST",
        body: {
          product_id: accountPlan(account, input.targetPlanKey).externalReference,
          quantity: 1,
          proration_billing_mode: "prorated_immediately",
          effective_at: "immediately",
          on_payment_failure: "prevent_change",
          collect_via_payment_link: true,
          metadata: {
            workspace_id: input.workspaceId,
            plan_key: input.targetPlanKey,
            plan_change_id: input.actionId,
            return_url: input.completionUrl,
          },
        },
      },
    );
    const url = stringValue(result.payment_link);
    if (!url) {
      throw new ApiError(
        502,
        "payment_provider_error",
        "Dodo Payments did not return a plan-change payment link. Enable plan changes by payment link in Dodo subscription settings.",
      );
    }
    return { url, externalActionId: stringValue(result.payment_id) };
  },
  async createCancellationSession(account, input) {
    return this.createManagementSession(account, input.externalCustomerId, input.returnUrl);
  },
  async schedulePlanChange(account, input) {
    const before = await this.retrieveSubscription(
      account,
      input.subscription.externalSubscriptionId,
    );
    const currentSchedule = scheduledChange(before);
    const currentScheduleId = stringValue(currentSchedule.id);
    const targetProductId = accountPlan(account, input.targetPlanKey).externalReference;
    if (currentScheduleId) {
      if (
        currentSchedule.product_id === targetProductId &&
        (!input.existingExternalScheduleId || input.existingExternalScheduleId === currentScheduleId)
      ) {
        return {
          externalScheduleId: currentScheduleId,
          providerState: { externalSubscriptionId: input.subscription.externalSubscriptionId },
        };
      }
      throw new ApiError(409, "foreign_subscription_schedule", "The Dodo subscription already has a different scheduled plan change.");
    }
    await dodoRequest(
      account,
      `/subscriptions/${encodeURIComponent(input.subscription.externalSubscriptionId)}/change-plan`,
      {
        method: "POST",
        body: {
          product_id: targetProductId,
          quantity: 1,
          proration_billing_mode: "do_not_bill",
          effective_at: "next_billing_date",
          metadata: {
            workspace_id: input.workspaceId,
            plan_key: input.targetPlanKey,
            plan_change_id: input.changeId,
          },
        },
      },
    );
    const after = await this.retrieveSubscription(
      account,
      input.subscription.externalSubscriptionId,
    );
    const schedule = scheduledChange(after);
    const externalScheduleId = stringValue(schedule.id);
    if (!externalScheduleId || schedule.product_id !== targetProductId) {
      try {
        await dodoRequest(
          account,
          `/subscriptions/${encodeURIComponent(input.subscription.externalSubscriptionId)}/change-plan/scheduled`,
          { method: "DELETE" },
        );
      } catch {
        throw new ApiError(
          502,
          "scheduled_change_cleanup_failed",
          "Dodo Payments created a scheduled change that requires operator reconciliation.",
          { externalSubscriptionId: input.subscription.externalSubscriptionId },
        );
      }
      throw new ApiError(502, "payment_provider_error", "Dodo Payments did not return the scheduled plan change.");
    }
    return {
      externalScheduleId,
      providerState: {
        externalSubscriptionId: input.subscription.externalSubscriptionId,
        targetProductId,
      },
    };
  },
  async releaseScheduledPlanChange(account, externalSubscriptionId, externalScheduleId) {
    const current = await this.retrieveSubscription(account, externalSubscriptionId);
    const currentScheduleId = stringValue(scheduledChange(current).id);
    if (!currentScheduleId) return;
    if (currentScheduleId !== externalScheduleId) {
      throw new ApiError(409, "foreign_subscription_schedule", "The Dodo scheduled change does not match Belki billing state.");
    }
    try {
      await dodoRequest(
        account,
        `/subscriptions/${encodeURIComponent(externalSubscriptionId)}/change-plan/scheduled`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
  },
  reactivateSubscription(account, externalSubscriptionId) {
    return dodoRequest(account, `/subscriptions/${encodeURIComponent(externalSubscriptionId)}`, {
      method: "PATCH",
      body: { cancel_at_next_billing_date: false },
    });
  },
  async verifyAndParseWebhook(account, payload, headers) {
    if (new TextEncoder().encode(payload).byteLength > MAX_DODO_BODY_BYTES) {
      throw new ApiError(400, "payment_payload_too_large", "The payment webhook payload is too large.");
    }
    if (!await verifyStandardWebhookSignature(
      payload,
      headers,
      dodoCredentials(account).webhookSecret,
    )) {
      throw new ApiError(400, "payment_signature_invalid", "The Dodo Payments signature is invalid.");
    }
    const event = jsonParse<Record<string, unknown>>(payload, {});
    const eventType = stringValue(event.type) ?? stringValue(event.event_type);
    const externalEventId = headers.get("webhook-id");
    const object = objectValue(event.data);
    if (!externalEventId || !eventType || Object.keys(object).length === 0) {
      throw new ApiError(400, "payment_event_invalid", "The Dodo Payments event is invalid.");
    }
    const metadata = metadataFrom(object);
    const kind = webhookKind(eventType, metadata);
    const externalSubscriptionId = stringValue(object.subscription_id) ??
      stringValue(object.subscription) ??
      stringValue(objectValue(object.subscription).subscription_id) ??
      stringValue(objectValue(object.subscription).id);
    return {
      externalEventId,
      eventType,
      environment: account.environment,
      kind,
      object,
      workspaceId: stringValue(metadata.workspace_id),
      checkoutAttemptId: stringValue(metadata.checkout_attempt_id),
      externalCheckoutId: stringValue(object.checkout_session_id) ??
        stringValue(object.session_id) ?? stringValue(object.payment_id),
      externalSubscriptionId,
    };
  },
};
