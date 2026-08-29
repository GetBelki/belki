import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, CreditCard, KeyRound } from "lucide-react";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import type {
  BillingPlanDefinitionInput,
  PaymentProviderAccountInput,
} from "../../shared/contracts";
import { AppIcon } from "../components/app-icon";
import { PaymentProviderAccountForm } from "../components/payment-provider-form";
import { Button, Skeleton } from "../components/ui";
import { useApp } from "../context";
import { api, post } from "../lib/api";
import { APP_NAME } from "../lib/branding";

interface SetupConfiguration {
  mode: "undecided" | "self_hosted" | "managed";
  required: boolean;
  legacyImportAvailable: boolean;
  plans: BillingPlanDefinitionInput[];
  accounts: Array<{ id: string }>;
}

export default function PaymentOnboardingPage() {
  const { session } = useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [webhookEndpointKey] = useState(() => crypto.randomUUID());
  const [setupPath, setSetupPath] = useState<"managed" | null>(null);
  const configuration = useQuery({
    queryKey: ["operator-payment-providers"],
    queryFn: () => api<SetupConfiguration>("/operator/payment-providers"),
  });
  const finish = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["status"] }),
      queryClient.invalidateQueries({ queryKey: ["operator-payment-providers"] }),
    ]);
    void navigate("/onboarding/project", { replace: true });
  };
  const createAccount = useMutation({
    mutationFn: (input: PaymentProviderAccountInput) => post("/operator/payment-providers", input),
    onSuccess: finish,
  });
  const importLegacy = useMutation({
    mutationFn: () => post("/operator/payment-providers/import-stripe"),
    onSuccess: finish,
  });
  const selectSelfHosted = useMutation({
    mutationFn: () => post("/operator/payment-providers/self-hosted"),
    onSuccess: finish,
  });

  if (!session.isPlatformOperator) return <Navigate to="/" replace />;
  if (configuration.isPending) return <main className="onboarding-shell"><Skeleton className="billing-page-skeleton" /></main>;

  return (
    <main className="onboarding-shell provider-onboarding-shell">
      <header className="onboarding-brand"><span className="brand-mark"><AppIcon /></span><strong>{APP_NAME}</strong></header>
      <div className="onboarding-layout provider-onboarding-layout">
        <aside className="onboarding-progress">
          <span className="eyebrow">Installation setup</span>
          <h2>Choose how this Belki installation will be used.</h2>
          <p className="provider-onboarding-copy">Managed installations sell subscriptions through one selected provider. Self-hosted installations run internally without Checkout and can enable managed billing later from Operator.</p>
        </aside>
        <section className="onboarding-content">
          <div className="onboarding-heading">
            <span>Payment setup</span>
            <h1>{setupPath || configuration.data?.mode === "managed" ? "Connect one payment provider" : "Select an installation mode"}</h1>
            <p>{setupPath || configuration.data?.mode === "managed" ? "Define this installation's subscription plans, choose an installed payment provider, then map each plan to its provider price. Stripe and Dodo Payments are available now; Rebill and Polar are listed as coming soon." : "You only need payments when this installation will sell managed subscriptions."}</p>
          </div>
          {setupPath || configuration.data?.mode === "managed" ? (
            <>
              {configuration.data?.legacyImportAvailable ? (
                <div className="payment-import-card">
                  <CreditCard size={20} />
                  <div><strong>Stripe is already configured in the Worker</strong><span>You may import it, or configure any installed payment provider from scratch below.</span></div>
                  <Button disabled={importLegacy.isPending} onClick={() => importLegacy.mutate()}>{importLegacy.isPending ? "Importing…" : "Import current Stripe configuration"}</Button>
                </div>
              ) : null}
              <PaymentProviderAccountForm
                error={createAccount.error?.message}
                initialPlans={configuration.data?.plans}
                onSubmit={(input) => createAccount.mutate(input)}
                pending={createAccount.isPending}
                plansLocked={Boolean(configuration.data?.accounts.length)}
                webhookEndpointKey={webhookEndpointKey}
                webhookUrl={`${window.location.origin}/api/webhooks/payments/${encodeURIComponent(webhookEndpointKey)}`}
              />
              {configuration.data?.mode !== "managed" ? <Button onClick={() => setSetupPath(null)} type="button" variant="ghost">Back to installation modes</Button> : null}
            </>
          ) : (
            <div className="payment-mode-grid">
              <div className="payment-mode-card">
                <CreditCard size={22} />
                <div><strong>Managed subscriptions</strong><span>Use Stripe or Dodo Payments today. Rebill and Polar are coming soon.</span></div>
                <Button onClick={() => setSetupPath("managed")}>Configure a payment provider</Button>
              </div>
              <div className="payment-mode-card">
                <Building2 size={22} />
                <div><strong>Self-hosted / in-house</strong><span>Use Belki internally with no sales, Checkout, or payment provider.</span></div>
                <Button disabled={selectSelfHosted.isPending} onClick={() => selectSelfHosted.mutate()} variant="secondary">{selectSelfHosted.isPending ? "Saving…" : "Continue without payments"}</Button>
              </div>
            </div>
          )}
          {importLegacy.isError ? <p className="form-error">{importLegacy.error.message}</p> : null}
          {selectSelfHosted.isError ? <p className="form-error">{selectSelfHosted.error.message}</p> : null}
          <div className="onboarding-assurance"><KeyRound size={18} /><span>API and webhook secrets are encrypted with the installation crypto key and can only be replaced, never revealed.</span></div>
        </section>
      </div>
    </main>
  );
}
