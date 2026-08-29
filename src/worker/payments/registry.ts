import {
  PAYMENT_PROVIDER_CAPABILITIES,
  PAYMENT_PROVIDER_LABELS,
  type PaymentProvider,
} from "../../shared/payment-providers";
import { ApiError } from "../lib/http";
import { dodoPaymentAdapter } from "./dodo";
import { stripePaymentAdapter } from "./stripe";
import type { PaymentProviderAdapter } from "./types";

export interface PaymentProviderAdapterDefinition {
  id: PaymentProvider;
  label: string;
  version: string | null;
  implemented: boolean;
  capabilities: typeof PAYMENT_PROVIDER_CAPABILITIES[PaymentProvider];
  adapter: PaymentProviderAdapter | null;
}

export const PAYMENT_PROVIDER_ADAPTERS: Record<
  PaymentProvider,
  PaymentProviderAdapterDefinition
> = {
  stripe: {
    id: "stripe",
    label: PAYMENT_PROVIDER_LABELS.stripe,
    version: stripePaymentAdapter.version,
    implemented: true,
    capabilities: PAYMENT_PROVIDER_CAPABILITIES.stripe,
    adapter: stripePaymentAdapter,
  },
  dodo: {
    id: "dodo",
    label: PAYMENT_PROVIDER_LABELS.dodo,
    version: dodoPaymentAdapter.version,
    implemented: true,
    capabilities: PAYMENT_PROVIDER_CAPABILITIES.dodo,
    adapter: dodoPaymentAdapter,
  },
};

export function paymentProviderAdapter(provider: PaymentProvider): PaymentProviderAdapter {
  const definition = PAYMENT_PROVIDER_ADAPTERS[provider];
  if (!definition.adapter) {
    throw new ApiError(503, "payment_provider_unavailable", `${definition.label} payment support is not installed.`);
  }
  return definition.adapter;
}
