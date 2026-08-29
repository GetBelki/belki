import type {
  ManagedPaymentPlanKey,
  SubscriptionStatus,
} from "../../shared/contracts";
import { ApiError, jsonParse } from "../lib/http";
import {
  assertStripeLivemode,
  stripeRequest,
  type StripeClientConfiguration,
} from "../lib/stripe";
import { verifyStripeSignature } from "../lib/stripe-signature";
import type {
  PaymentCheckoutRequest,
  PaymentProviderAdapter,
  PaymentProviderPlan,
  PaymentProviderTestResult,
  PaymentSubscriptionSnapshot,
  PaymentWebhookEvent,
  ResolvedPaymentProviderAccount,
} from "./types";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

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

function unixIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

function stripeCredentials(account: ResolvedPaymentProviderAccount) {
  if (account.provider !== "stripe" || account.credentials.provider !== "stripe") {
    throw new ApiError(503, "payment_provider_mismatch", "The selected payment account is not a Stripe account.");
  }
  return account.credentials.credentials;
}

function client(account: ResolvedPaymentProviderAccount): StripeClientConfiguration {
  return {
    environment: account.environment,
    secretKey: stripeCredentials(account).secretKey,
  };
}

function portalConfiguration(account: ResolvedPaymentProviderAccount): string {
  const value = account.configuration.billingPortalConfigurationId;
  if (typeof value !== "string" || !value.startsWith("bpc_")) {
    throw new ApiError(503, "billing_not_configured", "The Stripe billing portal is not configured.");
  }
  return value;
}

function planFromReference(
  account: ResolvedPaymentProviderAccount,
  externalReference: string,
): ManagedPaymentPlanKey | null {
  return accountPlans(account).find(
    (plan) => plan.externalReference === externalReference,
  )?.id ?? null;
}

function normalizeSubscriptionStatus(value: string | null): SubscriptionStatus {
  if (value === "trialing" || value === "active" || value === "past_due" || value === "unpaid" || value === "paused") {
    return value;
  }
  if (value === "canceled" || value === "incomplete_expired") return "cancelled";
  return "pending";
}

function eventSubscriptionId(object: Record<string, unknown>): string | null {
  const direct = typeof object.subscription === "string"
    ? object.subscription
    : stringValue(objectValue(object.subscription).id);
  if (direct) return direct;
  const details = objectValue(objectValue(objectValue(object.parent).subscription_details));
  return typeof details.subscription === "string"
    ? details.subscription
    : stringValue(objectValue(details.subscription).id);
}

function webhookKind(eventType: string): PaymentWebhookEvent["kind"] {
  if (eventType === "checkout.session.completed" || eventType === "checkout.session.async_payment_succeeded") {
    return "checkout_completed";
  }
  if (eventType === "checkout.session.expired" || eventType === "checkout.session.async_payment_failed") {
    return "checkout_failed";
  }
  if (eventType === "customer.subscription.deleted") return "subscription_deleted";
  if (eventType.startsWith("customer.subscription.")) return "subscription_changed";
  if (eventType.startsWith("subscription_schedule.")) return "scheduled_change_changed";
  if (eventType.startsWith("invoice.")) return "invoice_changed";
  return "ignored";
}

async function testStripeAccount(
  account: ResolvedPaymentProviderAccount,
): Promise<PaymentProviderTestResult> {
  try {
    const credentials = stripeCredentials(account);
    if (!credentials.webhookSecret.startsWith("whsec_")) {
      throw new Error("The Stripe webhook secret must start with whsec_.");
    }
    for (const plan of accountPlans(account)) {
      const price = await stripeRequest<Record<string, unknown>>(
        client(account),
        `/prices/${encodeURIComponent(plan.externalReference)}`,
      );
      const recurring = objectValue(price.recurring);
      const failures = [
        price.active !== true ? "inactive" : null,
        price.livemode !== (account.environment === "live") ? "wrong environment" : null,
        price.currency !== plan.currency.toLowerCase()
          ? `currency does not match ${plan.currency}`
          : null,
        price.unit_amount !== plan.amountMinor ? "wrong amount" : null,
        recurring.interval !== "month" || recurring.interval_count !== 1 ? "not monthly" : null,
        price.tax_behavior !== "exclusive" ? "tax behavior is not exclusive" : null,
      ].filter(Boolean);
      if (failures.length) {
        throw new Error(`${plan.name} Stripe Price is invalid: ${failures.join(", ")}.`);
      }
    }
    const portal = await stripeRequest<Record<string, unknown>>(
      client(account),
      `/billing_portal/configurations/${encodeURIComponent(portalConfiguration(account))}`,
    );
    if (portal.active !== true) throw new Error("The Stripe billing portal configuration is inactive.");
    return {
      status: "passed",
      message: `Stripe ${account.environment} credentials and plan catalogue verified.`,
    };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Stripe configuration check failed.",
    };
  }
}

export const stripePaymentAdapter: PaymentProviderAdapter = {
  provider: "stripe",
  version: "stripe-v1",
  testAccount: testStripeAccount,
  async createCheckout(account, input: PaymentCheckoutRequest) {
    const params = new URLSearchParams({
      "line_items[0][price]": accountPlan(account, input.planKey).externalReference,
      "line_items[0][quantity]": "1",
      mode: "subscription",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.workspaceId,
      customer_email: input.customerEmail,
      "automatic_tax[enabled]": "true",
      billing_address_collection: "required",
      "tax_id_collection[enabled]": "true",
      "metadata[workspace_id]": input.workspaceId,
      "metadata[plan_key]": input.planKey,
      "metadata[checkout_attempt_id]": input.attemptId,
      "subscription_data[metadata][workspace_id]": input.workspaceId,
      "subscription_data[metadata][plan_key]": input.planKey,
    });
    const session = await stripeRequest<Record<string, unknown>>(client(account), "/checkout/sessions", {
      method: "POST",
      params,
      idempotencyKey: `belki:${input.attemptId}:checkout`,
    });
    const url = stringValue(session.url);
    const externalSessionId = stringValue(session.id);
    const expiresAtUnix = numberValue(session.expires_at);
    if (!url || !externalSessionId) {
      throw new ApiError(502, "payment_provider_error", "Stripe did not return a complete Checkout session.");
    }
    return {
      url,
      externalSessionId,
      expiresAt: expiresAtUnix === null ? null : unixIso(expiresAtUnix),
      providerState: {},
    };
  },
  async expireCheckout(account, externalSessionId, idempotencyKey) {
    await stripeRequest(client(account), `/checkout/sessions/${encodeURIComponent(externalSessionId)}/expire`, {
      method: "POST",
      idempotencyKey,
    });
  },
  retrieveSubscription(account, externalSubscriptionId) {
    return stripeRequest(client(account), `/subscriptions/${encodeURIComponent(externalSubscriptionId)}`);
  },
  normalizeSubscription(account, object): PaymentSubscriptionSnapshot {
    if (typeof object.livemode !== "boolean") {
      throw new ApiError(409, "unsupported_subscription", "Stripe subscription data is missing its environment marker.");
    }
    assertStripeLivemode(client(account), object.livemode);
    const id = stringValue(object.id);
    const customer = typeof object.customer === "string"
      ? object.customer
      : stringValue(objectValue(object.customer).id);
    const items = arrayValue(objectValue(object.items).data);
    if (!id || !customer || items.length !== 1) {
      throw new ApiError(409, "unsupported_subscription", "Belki requires exactly one subscription item.");
    }
    const item = objectValue(items[0]);
    const itemId = stringValue(item.id);
    const externalPlanReference = stringValue(objectValue(item.price).id);
    const planKey = externalPlanReference ? planFromReference(account, externalPlanReference) : null;
    const start = numberValue(item.current_period_start ?? object.current_period_start);
    const end = numberValue(item.current_period_end ?? object.current_period_end);
    if (!itemId || !externalPlanReference || !planKey || start === null || end === null) {
      throw new ApiError(409, "unsupported_subscription", "Subscription data does not match the Belki plan catalogue.");
    }
    const schedule = typeof object.schedule === "string"
      ? object.schedule
      : stringValue(objectValue(object.schedule).id);
    const discounts = arrayValue(object.discounts ?? objectValue(object.discounts).data);
    return {
      externalSubscriptionId: id,
      externalCustomerId: customer,
      externalItemId: itemId,
      externalPlanReference,
      planKey,
      quantity: numberValue(item.quantity) ?? 1,
      status: normalizeSubscriptionStatus(stringValue(object.status)),
      rawStatus: stringValue(object.status) ?? "unknown",
      currentPeriodStart: unixIso(start),
      currentPeriodEnd: unixIso(end),
      currentPeriodStartUnix: start,
      currentPeriodEndUnix: end,
      cancelAtPeriodEnd: object.cancel_at_period_end === true,
      externalScheduledChangeId: schedule,
      hasTrial: numberValue(object.trial_end) !== null || stringValue(object.status) === "trialing",
      hasDiscount: object.discount != null || discounts.length > 0,
      taxHandlingReady: objectValue(object.automatic_tax).enabled === true,
      providerState: {
        externalItemId: itemId,
        externalScheduleId: schedule,
      },
      object,
    };
  },
  async createManagementSession(account, externalCustomerId, returnUrl) {
    const session = await stripeRequest<Record<string, unknown>>(client(account), "/billing_portal/sessions", {
      method: "POST",
      params: new URLSearchParams({ customer: externalCustomerId, return_url: returnUrl }),
    });
    const url = stringValue(session.url);
    if (!url) throw new ApiError(502, "payment_provider_error", "Stripe did not return a billing URL.");
    return { url, externalActionId: stringValue(session.id) };
  },
  async createPlanChangeSession(account, input) {
    if (!input.externalItemId) {
      throw new ApiError(409, "unsupported_subscription", "Stripe plan changes require a subscription item ID.");
    }
    const session = await stripeRequest<Record<string, unknown>>(client(account), "/billing_portal/sessions", {
      method: "POST",
      idempotencyKey: `belki:${input.actionId}:upgrade-portal`,
      params: new URLSearchParams({
        customer: input.externalCustomerId,
        configuration: portalConfiguration(account),
        return_url: input.returnUrl,
        "flow_data[type]": "subscription_update_confirm",
        "flow_data[subscription_update_confirm][subscription]": input.externalSubscriptionId,
        "flow_data[subscription_update_confirm][items][0][id]": input.externalItemId,
        "flow_data[subscription_update_confirm][items][0][price]": accountPlan(account, input.targetPlanKey).externalReference,
        "flow_data[subscription_update_confirm][items][0][quantity]": "1",
        "flow_data[after_completion][type]": "redirect",
        "flow_data[after_completion][redirect][return_url]": input.completionUrl,
      }),
    });
    const url = stringValue(session.url);
    if (!url) throw new ApiError(502, "payment_provider_error", "Stripe did not return a billing URL.");
    return { url, externalActionId: stringValue(session.id) };
  },
  async createCancellationSession(account, input) {
    const session = await stripeRequest<Record<string, unknown>>(client(account), "/billing_portal/sessions", {
      method: "POST",
      params: new URLSearchParams({
        customer: input.externalCustomerId,
        configuration: portalConfiguration(account),
        return_url: input.returnUrl,
        "flow_data[type]": "subscription_cancel",
        "flow_data[subscription_cancel][subscription]": input.externalSubscriptionId,
        "flow_data[after_completion][type]": "redirect",
        "flow_data[after_completion][redirect][return_url]": input.completionUrl,
      }),
    });
    const url = stringValue(session.url);
    if (!url) throw new ApiError(502, "payment_provider_error", "Stripe did not return a cancellation URL.");
    return { url, externalActionId: stringValue(session.id) };
  },
  async schedulePlanChange(account, input) {
    let scheduleId = input.subscription.externalScheduledChangeId ?? input.existingExternalScheduleId;
    if (
      input.subscription.externalScheduledChangeId && input.existingExternalScheduleId &&
      input.subscription.externalScheduledChangeId !== input.existingExternalScheduleId
    ) {
      throw new ApiError(409, "foreign_subscription_schedule", "The Stripe subscription is attached to an unexpected schedule.");
    }
    let schedule: Record<string, unknown>;
    if (scheduleId) {
      schedule = await stripeRequest(client(account), `/subscription_schedules/${encodeURIComponent(scheduleId)}`);
      if (stringValue(objectValue(schedule.metadata).belki_plan_change_id) !== input.changeId) {
        throw new ApiError(409, "foreign_subscription_schedule", "The attached Stripe schedule is not owned by this plan change.");
      }
    } else {
      schedule = await stripeRequest<Record<string, unknown>>(client(account), "/subscription_schedules", {
        method: "POST",
        idempotencyKey: `belki:${input.changeId}:schedule`,
        params: new URLSearchParams({
          from_subscription: input.subscription.externalSubscriptionId,
          "metadata[workspace_id]": input.workspaceId,
          "metadata[belki_plan_change_id]": input.changeId,
          "metadata[target_plan_key]": input.targetPlanKey,
        }),
      });
      scheduleId = stringValue(schedule.id);
    }
    if (!scheduleId) {
      throw new ApiError(502, "payment_provider_error", "Stripe did not return a schedule ID.");
    }
    const currentPhase = objectValue(arrayValue(schedule.phases)[0]);
    const phaseStart = numberValue(currentPhase.start_date) ?? input.subscription.currentPeriodStartUnix;
    const phaseEnd = numberValue(currentPhase.end_date) ?? input.subscription.currentPeriodEndUnix;
    try {
      await stripeRequest(client(account), `/subscription_schedules/${encodeURIComponent(scheduleId)}`, {
        method: "POST",
        idempotencyKey: `belki:${input.changeId}:configure`,
        params: new URLSearchParams({
          end_behavior: "release",
          proration_behavior: "none",
          "metadata[workspace_id]": input.workspaceId,
          "metadata[belki_plan_change_id]": input.changeId,
          "metadata[target_plan_key]": input.targetPlanKey,
          "phases[0][items][0][price]": input.subscription.externalPlanReference,
          "phases[0][items][0][quantity]": "1",
          "phases[0][start_date]": String(phaseStart),
          "phases[0][end_date]": String(phaseEnd),
          "phases[0][proration_behavior]": "none",
          "phases[0][automatic_tax][enabled]": "true",
          "phases[0][metadata][workspace_id]": input.workspaceId,
          "phases[0][metadata][plan_key]": input.subscription.planKey,
          "phases[1][items][0][price]": accountPlan(account, input.targetPlanKey).externalReference,
          "phases[1][items][0][quantity]": "1",
          "phases[1][iterations]": "1",
          "phases[1][proration_behavior]": "none",
          "phases[1][automatic_tax][enabled]": "true",
          "phases[1][metadata][workspace_id]": input.workspaceId,
          "phases[1][metadata][plan_key]": input.targetPlanKey,
          "phases[1][metadata][belki_plan_change_id]": input.changeId,
        }),
      });
    } catch (configurationError) {
      try {
        await stripeRequest(client(account), `/subscription_schedules/${encodeURIComponent(scheduleId)}/release`, {
          method: "POST",
          idempotencyKey: `belki:${input.changeId}:release-after-failure`,
        });
      } catch {
        throw new ApiError(
          502,
          "scheduled_change_cleanup_failed",
          "Stripe created a schedule that requires operator reconciliation.",
          { externalScheduleId: scheduleId },
        );
      }
      throw configurationError;
    }
    return {
      externalScheduleId: scheduleId,
      providerState: { phaseStart, phaseEnd },
    };
  },
  async releaseScheduledPlanChange(account, _externalSubscriptionId, externalScheduleId, idempotencyKey) {
    try {
      await stripeRequest(client(account), `/subscription_schedules/${encodeURIComponent(externalScheduleId)}/release`, {
        method: "POST",
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
  },
  reactivateSubscription(account, externalSubscriptionId, idempotencyKey) {
    return stripeRequest(client(account), `/subscriptions/${encodeURIComponent(externalSubscriptionId)}`, {
      method: "POST",
      params: new URLSearchParams({ cancel_at_period_end: "false" }),
      idempotencyKey,
    });
  },
  async verifyAndParseWebhook(account, payload, headers) {
    if (new TextEncoder().encode(payload).byteLength > MAX_WEBHOOK_BYTES) {
      throw new ApiError(400, "payment_payload_too_large", "The payment webhook payload is too large.");
    }
    const signature = headers.get("stripe-signature");
    if (!signature) throw new ApiError(400, "payment_signature_missing", "The Stripe signature is required.");
    const credentials = stripeCredentials(account);
    if (!(await verifyStripeSignature(payload, signature, credentials.webhookSecret))) {
      throw new ApiError(400, "payment_signature_invalid", "The Stripe signature is invalid.");
    }
    const event = jsonParse<Record<string, unknown>>(payload, {});
    const externalEventId = stringValue(event.id);
    const eventType = stringValue(event.type);
    const eventLivemode = typeof event.livemode === "boolean" ? event.livemode : null;
    const object = objectValue(objectValue(event.data).object);
    if (!externalEventId || !eventType || eventLivemode === null) {
      throw new ApiError(400, "payment_event_invalid", "The Stripe event is invalid.");
    }
    try {
      assertStripeLivemode(client(account), eventLivemode);
    } catch (error) {
      if (error instanceof ApiError && error.code === "stripe_environment_mismatch") {
        throw new ApiError(400, "payment_environment_mismatch", error.message);
      }
      throw error;
    }
    const metadata = objectValue(object.metadata);
    const kind = webhookKind(eventType);
    let externalSubscriptionId: string | null = null;
    if (kind === "checkout_completed") externalSubscriptionId = typeof object.subscription === "string"
      ? object.subscription
      : stringValue(objectValue(object.subscription).id);
    else if (kind === "subscription_changed" || kind === "subscription_deleted") externalSubscriptionId = stringValue(object.id);
    else if (kind === "invoice_changed") externalSubscriptionId = eventSubscriptionId(object);
    else if (kind === "scheduled_change_changed") externalSubscriptionId = typeof object.subscription === "string"
      ? object.subscription
      : stringValue(objectValue(object.subscription).id);
    return {
      externalEventId,
      eventType,
      environment: eventLivemode ? "live" : "test",
      kind,
      object,
      workspaceId: stringValue(metadata.workspace_id) ?? stringValue(object.client_reference_id),
      checkoutAttemptId: stringValue(metadata.checkout_attempt_id),
      externalCheckoutId: kind === "checkout_completed" || kind === "checkout_failed"
        ? stringValue(object.id)
        : null,
      externalSubscriptionId,
    };
  },
};

export function stripeClientForAccount(account: ResolvedPaymentProviderAccount): StripeClientConfiguration {
  return client(account);
}

export function stripePortalConfiguration(account: ResolvedPaymentProviderAccount): string {
  return portalConfiguration(account);
}
