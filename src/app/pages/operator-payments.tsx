import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Copy,
  CreditCard,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  Star,
} from "lucide-react";
import { useState } from "react";
import type {
  BillingPlanDefinitionInput,
  PaymentProvider,
  PaymentProviderAccountInput,
  PaymentProviderCatalogueUpdate,
  PaymentProviderCredentialInput,
} from "../../shared/contracts";
import {
  PAYMENT_PROVIDER_DASHBOARD_URLS,
  PAYMENT_PROVIDER_LABELS,
} from "../../shared/payment-providers";
import { OperatorDataFailure } from "../components/operator-access";
import {
  PaymentProviderAccountForm,
  PaymentProviderCatalogueForm,
  PaymentProviderCredentialForm,
  type PaymentProviderCatalogueDefaults,
} from "../components/payment-provider-form";
import { PageHeader } from "../components/layout";
import { Badge, Button, Card, Dialog, Skeleton } from "../components/ui";
import { api, patch, post } from "../lib/api";
import { formatCurrencyMinorAmount } from "../../shared/currency";

interface PaymentAccount {
  id: string;
  provider: PaymentProvider;
  providerLabel: string;
  label: string;
  environment: "test" | "live";
  status: "active" | "disabled";
  credentialSource: "environment" | "database";
  credentialConfigured: boolean;
  credentialVersion: number | null;
  isDefault: boolean;
  adapterVersion: string;
  webhookPath: string;
  catalogue: Array<{
    planId: string;
    planName: string;
    externalReference: string | null;
    currency: string | null;
    amountMinor: number | null;
    configured: boolean;
  }>;
  activeSubscriptions: number;
  lastTestStatus: "passed" | "failed" | null;
  lastTestedAt: string | null;
  lastTestMessage: string | null;
}

interface PaymentConfiguration {
  mode: "undecided" | "self_hosted" | "managed";
  deploymentMode: "self_hosted" | "managed";
  required: boolean;
  enabled: boolean;
  runtimeKillSwitch: boolean;
  defaultProviderAccountId: string | null;
  legacyImportAvailable: boolean;
  providers: Array<{
    id: PaymentProvider;
    label: string;
    version: string | null;
    implemented: boolean;
  }>;
  plans: BillingPlanDefinitionInput[];
  accounts: PaymentAccount[];
}

function catalogueDefaults(
  account: PaymentAccount,
  definitions: BillingPlanDefinitionInput[],
): PaymentProviderCatalogueDefaults {
  return {
    currency: account.catalogue.find((plan) => plan.currency)?.currency ?? "EUR",
    plans: definitions.map((definition) => {
      const mapping = account.catalogue.find((plan) => plan.planId === definition.id);
      return {
        ...definition,
        externalReference: mapping?.externalReference ?? null,
        amountMinor: mapping?.amountMinor ?? null,
      };
    }),
  };
}

function cataloguePlanLabel(plan: PaymentAccount["catalogue"][number]): string {
  if (!plan.externalReference) return `${plan.planName}: missing`;
  if (!plan.currency || plan.amountMinor === null) {
    return `${plan.planName}: ${plan.externalReference}`;
  }
  try {
    return `${plan.planName}: ${plan.externalReference} (${formatCurrencyMinorAmount(plan.amountMinor, plan.currency)}/month)`;
  } catch {
    return `${plan.planName}: ${plan.externalReference} (${plan.amountMinor} ${plan.currency} minor units/month)`;
  }
}

export default function OperatorPaymentsPage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [newWebhookEndpointKey, setNewWebhookEndpointKey] = useState(() => crypto.randomUUID());
  const [rotating, setRotating] = useState<PaymentAccount | null>(null);
  const [catalogue, setCatalogue] = useState<PaymentAccount | null>(null);
  const configuration = useQuery({
    queryKey: ["operator-payment-providers"],
    queryFn: () => api<PaymentConfiguration>("/operator/payment-providers"),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["operator-payment-providers"] }),
      queryClient.invalidateQueries({ queryKey: ["status"] }),
      queryClient.invalidateQueries({ queryKey: ["managed-billing-summary"] }),
    ]);
  };
  const createAccount = useMutation({
    mutationFn: (input: PaymentProviderAccountInput) => post("/operator/payment-providers", input),
    onSuccess: async () => { setAddOpen(false); await refresh(); },
  });
  const importLegacy = useMutation({
    mutationFn: () => post("/operator/payment-providers/import-stripe"),
    onSuccess: refresh,
  });
  const replaceCredentials = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PaymentProviderCredentialInput }) =>
      api(`/operator/payment-providers/${encodeURIComponent(id)}/credentials`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: async () => { setRotating(null); await refresh(); },
  });
  const replaceCatalogue = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PaymentProviderCatalogueUpdate }) =>
      api(`/operator/payment-providers/${encodeURIComponent(id)}/catalogue`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: async () => { setCatalogue(null); await refresh(); },
  });
  const testAccount = useMutation({
    mutationFn: (id: string) => post(`/operator/payment-providers/${encodeURIComponent(id)}/test`),
    onSuccess: refresh,
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => post(`/operator/payment-providers/${encodeURIComponent(id)}/default`),
    onSuccess: refresh,
  });
  const updateAccount = useMutation({
    mutationFn: ({ id, status }: { id: string; status: PaymentAccount["status"] }) =>
      patch(`/operator/payment-providers/${encodeURIComponent(id)}`, { status }),
    onSuccess: refresh,
  });

  if (configuration.error) {
    return <OperatorDataFailure error={configuration.error} onRetry={() => void configuration.refetch()} />;
  }
  const accounts = configuration.data?.accounts ?? [];
  const unavailable = configuration.data?.providers.filter((provider) => !provider.implemented) ?? [];
  const openAddAccount = () => {
    setNewWebhookEndpointKey(crypto.randomUUID());
    setAddOpen(true);
  };
  return (
    <div className="page operator-page provider-operator-page page-flow">
      <PageHeader
        title="Payments"
        description="Configure the installation payment provider, encrypted credentials, plan catalogue, and webhook endpoint."
        action={<Button disabled={configuration.isPending} onClick={openAddAccount}><Plus size={16} /> Add payment account</Button>}
      />

      {configuration.data?.mode === "self_hosted" ? (
        <div className="billing-warning" role="status">
          <CreditCard size={17} />
          <div><strong>Self-hosted / in-house mode</strong><span>Payments and customer Checkout are off. Add a payment account, or activate one below, whenever you want to move this installation to managed subscriptions.</span></div>
        </div>
      ) : null}

      {configuration.data?.mode === "managed" && configuration.data.deploymentMode !== "managed" ? (
        <div className="billing-warning" role="status">
          <CreditCard size={17} />
          <div><strong>Managed billing is selected, but the deployment profile is self-hosted</strong><span>Set DEPLOYMENT_MODE to managed and apply the managed security controls before accepting customer signups.</span></div>
        </div>
      ) : null}

      {!configuration.data?.runtimeKillSwitch && configuration.data?.mode === "managed" ? (
        <div className="billing-warning" role="status">
          <CreditCard size={17} />
          <div><strong>Managed payments are disabled by the deployment kill switch</strong><span>The saved account remains available, but new Checkout sessions will not start until PAYMENT_MODE is enabled.</span></div>
        </div>
      ) : null}

      {configuration.data?.legacyImportAvailable ? (
        <div className="payment-import-card">
          <KeyRound size={20} />
          <div><strong>Move the current Stripe bindings into the encrypted vault</strong><span>The Worker values are read internally, verified, and never returned to the browser.</span></div>
          <Button disabled={importLegacy.isPending} onClick={() => importLegacy.mutate()}>{importLegacy.isPending ? "Importing…" : "Import Worker configuration"}</Button>
        </div>
      ) : null}
      {importLegacy.isError ? <p className="form-error">{importLegacy.error.message}</p> : null}

      <section className="operator-section">
        <div className="operator-section-heading"><h2>Payment accounts</h2><p>The default account is used during initial Checkout. Existing subscriptions retain their recorded account.</p></div>
        {configuration.isPending ? <Skeleton className="settings-feature-skeleton" /> : (
          <div className="provider-account-grid">
            {accounts.map((account) => {
              const webhookUrl = `${window.location.origin}${account.webhookPath}`;
              return (
                <Card className="provider-account-card" key={account.id}>
                  <div className="provider-account-heading">
                    <div className="provider-account-identity"><CreditCard size={22} /><div><span>{account.providerLabel} · {account.environment}</span><h3>{account.label}</h3></div></div>
                    <div className="provider-account-badges">
                      {account.isDefault && configuration.data?.mode === "managed" ? <Badge tone="info">Installation default</Badge> : null}
                      <Badge tone={account.status === "active" && account.credentialConfigured ? "success" : "warning"}>{account.status === "disabled" ? "Disabled" : account.credentialConfigured ? "Ready" : "Needs setup"}</Badge>
                      <Badge tone={account.environment === "live" ? "warning" : "neutral"}>{account.environment === "live" ? "Live" : "Test"}</Badge>
                    </div>
                  </div>
                  <div className="provider-account-activity">
                    <div><strong>{account.activeSubscriptions}</strong><span>Subscriptions</span></div>
                    <div><strong>{account.catalogue.filter((plan) => plan.configured).length}/{account.catalogue.length}</strong><span>Plans mapped</span></div>
                    <div><strong>{account.credentialVersion ?? "env"}</strong><span>Credential version</span></div>
                    <div><strong>{account.lastTestStatus === "passed" ? "OK" : account.lastTestStatus === "failed" ? "Failed" : "—"}</strong><span>Last test</span></div>
                  </div>
                  <div className="provider-account-meta">
                    <span><KeyRound size={14} /> {account.credentialSource === "environment" ? "Worker bindings" : `Encrypted version ${account.credentialVersion}`}</span>
                    <span><CheckCircle2 size={14} /> {account.lastTestMessage ?? "Not tested from Operator"}</span>
                    <span><CreditCard size={14} /> {account.catalogue.map(cataloguePlanLabel).join(" · ")}</span>
                    <span><Copy size={14} /> <button className="payment-webhook-copy" onClick={() => void navigator.clipboard.writeText(webhookUrl)} type="button">Copy webhook URL</button></span>
                  </div>
                  <div className="provider-account-actions">
                    {!account.isDefault || configuration.data?.mode !== "managed" ? <Button disabled={!account.credentialConfigured || account.lastTestStatus !== "passed" || account.status !== "active" || makeDefault.isPending} onClick={() => makeDefault.mutate(account.id)} variant="secondary"><Star size={14} /> {configuration.data?.mode === "self_hosted" ? "Enable managed billing" : "Use for new Checkouts"}</Button> : null}
                    <Button asChild variant="secondary"><a href={PAYMENT_PROVIDER_DASHBOARD_URLS[account.provider]} rel="noreferrer" target="_blank">Provider dashboard <ExternalLink size={13} /></a></Button>
                    <Button disabled={!account.credentialConfigured || testAccount.isPending} onClick={() => testAccount.mutate(account.id)} variant="ghost"><RefreshCw size={14} /> Test</Button>
                    <Button disabled={account.credentialSource === "environment"} onClick={() => setRotating(account)} variant="ghost"><KeyRound size={14} /> Credentials</Button>
                    <Button disabled={account.credentialSource === "environment"} onClick={() => setCatalogue(account)} variant="ghost">Plan catalogue</Button>
                    <Button disabled={account.isDefault || updateAccount.isPending} onClick={() => updateAccount.mutate({ id: account.id, status: account.status === "active" ? "disabled" : "active" })} variant="ghost">{account.status === "active" ? "Disable" : "Enable"}</Button>
                  </div>
                  {makeDefault.isError ? <p className="form-error">{makeDefault.error.message}</p> : null}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {unavailable.length ? (
        <section className="operator-section">
          <div className="operator-section-heading"><h2>Available adapters</h2><p>These providers fit the modular contract but cannot be selected until their adapter is installed and verified.</p></div>
          <div className="provider-account-grid">
            {unavailable.map((provider) => <Card className="provider-account-card" key={provider.id}><div className="provider-account-heading"><div className="provider-account-identity"><CreditCard size={22} /><div><span>Payment adapter</span><h3>{PAYMENT_PROVIDER_LABELS[provider.id]}</h3></div></div><Badge tone="neutral">Not installed</Badge></div></Card>)}
          </div>
        </section>
      ) : null}

      <Dialog contentClassName="provider-dialog" description="Create the webhook with the URL below, then Belki verifies the full account before saving encrypted credentials." onOpenChange={setAddOpen} open={addOpen} title="Add payment account">
        <PaymentProviderAccountForm
          error={createAccount.error?.message}
          initialPlans={configuration.data?.plans}
          onSubmit={(input) => createAccount.mutate(input)}
          pending={createAccount.isPending}
          plansLocked={accounts.length > 0}
          webhookEndpointKey={newWebhookEndpointKey}
          webhookUrl={`${window.location.origin}/api/webhooks/payments/${encodeURIComponent(newWebhookEndpointKey)}`}
        />
      </Dialog>
      <Dialog contentClassName="provider-dialog" description="Existing secrets cannot be viewed. Enter the complete replacement set." onOpenChange={(open) => !open && setRotating(null)} open={Boolean(rotating)} title={rotating ? `Replace credentials for ${rotating.label}` : "Replace credentials"}>
        {rotating ? <PaymentProviderCredentialForm error={replaceCredentials.error?.message} onSubmit={(input) => replaceCredentials.mutate({ id: rotating.id, input })} pending={replaceCredentials.isPending} provider={rotating.provider} /> : null}
      </Dialog>
      <Dialog contentClassName="provider-dialog" description="Every active plan mapping is verified against the provider before activation." onOpenChange={(open) => !open && setCatalogue(null)} open={Boolean(catalogue)} title={catalogue ? `Plan catalogue for ${catalogue.label}` : "Plan catalogue"}>
        {catalogue ? <PaymentProviderCatalogueForm defaults={catalogueDefaults(catalogue, configuration.data?.plans ?? [])} error={replaceCatalogue.error?.message} onSubmit={(input) => replaceCatalogue.mutate({ id: catalogue.id, input })} pending={replaceCatalogue.isPending} provider={catalogue.provider} /> : null}
      </Dialog>
    </div>
  );
}
