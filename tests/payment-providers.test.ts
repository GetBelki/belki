import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMPLEMENTED_PAYMENT_PROVIDERS,
  PAYMENT_PROVIDER_CAPABILITIES,
  PLANNED_PAYMENT_PROVIDERS,
} from "../src/shared/payment-providers";
import { DEFAULT_BILLING_PLANS } from "../src/shared/billing-plans";
import { paymentProviderAdapter } from "../src/worker/payments/registry";
import { dodoPaymentAdapter } from "../src/worker/payments/dodo";
import { stripePaymentAdapter } from "../src/worker/payments/stripe";
import type {
  PaymentProviderPlan,
  ResolvedPaymentProviderAccount,
} from "../src/worker/payments/types";

function providerPlan(
  planId: string,
  externalReference: string,
  currency: string,
  amountMinor: number,
  externalProductId: string | null,
): PaymentProviderPlan {
  const definition = DEFAULT_BILLING_PLANS.find((plan) => plan.id === planId);
  if (!definition) throw new Error(`Missing test billing plan ${planId}.`);
  return {
    ...definition,
    allowedSources: [...definition.allowedSources],
    planKey: planId,
    externalReference,
    externalProductId,
    currency,
    amountMinor,
    billingInterval: "month",
  };
}

const stripeAccount: ResolvedPaymentProviderAccount = {
  accountId: "stripe-test-account",
  provider: "stripe",
  label: "Test Stripe",
  environment: "test",
  adapterVersion: "stripe-v1",
  credentialVersion: 1,
  credentials: {
    provider: "stripe",
    credentials: {
      secretKey: "sk_test_example_secret",
      webhookSecret: "whsec_example_secret",
    },
  },
  catalogue: {
    starter: providerPlan("starter", "price_starter", "USD", 1_250, null),
    studio: providerPlan("studio", "price_studio", "USD", 3_500, null),
    agency: providerPlan("agency", "price_agency", "USD", 17_500, null),
  },
  configuration: { billingPortalConfigurationId: "bpc_example" },
  webhookEndpointKey: "stripe-test-endpoint",
};

const dodoWebhookKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const dodoAccount: ResolvedPaymentProviderAccount = {
  accountId: "dodo-test-account",
  provider: "dodo",
  label: "Test Dodo",
  environment: "test",
  adapterVersion: "dodo-v1",
  credentialVersion: 1,
  credentials: {
    provider: "dodo",
    credentials: {
      apiKey: "dodo_test_example_secret",
      webhookSecret: `whsec_${dodoWebhookKey.toString("base64")}`,
    },
  },
  catalogue: {
    starter: providerPlan("starter", "pdt_starter", "BRL", 4_990, "pdt_starter"),
    studio: providerPlan("studio", "pdt_studio", "BRL", 9_990, "pdt_studio"),
    agency: providerPlan("agency", "pdt_agency", "BRL", 24_990, "pdt_agency"),
  },
  configuration: {},
  webhookEndpointKey: "dodo-test-endpoint",
};

function dodoSubscription(overrides: Record<string, unknown> = {}) {
  return {
    subscription_id: "sub_dodo_example",
    customer: { customer_id: "cus_dodo_example" },
    product_id: "pdt_studio",
    quantity: 1,
    status: "active",
    previous_billing_date: "2026-08-01T00:00:00.000Z",
    next_billing_date: "2026-09-01T00:00:00.000Z",
    cancel_at_next_billing_date: false,
    trial_period_days: 0,
    tax_inclusive: false,
    metadata: { workspace_id: "workspace-example" },
    ...overrides,
  };
}

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_example",
    customer: "cus_example",
    livemode: false,
    status: "active",
    cancel_at_period_end: false,
    automatic_tax: { enabled: true },
    metadata: { workspace_id: "workspace-example" },
    items: {
      data: [{
        id: "si_example",
        price: { id: "price_studio" },
        quantity: 1,
        current_period_start: 1_787_961_600,
        current_period_end: 1_790_640_000,
      }],
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("payment provider adapters", () => {
  it("keeps provider APIs and Worker Stripe bindings out of the billing route", () => {
    const billingRoute = readFileSync(
      resolve("src/worker/routes/billing.ts"),
      "utf8",
    );

    expect(billingRoute).toMatch(/paymentProviderAdapter/u);
    expect(billingRoute).not.toMatch(/from "\.\.\/lib\/stripe"/u);
    expect(billingRoute).not.toMatch(/STRIPE_(?:SECRET_KEY|WEBHOOK_SECRET|STARTER_PRICE_ID|STUDIO_PRICE_ID|AGENCY_PRICE_ID)/u);
  });

  it("registers Stripe and Dodo as selectable adapters", () => {
    expect(IMPLEMENTED_PAYMENT_PROVIDERS).toEqual(["stripe", "dodo"]);
    expect(PLANNED_PAYMENT_PROVIDERS).toEqual([
      { id: "rebill", label: "Rebill" },
      { id: "polar", label: "Polar" },
    ]);
    expect(paymentProviderAdapter("stripe")).toBe(stripePaymentAdapter);
    expect(paymentProviderAdapter("dodo")).toBe(dodoPaymentAdapter);
    expect(PAYMENT_PROVIDER_CAPABILITIES.dodo).toMatchObject({
      hostedCheckout: true,
      customerPortal: true,
      webhooks: true,
    });
  });

  it("normalizes provider data through the Stripe adapter and installation catalogue", () => {
    expect(stripePaymentAdapter.normalizeSubscription(
      stripeAccount,
      stripeSubscription(),
    )).toMatchObject({
      externalSubscriptionId: "sub_example",
      externalCustomerId: "cus_example",
      externalItemId: "si_example",
      externalPlanReference: "price_studio",
      planKey: "studio",
      status: "active",
      taxHandlingReady: true,
    });

    expect(() => stripePaymentAdapter.normalizeSubscription(
      stripeAccount,
      stripeSubscription({ livemode: true }),
    )).toThrow(/different test\/live environment/u);
  });

  it("normalizes an installer-defined plan ID without adapter changes", () => {
    const customPlan = {
      ...providerPlan("starter", "price_latam_growth", "USD", 5_000, null),
      id: "latam_growth",
      planKey: "latam_growth",
      name: "Latam Growth",
      description: "Regional catalogue plan",
    };
    const customAccount: ResolvedPaymentProviderAccount = {
      ...stripeAccount,
      catalogue: { latam_growth: customPlan },
    };

    expect(stripePaymentAdapter.normalizeSubscription(
      customAccount,
      stripeSubscription({
        items: {
          data: [{
            id: "si_example",
            price: { id: "price_latam_growth" },
            quantity: 1,
            current_period_start: 1_787_961_600,
            current_period_end: 1_790_640_000,
          }],
        },
      }),
    )).toMatchObject({
      externalPlanReference: "price_latam_growth",
      planKey: "latam_growth",
    });
  });

  it("normalizes Dodo subscriptions through the same billing contract", () => {
    expect(dodoPaymentAdapter.normalizeSubscription(
      dodoAccount,
      dodoSubscription({
        scheduled_change: {
          id: "scheduled_dodo_example",
          product_id: "pdt_starter",
          effective_at: "2026-09-01T00:00:00.000Z",
        },
      }),
    )).toMatchObject({
      externalSubscriptionId: "sub_dodo_example",
      externalCustomerId: "cus_dodo_example",
      externalPlanReference: "pdt_studio",
      planKey: "studio",
      status: "active",
      externalScheduledChangeId: "scheduled_dodo_example",
      taxHandlingReady: true,
    });
  });

  it("verifies Stripe against the account-specific currency and amounts", async () => {
    const fetchMock = vi.fn();
    for (const plan of Object.values(stripeAccount.catalogue)) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        id: plan.externalReference,
        active: true,
        livemode: false,
        currency: "usd",
        unit_amount: plan.amountMinor,
        recurring: { interval: "month", interval_count: 1 },
        tax_behavior: "exclusive",
      }), { status: 200 }));
    }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: "bpc_example",
      active: true,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(stripePaymentAdapter.testAccount(stripeAccount)).resolves.toMatchObject({
      status: "passed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("creates Dodo hosted Checkout sessions with Belki correlation metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: "cks_example",
      checkout_url: "https://checkout.dodopayments.com/example",
      payment_id: "pay_example",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(dodoPaymentAdapter.createCheckout(dodoAccount, {
      attemptId: "attempt-example",
      workspaceId: "workspace-example",
      planKey: "studio",
      customerEmail: "owner@example.com",
      successUrl: "https://app.example.com/billing?checkout=success",
      cancelUrl: "https://app.example.com/billing?checkout=cancelled",
    })).resolves.toMatchObject({
      externalSessionId: "cks_example",
      url: "https://checkout.dodopayments.com/example",
      providerState: { paymentId: "pay_example" },
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://test.dodopayments.com/checkouts");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(typeof request.body).toBe("string");
    expect(JSON.parse(request.body as string)).toMatchObject({
      product_cart: [{ product_id: "pdt_studio", quantity: 1 }],
      metadata: {
        workspace_id: "workspace-example",
        plan_key: "studio",
        checkout_attempt_id: "attempt-example",
      },
    });
  });

  it("verifies the configured Dodo monthly product catalogue", async () => {
    const plans = Object.values(dodoAccount.catalogue);
    const fetchMock = vi.fn();
    for (const plan of plans) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        product_id: plan.externalReference,
        business_id: "bus_example",
        is_recurring: true,
        price: {
          type: "recurring_price",
          currency: "BRL",
          price: plan.amountMinor,
          payment_frequency_interval: "Month",
          payment_frequency_count: 1,
          tax_inclusive: false,
        },
      }), { status: 200 }));
    }
    vi.stubGlobal("fetch", fetchMock);

    await expect(dodoPaymentAdapter.testAccount(dodoAccount)).resolves.toMatchObject({
      status: "passed",
      details: { businessId: "bus_example" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("verifies Standard Webhooks signatures and translates Dodo events", async () => {
    const payload = JSON.stringify({
      business_id: "bus_example",
      type: "payment.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        payload_type: "Payment",
        payment_id: "pay_example",
        subscription_id: "sub_dodo_example",
        metadata: {
          workspace_id: "workspace-example",
          checkout_attempt_id: "attempt-example",
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1_000);
    const webhookId = "msg_dodo_example";
    const signature = createHmac("sha256", dodoWebhookKey)
      .update(`${webhookId}.${timestamp}.${payload}`)
      .digest("base64");
    const headers = new Headers({
      "webhook-id": webhookId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${signature}`,
    });

    await expect(dodoPaymentAdapter.verifyAndParseWebhook(
      dodoAccount,
      payload,
      headers,
    )).resolves.toMatchObject({
      externalEventId: webhookId,
      kind: "checkout_completed",
      environment: "test",
      workspaceId: "workspace-example",
      checkoutAttemptId: "attempt-example",
      externalCheckoutId: "pay_example",
      externalSubscriptionId: "sub_dodo_example",
    });
  });

  it("verifies and translates Stripe webhooks into provider-neutral events", async () => {
    const payload = JSON.stringify({
      id: "evt_example",
      type: "checkout.session.completed",
      livemode: false,
      data: {
        object: {
          id: "cs_example",
          subscription: "sub_example",
          client_reference_id: "workspace-example",
          metadata: {
            workspace_id: "workspace-example",
            checkout_attempt_id: "attempt-example",
          },
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = createHmac("sha256", "whsec_example_secret")
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    const headers = new Headers({
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    });

    await expect(stripePaymentAdapter.verifyAndParseWebhook(
      stripeAccount,
      payload,
      headers,
    )).resolves.toMatchObject({
      externalEventId: "evt_example",
      kind: "checkout_completed",
      environment: "test",
      workspaceId: "workspace-example",
      checkoutAttemptId: "attempt-example",
      externalCheckoutId: "cs_example",
      externalSubscriptionId: "sub_example",
    });
  });

  it("releases a Stripe schedule when configuring the downgrade fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "sub_sched_example",
        phases: [],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Invalid schedule", type: "invalid_request_error" },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "sub_sched_example",
        released_subscription: "sub_example",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(stripePaymentAdapter.schedulePlanChange(stripeAccount, {
      changeId: "change-example",
      workspaceId: "workspace-example",
      targetPlanKey: "starter",
      subscription: stripePaymentAdapter.normalizeSubscription(
        stripeAccount,
        stripeSubscription(),
      ),
      existingExternalScheduleId: null,
    })).rejects.toMatchObject({ code: "stripe_error" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "/subscription_schedules/sub_sched_example/release",
    );
  });
});
