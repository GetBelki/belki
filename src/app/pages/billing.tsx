import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  Gauge,
  ReceiptText,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { TRACKING_SOURCE_LABELS, type TrackingSource } from "../../shared/tracking-sources";
import { formatCurrencyMinorAmount } from "../../shared/currency";
import { PageHeader } from "../components/layout";
import { Button, CardHeader, Dialog, EmptyState, Skeleton } from "../components/ui";
import { useApp } from "../context";
import { ApiClientError, api, post, remove } from "../lib/api";
import { onboardingDestination } from "../lib/onboarding-navigation";
import { compact } from "../lib/utils";

interface ManagedBillingSummary {
  planKey: string;
  subscriptionStatus: string;
  paymentMode: "disabled" | "stripe_managed" | "stripe_direct";
  paymentProvider: "stripe" | "dodo" | null;
  paymentProviderLabel: string | null;
  paymentProviderAccountLabel: string | null;
  paymentEnvironment: "test" | "live" | null;
  stripeEnvironment: "test" | "live" | null;
  configuredStripeEnvironment: "test" | "live" | null;
  planChangesEnabled: boolean;
  planChangeDisabledReason: string | null;
  cycleStartedAt: string;
  cycleEndsAt: string;
  cancelAtPeriodEnd: boolean;
  readOnlyUntil: string | null;
  currentProjectLimit: number;
  currentPromptLimit: number;
  currentSourceLimit: number;
  availableTrackingSources: TrackingSource[];
  usage: {
    allowance: number;
    committed: number;
    reserved: number;
    remaining: number;
    projectCount: number;
    projectLimit: number;
    promptCount: number;
    promptLimit: number;
    sourceLimit: number;
  };
  pendingPlanChange: {
    id: string;
    kind: "upgrade" | "downgrade";
    status: string;
    fromPlanKey: ManagedPlanKey;
    toPlanKey: ManagedPlanKey;
    effectiveAt: string | null;
    transition: PlanTransitionPreview | null;
  } | null;
  plans: Array<{
    key: ManagedPlanKey;
    name: string;
    description: string;
    featured: boolean;
    currency: string | null;
    amountMinor: number | null;
    monthlyUnits: number;
    projectLimit: number;
    promptLimit: number;
    sourceLimit: number;
    allowedSources: TrackingSource[];
    changeKind: "checkout" | "current" | "upgrade" | "downgrade";
  }>;
}
interface PlanTransitionPreview {
  targetPlanKey: ManagedPlanKey;
  effectiveAt: string;
  archivedProjects: Array<{ id: string; name: string }>;
  pausedPromptCount: number;
  sourceChanges: Array<{
    projectId: string;
    projectName: string;
    current: TrackingSource[];
    next: TrackingSource[];
  }>;
}

type ManagedPlanKey = string;

function planPrice(plan: ManagedBillingSummary["plans"][number]): string {
  if (!plan.currency || plan.amountMinor === null) return "Price unavailable";
  try {
    return formatCurrencyMinorAmount(plan.amountMinor, plan.currency);
  } catch {
    return `${plan.amountMinor} ${plan.currency} minor units`;
  }
}

function billingError(...errors: Array<unknown>): string | null {
  const error = errors.find(Boolean);
  if (!error) return null;
  return error instanceof ApiClientError ? error.message : "Billing could not be updated. Try again or contact support.";
}

function ManagedBillingPanel({
  summary,
  summaryPending,
}: {
  summary: ManagedBillingSummary | undefined;
  summaryPending: boolean;
}) {
  const { session } = useApp();
  const queryClient = useQueryClient();
  const [billingParams, setBillingParams] = useSearchParams();
  const [selectedPlan, setSelectedPlan] = useState<ManagedPlanKey | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const processing = billingParams.get("checkout") === "success" || billingParams.get("plan_change") === "processing" || billingParams.get("cancellation") === "processing";
  const checkout = useMutation({
    mutationFn: (planKey: ManagedPlanKey) =>
      post<{ url: string }>("/billing/checkout", { planKey }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const portal = useMutation({
    mutationFn: () => post<{ url: string }>("/billing/management-session"),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const changePlan = useMutation({
    mutationFn: ({ planKey, replacePending }: { planKey: ManagedPlanKey; replacePending: boolean }) =>
      post<{ action: "redirect" | "scheduled"; url?: string }>("/billing/plan-change", { planKey, replacePending }),
    onSuccess: async (result) => {
      if (result.action === "redirect" && result.url) {
        window.location.assign(result.url);
        return;
      }
      setSelectedPlan(null);
      await queryClient.invalidateQueries({ queryKey: ["managed-billing-summary"] });
    },
  });
  const cancelPlanChange = useMutation({
    mutationFn: () => remove<{ cancelled: boolean }>("/billing/plan-change"),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["managed-billing-summary"] }),
  });
  const cancelSubscription = useMutation({
    mutationFn: (replacePending: boolean) => post<{ url: string }>("/billing/cancellation-session", { replacePending }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const reactivate = useMutation({
    mutationFn: () => post<{ reactivated: boolean }>("/billing/reactivate"),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["managed-billing-summary"] }),
  });
  const selectedChangeKind = summary?.plans.find((plan) => plan.key === selectedPlan)?.changeKind;
  const downgradePreview = useQuery({
    queryKey: ["billing-plan-change-preview", selectedPlan],
    queryFn: () => api<PlanTransitionPreview>(`/billing/plan-change-preview?planKey=${encodeURIComponent(selectedPlan as string)}`),
    enabled: Boolean(selectedPlan && selectedChangeKind === "downgrade"),
  });

  useEffect(() => {
    const value = summary;
    if (!value || !processing) return;
    const expectedPlan = billingParams.get("expected_plan");
    const planFinished = billingParams.get("plan_change") === "processing" && expectedPlan === value.planKey;
    const cancellationFinished = billingParams.get("cancellation") === "processing" && value.cancelAtPeriodEnd;
    const checkoutFinished = billingParams.get("checkout") === "success" && value.subscriptionStatus !== "pending";
    if (!planFinished && !cancellationFinished && !checkoutFinished) return;
    const next = new URLSearchParams(billingParams);
    next.delete("plan_change");
    next.delete("expected_plan");
    next.delete("cancellation");
    next.delete("checkout");
    setBillingParams(next, { replace: true });
    if (checkoutFinished) {
      void queryClient.invalidateQueries({ queryKey: ["session"] }).then(() => {
        window.location.assign(onboardingDestination(value.usage.projectCount));
      });
    }
  }, [billingParams, processing, queryClient, setBillingParams, summary]);

  if (summaryPending) return <Skeleton className="billing-chart-skeleton" />;
  if (!summary) return null;
  const value = summary;
  const managed = value.paymentMode !== "disabled";
  const owner = session.user.role === "owner";
  const activeSubscription = value.subscriptionStatus !== "pending" && value.subscriptionStatus !== "cancelled";
  const changeableSubscription = value.subscriptionStatus === "active";
  const selected = value.plans.find((plan) => plan.key === selectedPlan) ?? null;
  const pendingPlanName = value.pendingPlanChange
    ? value.plans.find((plan) => plan.key === value.pendingPlanChange?.toPlanKey)?.name
      ?? value.pendingPlanChange.toPlanKey
    : null;
  const error = billingError(
    checkout.error,
    portal.error,
    changePlan.error,
    cancelPlanChange.error,
    cancelSubscription.error,
    reactivate.error,
  );
  const pendingPayment = value.subscriptionStatus === "pending";
  const providerLabel = value.paymentProviderLabel ?? "payment provider";
  return (
    <section className={pendingPayment
      ? "pricing-shell"
      : managed ? "subscription-panel" : "subscription-panel billing-limits-panel"}>
      {pendingPayment ? (
        <div className="pricing-intro">
          <span className="eyebrow">Choose your plan</span>
          <h1>Start measuring your AI visibility.</h1>
          <p>Every plan includes visibility reports, source evidence, and unlimited teammates. Choose how many prompts and sources you need.</p>
        </div>
      ) : null}
      {!pendingPayment ? <CardHeader
        title={managed ? "Belki subscription" : "Self-hosted limits"}
        description={`${value.usage.promptCount} of ${value.usage.promptLimit} active prompts`}
        action={managed && value.subscriptionStatus !== "pending" && owner
          ? <Button variant="secondary" disabled={portal.isPending} onClick={() => portal.mutate()}>Manage subscription</Button>
          : undefined}
      /> : null}
      {!pendingPayment ? <div className="billing-summary-grid subscription-summary-grid">
        <BillingMetric label="Active prompts" value={`${compact(value.usage.promptCount)} / ${compact(value.usage.promptLimit)}`} detail={`${value.usage.promptLimit.toLocaleString()} prompt limit`} icon={<Gauge size={18}/>} />
        <BillingMetric label="Projects" value={`${compact(value.usage.projectCount)} / ${compact(value.usage.projectLimit)}`} detail={`${value.usage.projectLimit.toLocaleString()} project limit · unlimited seats`} icon={<ReceiptText size={18}/>} />
      </div> : null}
      {value.paymentEnvironment === "test" ? (
        <div className="billing-warning" role="status">
          <AlertTriangle size={17} />
          <div>
            <strong>{providerLabel} sandbox</strong>
            <span>No real payment is being collected. This workspace cannot be reconciled with live provider credentials.</span>
          </div>
        </div>
      ) : null}
      {processing ? (
        <div className="billing-notice" role="status">
          {providerLabel} confirmed your request. Belki is syncing the subscription now…
        </div>
      ) : null}
      {value.pendingPlanChange ? (
        <div className="billing-warning" role="status">
          <CalendarDays size={17} />
          <div>
            <strong>{pendingPlanName} is scheduled for {value.pendingPlanChange.effectiveAt ? new Date(value.pendingPlanChange.effectiveAt).toLocaleDateString() : "the next renewal"}</strong>
            <span>
              Your current plan stays active until then.
              {value.pendingPlanChange.transition?.archivedProjects.length
                ? ` ${value.pendingPlanChange.transition.archivedProjects.length} excess project${value.pendingPlanChange.transition.archivedProjects.length === 1 ? " will" : "s will"} be archived.`
                : " No projects will be archived."}
              {value.pendingPlanChange.transition?.pausedPromptCount
                ? ` ${value.pendingPlanChange.transition.pausedPromptCount} prompt${value.pendingPlanChange.transition.pausedPromptCount === 1 ? " will" : "s will"} be paused.`
                : ""}
            </span>
            {value.pendingPlanChange.transition?.archivedProjects.length ? (
              <span>Projects to archive: {value.pendingPlanChange.transition.archivedProjects.map((project) => project.name).join(", ")}.</span>
            ) : null}
            {value.pendingPlanChange.transition?.sourceChanges.map((change) => (
              <span key={change.projectId}>
                {change.projectName}: keep {change.next.map((source) => TRACKING_SOURCE_LABELS[source]).join(" and ")}.
              </span>
            ))}
          </div>
          {owner ? <Button variant="secondary" disabled={cancelPlanChange.isPending} onClick={() => cancelPlanChange.mutate()}>Keep current plan</Button> : null}
        </div>
      ) : null}
      {managed && owner && (value.subscriptionStatus === "pending" || changeableSubscription) ? (
        <div className={pendingPayment ? "pricing-grid" : "plan-comparison-grid"}>
          {value.plans.map((plan) => (
            <article className={`pricing-card${plan.featured ? " pricing-card-featured" : ""}`} key={plan.key}>
              {plan.featured ? <span className="pricing-popular">Featured</span> : null}
              <div className="pricing-card-heading">
                <strong>{plan.name}</strong>
                {plan.description ? <small>{plan.description}</small> : null}
                <span><b>{planPrice(plan)}</b> / month</span>
              </div>
              <ul>
                <li><Check size={15} /> Track up to {plan.promptLimit} prompts</li>
                <li><Check size={15} /> {plan.projectLimit} {plan.projectLimit === 1 ? "project" : "projects"}</li>
                <li><Check size={15} /> Choose {plan.sourceLimit} of {plan.allowedSources.map((source) => TRACKING_SOURCE_LABELS[source]).join(", ")}</li>
                <li><Check size={15} /> Unlimited teammates</li>
              </ul>
              <div className="pricing-card-action">
                {value.subscriptionStatus === "pending" ? (
                  <Button disabled={checkout.isPending} onClick={() => checkout.mutate(plan.key)}>Choose {plan.name}</Button>
                ) : plan.changeKind === "current" ? (
                  <Button disabled>Current</Button>
                ) : (
                  <Button
                    disabled={!value.planChangesEnabled || changePlan.isPending || (value.pendingPlanChange?.toPlanKey === plan.key)}
                    onClick={() => setSelectedPlan(plan.key)}
                    variant={plan.changeKind === "downgrade" ? "secondary" : "default"}
                  >
                    {value.pendingPlanChange?.toPlanKey === plan.key ? "Scheduled" : plan.changeKind === "upgrade" ? "Upgrade" : "Downgrade"}
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {managed && activeSubscription && owner ? (
        <div className="billing-subscription-actions">
          {value.cancelAtPeriodEnd ? (
            <><span>Your subscription will end on {new Date(value.cycleEndsAt).toLocaleDateString()}.</span><Button disabled={reactivate.isPending} onClick={() => reactivate.mutate()} variant="secondary">Reactivate</Button></>
          ) : (
            <Button disabled={cancelSubscription.isPending} onClick={() => setCancelOpen(true)} variant="ghost">Cancel subscription</Button>
          )}
        </div>
      ) : null}
      {!value.planChangesEnabled && value.planChangeDisabledReason && managed ? <p className="billing-help">Plan changes are unavailable: {value.planChangeDisabledReason}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      <Dialog
        open={Boolean(selectedPlan)}
        onOpenChange={(open) => { if (!open) setSelectedPlan(null); }}
        title={selected?.changeKind === "upgrade" ? `Upgrade to ${selected?.name ?? "plan"}` : `Schedule ${selected?.name ?? "plan"}`}
        description={selected?.changeKind === "upgrade"
          ? `${providerLabel} will show the exact prorated amount and ask you to confirm before charging it.`
          : "The downgrade takes effect at renewal. Belki preserves all history, archives excess projects, pauses excess prompts, and keeps the sources supported by the new plan."}
      >
        {selected ? (
          <div className="form-stack">
            <div className="billing-change-summary">
              <strong>{planPrice(selected)}/month</strong>
              <span>{selected.promptLimit} prompts · {selected.projectLimit} projects · {selected.sourceLimit} source{selected.sourceLimit === 1 ? "" : "s"} per project</span>
              {value.pendingPlanChange ? <span>This replaces the pending change to {pendingPlanName}.</span> : null}
              {selected.changeKind === "downgrade" ? (
                downgradePreview.isPending ? <span>Calculating the exact renewal changes…</span>
                  : downgradePreview.data ? <>
                    <span>
                      {downgradePreview.data.archivedProjects.length
                        ? `Projects to archive: ${downgradePreview.data.archivedProjects.map((project) => project.name).join(", ")}.`
                        : "No projects will be archived."}
                    </span>
                    <span>
                      {downgradePreview.data.pausedPromptCount
                        ? `${downgradePreview.data.pausedPromptCount} prompt${downgradePreview.data.pausedPromptCount === 1 ? "" : "s"} will be paused.`
                        : "No prompts will be paused."}
                    </span>
                    {downgradePreview.data.sourceChanges.map((change) => (
                      <span key={change.projectId}>
                        {change.projectName} will keep {change.next.map((source) => TRACKING_SOURCE_LABELS[source]).join(" and ")}.
                      </span>
                    ))}
                    <span>Nothing is deleted. You can restore archived projects and reactivate prompts after upgrading.</span>
                  </> : <span>The renewal changes could not be calculated. Close this dialog and try again.</span>
              ) : null}
            </div>
            <div className="dialog-actions">
              <Button onClick={() => setSelectedPlan(null)} type="button" variant="secondary">Back</Button>
              <Button
                disabled={changePlan.isPending || (selected.changeKind === "downgrade" && !downgradePreview.data)}
                onClick={() => changePlan.mutate({ planKey: selected.key, replacePending: Boolean(value.pendingPlanChange) })}
                type="button"
              >{changePlan.isPending ? `Opening ${providerLabel}…` : selected.changeKind === "upgrade" ? `Review in ${providerLabel}` : "Schedule downgrade"}</Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel subscription"
        description={`Your plan remains active through ${new Date(value.cycleEndsAt).toLocaleDateString()}. ${providerLabel} will ask you to confirm.`}
      >
        <div className="form-stack">
          {value.pendingPlanChange ? <p className="billing-help">This also removes the scheduled change to {pendingPlanName}.</p> : null}
          <div className="dialog-actions">
            <Button onClick={() => setCancelOpen(false)} type="button" variant="secondary">Keep subscription</Button>
            <Button disabled={cancelSubscription.isPending} onClick={() => cancelSubscription.mutate(Boolean(value.pendingPlanChange))} type="button" variant="danger">Continue to {providerLabel}</Button>
          </div>
        </div>
      </Dialog>
      {pendingPayment ? <p className="pricing-footnote">Secure checkout by {providerLabel}. Cancel any time at the end of your billing period.</p> : null}
    </section>
  );
}

function BillingMetric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="billing-metric" title={`${label}: ${value}`}>
      {icon ? <span className="billing-metric-icon">{icon}</span> : null}
      <span className="billing-metric-copy">
        <small>{label}</small>
        <strong>{value}</strong>
        <span>{detail}</span>
      </span>
    </div>
  );
}

export default function BillingPage() {
  const [searchParams] = useSearchParams();
  const processing = searchParams.get("checkout") === "success"
    || searchParams.get("plan_change") === "processing"
    || searchParams.get("cancellation") === "processing";
  const subscription = useQuery({
    queryKey: ["managed-billing-summary"],
    queryFn: () => api<ManagedBillingSummary>("/billing/summary"),
    refetchInterval: processing ? 2_000 : false,
  });

  if (subscription.isPending) {
    return (
      <div className="page billing-page">
        <Skeleton className="billing-page-skeleton" />
      </div>
    );
  }

  if (subscription.isError || !subscription.data) {
    return (
      <div className="page billing-page page-flow">
        <PageHeader
          title="Billing"
          description="Subscription and Belki workspace limits."
        />
        <EmptyState
          title="Billing could not be loaded"
          description="Refresh the page to try again. Your subscription and usage data have not been changed."
          action={<Button onClick={() => void subscription.refetch()} variant="secondary">Try again</Button>}
        />
      </div>
    );
  }

  if (subscription.data.subscriptionStatus === "pending") {
    return (
      <div className="page billing-page pricing-page">
        <ManagedBillingPanel
          summary={subscription.data}
          summaryPending={subscription.isPending}
        />
      </div>
    );
  }

  const managed = subscription.data.paymentMode !== "disabled";
  return (
    <div className="page billing-page page-flow">
      <PageHeader
        title="Billing"
        description={managed
          ? "Manage your Belki plan, workspace limits, and subscription changes."
          : "Review Belki's limits for this self-hosted workspace. Provider plans, credits, and invoices stay in each provider dashboard."}
      />
      <ManagedBillingPanel
        summary={subscription.data}
        summaryPending={subscription.isPending}
      />
    </div>
  );
}
