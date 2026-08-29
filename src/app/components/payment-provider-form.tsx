import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  BillingPlanCatalogueInputSchema,
  type BillingPlanDefinitionInput,
  type PaymentEnvironment,
  type PaymentProvider,
  type PaymentProviderAccountInput,
  type PaymentProviderCatalogueUpdate,
  type PaymentProviderCredentialInput,
} from "../../shared/contracts";
import { DEFAULT_BILLING_PLANS, MAX_BILLING_PLANS } from "../../shared/billing-plans";
import {
  formatCurrencyMinorInput,
  normalizeCurrencyCode,
  parseCurrencyAmountToMinor,
} from "../../shared/currency";
import {
  IMPLEMENTED_PAYMENT_PROVIDERS,
  PAYMENT_PROVIDER_LABELS,
  PLANNED_PAYMENT_PROVIDERS,
} from "../../shared/payment-providers";
import {
  TRACKING_SOURCES,
  TRACKING_SOURCE_LABELS,
  type TrackingSource,
} from "../../shared/tracking-sources";
import { formText } from "../lib/utils";
import { Button, Input, Label, Select } from "./ui";

const ENVIRONMENT_OPTIONS = [
  { value: "test", label: "Test / sandbox" },
  { value: "live", label: "Live / production" },
];

const PROVIDER_OPTIONS = [
  ...IMPLEMENTED_PAYMENT_PROVIDERS.map((provider) => ({
    value: provider,
    label: PAYMENT_PROVIDER_LABELS[provider],
  })),
  ...PLANNED_PAYMENT_PROVIDERS.map((provider) => ({
    value: provider.id,
    label: `${provider.label} — Coming soon`,
    disabled: true,
  })),
];

export interface PaymentProviderCatalogueDefaults {
  currency?: string | null;
  plans: Array<BillingPlanDefinitionInput & {
    externalReference?: string | null;
    amountMinor?: number | null;
  }>;
}

interface EditablePlan extends BillingPlanDefinitionInput {
  externalReference: string;
  amount: string;
}

const GETBELKI_TEMPLATE_AMOUNTS: Record<string, number> = {
  starter: 1_000,
  studio: 2_900,
  agency: 14_900,
};

function templateAmount(planId: string, index: number, currency: string): string {
  const amountMinor = GETBELKI_TEMPLATE_AMOUNTS[planId] ?? ((index + 1) * 1_000);
  return formatCurrencyMinorInput(amountMinor, currency);
}

function editablePlans(
  definitions: readonly BillingPlanDefinitionInput[] | undefined,
  defaults: PaymentProviderCatalogueDefaults | undefined,
  currency: string,
): EditablePlan[] {
  const source = (defaults?.plans ?? definitions ?? DEFAULT_BILLING_PLANS) as readonly (
    BillingPlanDefinitionInput & {
      externalReference?: string | null;
      amountMinor?: number | null;
    }
  )[];
  return [...source]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    .map((plan, index) => {
      const externalReference = plan.externalReference;
      const amountMinor = plan.amountMinor;
      return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      sortOrder: index,
      featured: plan.featured,
      monthlyUnits: plan.monthlyUnits,
      projectLimit: plan.projectLimit,
      promptLimit: plan.promptLimit,
      sourceLimit: plan.sourceLimit,
      allowedSources: [...plan.allowedSources],
      externalReference: externalReference ?? "",
      amount: amountMinor === null || amountMinor === undefined
        ? templateAmount(plan.id, index, currency)
        : formatCurrencyMinorInput(amountMinor, currency),
      };
    });
}

function normalizedPlanDefinitions(plans: EditablePlan[]): BillingPlanDefinitionInput[] {
  return BillingPlanCatalogueInputSchema.parse(plans.map((plan, index) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    sortOrder: index,
    featured: plan.featured,
    monthlyUnits: plan.monthlyUnits,
    projectLimit: plan.projectLimit,
    promptLimit: plan.promptLimit,
    sourceLimit: plan.sourceLimit,
    allowedSources: plan.allowedSources,
  })));
}

function providerCatalogue(plans: EditablePlan[], currency: string) {
  return plans.map((plan) => ({
    planId: plan.id,
    externalReference: plan.externalReference.trim(),
    amountMinor: parseCurrencyAmountToMinor(plan.amount, currency),
  }));
}

function CurrencyField({ currency, planCount, onChange }: {
  currency: string;
  planCount: number;
  onChange: (currency: string) => void;
}) {
  return (
    <div className="provider-form-field">
      <Label hint={`One ISO 4217 currency is used by all ${planCount} monthly plan${planCount === 1 ? "" : "s"} in this account`}>Billing currency</Label>
      <Input
        aria-label="Billing currency"
        autoComplete="off"
        maxLength={3}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        pattern="[A-Za-z]{3}"
        placeholder="USD"
        required
        value={currency}
      />
    </div>
  );
}

function PlanCatalogueEditor({
  provider,
  currency,
  plans,
  definitionsLocked,
  onChange,
}: {
  provider: PaymentProvider;
  currency: string;
  plans: EditablePlan[];
  definitionsLocked: boolean;
  onChange: (plans: EditablePlan[]) => void;
}) {
  const externalNoun = provider === "stripe" ? "Price ID" : "Product ID";
  const externalPlaceholder = provider === "stripe" ? "price_…" : "pdt_…";
  const update = <Key extends keyof EditablePlan>(index: number, key: Key, value: EditablePlan[Key]) => {
    onChange(plans.map((plan, planIndex) => planIndex === index ? { ...plan, [key]: value } : plan));
  };
  const addPlan = () => {
    let suffix = plans.length + 1;
    while (plans.some((plan) => plan.id === `plan_${suffix}`)) suffix += 1;
    onChange([...plans, {
      id: `plan_${suffix}`,
      name: `Plan ${suffix}`,
      description: "",
      sortOrder: plans.length,
      featured: false,
      monthlyUnits: 10_000,
      projectLimit: 1,
      promptLimit: 25,
      sourceLimit: 1,
      allowedSources: ["chatgpt"],
      externalReference: "",
      amount: templateAmount(`plan_${suffix}`, plans.length, currency),
    }]);
  };
  const removePlan = (index: number) => {
    if (plans.length === 1) return;
    onChange(plans.filter((_, planIndex) => planIndex !== index)
      .map((plan, planIndex) => ({ ...plan, sortOrder: planIndex })));
  };
  const movePlan = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= plans.length) return;
    const next = [...plans];
    const currentPlan = next[index];
    const targetPlan = next[target];
    if (!currentPlan || !targetPlan) return;
    next[index] = targetPlan;
    next[target] = currentPlan;
    onChange(next.map((plan, planIndex) => ({ ...plan, sortOrder: planIndex })));
  };
  const toggleSource = (index: number, source: TrackingSource, checked: boolean) => {
    const plan = plans[index];
    if (!plan) return;
    const allowedSources = checked
      ? [...new Set([...plan.allowedSources, source])]
      : plan.allowedSources.filter((candidate) => candidate !== source);
    update(index, "allowedSources", allowedSources);
  };
  const setFeatured = (index: number, featured: boolean) => {
    onChange(plans.map((plan, planIndex) => ({
      ...plan,
      featured: featured ? planIndex === index : planIndex === index ? false : plan.featured,
    })));
  };

  return (
    <div className="payment-plan-editor">
      <div className="payment-plan-editor-heading">
        <div>
          <strong>Subscription plans</strong>
          <span>{definitionsLocked ? "Plan definitions are shared by every payment account. Map this provider to the existing catalogue." : "This is an editable starting template. Define the plans this installation will sell."}</span>
        </div>
        {!definitionsLocked ? (
          <Button disabled={plans.length >= MAX_BILLING_PLANS} onClick={addPlan} type="button" variant="secondary">
            <Plus size={14} /> Add plan
          </Button>
        ) : null}
      </div>
      {plans.map((plan, index) => (
        <section className="payment-plan-card" key={`${plan.id}-${index}`}>
          <div className="payment-plan-card-heading">
            <div><span>Plan {index + 1}</span><strong>{plan.name || "Unnamed plan"}</strong></div>
            {!definitionsLocked ? (
              <div className="payment-plan-order-actions">
                <Button aria-label={`Move ${plan.name} up`} disabled={index === 0} onClick={() => movePlan(index, -1)} type="button" variant="ghost"><ArrowUp size={14} /></Button>
                <Button aria-label={`Move ${plan.name} down`} disabled={index === plans.length - 1} onClick={() => movePlan(index, 1)} type="button" variant="ghost"><ArrowDown size={14} /></Button>
                <Button aria-label={`Remove ${plan.name}`} disabled={plans.length === 1} onClick={() => removePlan(index)} type="button" variant="ghost"><Trash2 size={14} /></Button>
              </div>
            ) : null}
          </div>

          <div className="payment-plan-definition-grid">
            <div className="provider-form-field">
              <Label hint="Stable internal ID; it is not shown to customers">Plan ID</Label>
              <Input aria-label={`Plan ${index + 1} ID`} disabled={definitionsLocked} onChange={(event) => update(index, "id", event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,99}" required value={plan.id} />
            </div>
            <div className="provider-form-field">
              <Label>Display name</Label>
              <Input aria-label={`Plan ${index + 1} display name`} disabled={definitionsLocked} maxLength={80} onChange={(event) => update(index, "name", event.target.value)} required value={plan.name} />
            </div>
            <div className="provider-form-field payment-plan-wide-field">
              <Label>Description</Label>
              <Input aria-label={`${plan.name} description`} disabled={definitionsLocked} maxLength={240} onChange={(event) => update(index, "description", event.target.value)} value={plan.description} />
            </div>
            <div className="provider-form-field">
              <Label>Monthly usage units</Label>
              <Input aria-label={`${plan.name} monthly usage units`} disabled={definitionsLocked} min={1} onChange={(event) => update(index, "monthlyUnits", Number(event.target.value))} required type="number" value={plan.monthlyUnits} />
            </div>
            <div className="provider-form-field">
              <Label>Project limit</Label>
              <Input aria-label={`${plan.name} project limit`} disabled={definitionsLocked} min={1} onChange={(event) => update(index, "projectLimit", Number(event.target.value))} required type="number" value={plan.projectLimit} />
            </div>
            <div className="provider-form-field">
              <Label>Prompt limit</Label>
              <Input aria-label={`${plan.name} prompt limit`} disabled={definitionsLocked} min={1} onChange={(event) => update(index, "promptLimit", Number(event.target.value))} required type="number" value={plan.promptLimit} />
            </div>
            <div className="provider-form-field">
              <Label>Enabled-source limit</Label>
              <Input aria-label={`${plan.name} source limit`} disabled={definitionsLocked} max={TRACKING_SOURCES.length} min={1} onChange={(event) => update(index, "sourceLimit", Number(event.target.value))} required type="number" value={plan.sourceLimit} />
            </div>
          </div>

          <fieldset className="payment-plan-sources" disabled={definitionsLocked}>
            <legend>Sources available to this plan</legend>
            {TRACKING_SOURCES.map((source) => (
              <label key={source}>
                <input checked={plan.allowedSources.includes(source)} onChange={(event) => toggleSource(index, source, event.target.checked)} type="checkbox" />
                <span>{TRACKING_SOURCE_LABELS[source]}</span>
              </label>
            ))}
          </fieldset>
          <label className="payment-plan-featured">
            <input checked={plan.featured} disabled={definitionsLocked} onChange={(event) => setFeatured(index, event.target.checked)} type="checkbox" />
            <span>Feature this plan in the pricing UI</span>
          </label>

          <div className="payment-plan-provider-mapping">
            <div className="provider-form-field">
              <Label>{externalNoun}</Label>
              <Input aria-label={`${plan.name} monthly ${externalNoun}`} onChange={(event) => update(index, "externalReference", event.target.value)} placeholder={`${plan.name} ${externalPlaceholder}`} required value={plan.externalReference} />
            </div>
            <div className="provider-form-field">
              <Label>Monthly amount ({currency})</Label>
              <Input aria-label={`${plan.name} monthly amount in ${currency}`} inputMode="decimal" onChange={(event) => update(index, "amount", event.target.value)} pattern="[0-9]+([.][0-9]+)?" placeholder={`Amount in ${currency}`} required value={plan.amount} />
            </div>
          </div>
        </section>
      ))}
      <small>Belki supports 1–{MAX_BILLING_PLANS} plans. Every active plan must have one verified mapping in each configured payment account.</small>
    </div>
  );
}

export function PaymentProviderAccountForm({
  pending,
  error,
  webhookEndpointKey,
  webhookUrl,
  initialPlans,
  plansLocked = false,
  onSubmit,
}: {
  pending: boolean;
  error?: string;
  webhookEndpointKey: string;
  webhookUrl: string;
  initialPlans?: BillingPlanDefinitionInput[];
  plansLocked?: boolean;
  onSubmit: (input: PaymentProviderAccountInput) => void;
}) {
  const [provider, setProvider] = useState<PaymentProvider>("stripe");
  const [environment, setEnvironment] = useState<PaymentEnvironment>("test");
  const [currency, setCurrency] = useState("EUR");
  const [plans, setPlans] = useState(() => editablePlans(initialPlans, undefined, "EUR"));
  const [validationError, setValidationError] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const normalizedCurrency = normalizeCurrencyCode(currency);
      const planDefinitions = normalizedPlanDefinitions(plans);
      const mappings = providerCatalogue(plans, normalizedCurrency);
      setValidationError(null);
      if (provider === "stripe") {
        onSubmit({
          provider,
          label: formText(data, "label"),
          environment,
          webhookEndpointKey,
          credentials: {
            secretKey: formText(data, "secretKey"),
            webhookSecret: formText(data, "webhookSecret"),
          },
          currency: normalizedCurrency,
          plans: planDefinitions,
          catalogue: mappings,
          configuration: {
            billingPortalConfigurationId: formText(data, "billingPortalConfigurationId"),
          },
        });
        return;
      }
      onSubmit({
        provider,
        label: formText(data, "label"),
        environment,
        webhookEndpointKey,
        credentials: {
          apiKey: formText(data, "apiKey"),
          webhookSecret: formText(data, "webhookSecret"),
        },
        currency: normalizedCurrency,
        plans: planDefinitions,
        catalogue: mappings,
        configuration: {},
      });
    } catch (submitError) {
      setValidationError(submitError instanceof Error ? submitError.message : "Invalid plan catalogue.");
    }
  };
  const providerLabel = PAYMENT_PROVIDER_LABELS[provider];
  const selectProvider = (value: string) => {
    setProvider(value as PaymentProvider);
    setPlans((current) => current.map((plan) => ({ ...plan, externalReference: "" })));
  };
  return (
    <form className="provider-form" onSubmit={submit}>
      <div className="provider-form-field">
        <Label>Payment provider</Label>
        <Select ariaLabel="Payment provider" onValueChange={selectProvider} options={PROVIDER_OPTIONS} value={provider} />
      </div>
      <div className="provider-form-field">
        <Label>Account label</Label>
        <Input key={provider} name="label" placeholder={`${providerLabel} ${environment} account`} required />
      </div>
      <div className="provider-form-field">
        <Label>Environment</Label>
        <Select ariaLabel="Payment environment" onValueChange={(value) => setEnvironment(value as PaymentEnvironment)} options={ENVIRONMENT_OPTIONS} value={environment} />
      </div>
      {provider === "stripe" ? (
        <div className="provider-form-field"><Label>Stripe secret key</Label><Input autoComplete="new-password" name="secretKey" placeholder={environment === "live" ? "sk_live_…" : "sk_test_…"} required type="password" /></div>
      ) : (
        <div className="provider-form-field"><Label>Dodo Payments API key</Label><Input autoComplete="new-password" name="apiKey" placeholder="API key" required type="password" /></div>
      )}
      <div className="provider-form-field"><Label>Webhook signing secret</Label><Input autoComplete="new-password" name="webhookSecret" placeholder="whsec_…" required type="password" /></div>
      <div className="provider-form-field">
        <Label hint={`Create the webhook in ${providerLabel}, then paste its signing secret above`}>Webhook endpoint URL</Label>
        <div className="payment-webhook-field"><Input aria-label="Payment webhook endpoint URL" readOnly value={webhookUrl} /><Button onClick={() => void navigator.clipboard.writeText(webhookUrl)} type="button" variant="secondary">Copy</Button></div>
      </div>
      <CurrencyField currency={currency} onChange={setCurrency} planCount={plans.length} />
      <PlanCatalogueEditor currency={currency} definitionsLocked={plansLocked} onChange={setPlans} plans={plans} provider={provider} />
      {provider === "stripe" ? (
        <div className="provider-form-field"><Label>Billing action portal configuration ID</Label><Input name="billingPortalConfigurationId" placeholder="bpc_…" required /></div>
      ) : null}
      {validationError || error ? <p className="form-error">{validationError ?? error}</p> : null}
      <Button disabled={pending}>{pending ? "Verifying configuration…" : "Verify and save"}</Button>
      <small className="provider-secret-note">Belki verifies {providerLabel} before encrypting the credentials. Saved secrets are never displayed again.</small>
    </form>
  );
}

export function PaymentProviderCredentialForm({
  provider,
  pending,
  error,
  onSubmit,
}: {
  provider: PaymentProvider;
  pending: boolean;
  error?: string;
  onSubmit: (input: PaymentProviderCredentialInput) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (provider === "stripe") {
      onSubmit({ provider, credentials: { secretKey: formText(data, "secretKey"), webhookSecret: formText(data, "webhookSecret") } });
      return;
    }
    onSubmit({ provider, credentials: { apiKey: formText(data, "apiKey"), webhookSecret: formText(data, "webhookSecret") } });
  };
  return (
    <form className="provider-form" onSubmit={submit}>
      {provider === "stripe" ? (
        <div className="provider-form-field"><Label>Stripe secret key</Label><Input autoComplete="new-password" name="secretKey" required type="password" /></div>
      ) : (
        <div className="provider-form-field"><Label>Dodo Payments API key</Label><Input autoComplete="new-password" name="apiKey" required type="password" /></div>
      )}
      <div className="provider-form-field"><Label>Webhook signing secret</Label><Input autoComplete="new-password" name="webhookSecret" required type="password" /></div>
      {error ? <p className="form-error">{error}</p> : null}
      <Button disabled={pending}>{pending ? "Verifying…" : "Replace credentials"}</Button>
    </form>
  );
}

export function PaymentProviderCatalogueForm({
  provider,
  pending,
  error,
  defaults,
  onSubmit,
}: {
  provider: PaymentProvider;
  pending: boolean;
  error?: string;
  defaults: PaymentProviderCatalogueDefaults;
  onSubmit: (input: PaymentProviderCatalogueUpdate) => void;
}) {
  const initialCurrency = defaults.currency ?? "EUR";
  const [currency, setCurrency] = useState(initialCurrency);
  const [plans, setPlans] = useState(() => editablePlans(undefined, defaults, initialCurrency));
  const [validationError, setValidationError] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const normalizedCurrency = normalizeCurrencyCode(currency);
      const planDefinitions = normalizedPlanDefinitions(plans);
      const mappings = providerCatalogue(plans, normalizedCurrency);
      setValidationError(null);
      if (provider === "stripe") {
        onSubmit({
          provider,
          currency: normalizedCurrency,
          plans: planDefinitions,
          catalogue: mappings,
          configuration: { billingPortalConfigurationId: formText(data, "billingPortalConfigurationId") },
        });
        return;
      }
      onSubmit({ provider, currency: normalizedCurrency, plans: planDefinitions, catalogue: mappings, configuration: {} });
    } catch (submitError) {
      setValidationError(submitError instanceof Error ? submitError.message : "Invalid plan catalogue.");
    }
  };
  return (
    <form className="provider-form" onSubmit={submit}>
      <CurrencyField currency={currency} onChange={setCurrency} planCount={plans.length} />
      <PlanCatalogueEditor currency={currency} definitionsLocked onChange={setPlans} plans={plans} provider={provider} />
      {provider === "stripe" ? (
        <div className="provider-form-field"><Label>Billing action portal configuration ID</Label><Input name="billingPortalConfigurationId" placeholder="bpc_…" required /></div>
      ) : null}
      {validationError || error ? <p className="form-error">{validationError ?? error}</p> : null}
      <Button disabled={pending}>{pending ? "Verifying…" : "Verify and replace catalogue"}</Button>
    </form>
  );
}
