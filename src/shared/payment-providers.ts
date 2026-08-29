export const PAYMENT_PROVIDERS = ["stripe", "dodo"] as const;

export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const IMPLEMENTED_PAYMENT_PROVIDERS = ["stripe", "dodo"] as const satisfies readonly PaymentProvider[];

// Roadmap entries are presentation-only. They intentionally remain outside
// PaymentProvider so APIs, persisted accounts, and adapter resolution cannot
// accept them before their implementations are complete.
export const PLANNED_PAYMENT_PROVIDERS = [
  { id: "rebill", label: "Rebill" },
  { id: "polar", label: "Polar" },
] as const;

export const PAYMENT_PROVIDER_LABELS: Record<PaymentProvider, string> = {
  stripe: "Stripe",
  dodo: "Dodo Payments",
};

export const PAYMENT_PROVIDER_DASHBOARD_URLS: Record<PaymentProvider, string> = {
  stripe: "https://dashboard.stripe.com/",
  dodo: "https://app.dodopayments.com/",
};

export const PAYMENT_ENVIRONMENTS = ["test", "live"] as const;
export type PaymentEnvironment = (typeof PAYMENT_ENVIRONMENTS)[number];

export const PAYMENT_PROVIDER_CAPABILITIES: Record<PaymentProvider, {
  hostedCheckout: boolean;
  customerPortal: boolean;
  planChanges: boolean;
  scheduledDowngrades: boolean;
  webhooks: boolean;
}> = {
  stripe: {
    hostedCheckout: true,
    customerPortal: true,
    planChanges: true,
    scheduledDowngrades: true,
    webhooks: true,
  },
  dodo: {
    hostedCheckout: true,
    customerPortal: true,
    planChanges: true,
    scheduledDowngrades: true,
    webhooks: true,
  },
};
