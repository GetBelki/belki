import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarDays,
  CircleDollarSign,
  Gauge,
  ReceiptText,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEffect, useState } from "react";
import { NoProject, PageHeader } from "../components/layout";
import { Button, Card, CardHeader, DataTable, Dialog, EmptyState, Input, Label, Select, Skeleton } from "../components/ui";
import { useApp } from "../context";
import { ApiClientError, api, patch, post, remove } from "../lib/api";
import { formatProviderCost } from "../lib/snapshot-evidence";
import { compact } from "../lib/utils";

type BillingPeriod = "30d" | "month";

interface BillingReport {
  period: BillingPeriod;
  projectId: string | null;
  currency: "USD";
  range: { from: string; to: string };
  summary: {
    totalCost: number;
    chargedTasks: number;
    chargedRuns: number;
    averageCost: number;
    highestDailyCost: number;
    byCategory: {
      promptTracking: BillingCategory;
      productEnrichment: BillingCategory;
      entityExtraction: BillingCategory;
    };
  };
  series: Array<{
    date: string;
    totalCost: number;
    promptTrackingCost: number;
    productEnrichmentCost: number;
    entityExtractionCost: number;
    totalTasks: number;
    promptTrackingTasks: number;
    productEnrichmentTasks: number;
    entityExtractionTasks: number;
  }>;
  projectBreakdown: Array<{
    projectId: string;
    projectName: string;
    totalCost: number;
    chargedTasks: number;
    promptTrackingCost: number;
    productEnrichmentCost: number;
    entityExtractionCost: number;
  }>;
  projectAlerts: Array<{
    projectId: string;
    projectName: string;
    category: "productEnrichment" | "entityExtraction";
    monthToDateTasks: number;
    monthToDateCost: number;
    threshold: number;
    exceeded: boolean;
    estimated: boolean;
  }>;
}

interface BillingAlerts {
  productEnrichment: BillingAlert;
  entityExtraction: BillingAlert;
}

interface BillingAlert {
  threshold: number;
  monthToDateTasks: number;
  monthToDateCost: number;
  exceeded: boolean;
  estimated: boolean;
}

interface BillingCategory {
  chargedTasks: number;
  totalCost: number;
  averageCost: number;
  sharePercent: number;
}

interface ManagedBillingSummary {
  planKey: string;
  subscriptionStatus: string;
  paymentMode: "disabled" | "stripe_managed" | "stripe_direct";
  stripeEnvironment: "test" | "live" | null;
  configuredStripeEnvironment: "test" | "live" | null;
  planChangesEnabled: boolean;
  planChangeDisabledReason: string | null;
  cycleStartedAt: string;
  cycleEndsAt: string;
  cancelAtPeriodEnd: boolean;
  readOnlyUntil: string | null;
  currentProjectLimit: number;
  usage: {
    allowance: number;
    committed: number;
    reserved: number;
    remaining: number;
    projectCount: number;
    projectLimit: number;
  };
  pendingPlanChange: {
    id: string;
    kind: "upgrade" | "downgrade";
    status: string;
    fromPlanKey: ManagedPlanKey;
    toPlanKey: ManagedPlanKey;
    effectiveAt: string | null;
  } | null;
  plans: Array<{
    key: ManagedPlanKey;
    priceEur: number;
    monthlyUnits: number;
    projectLimit: number;
    changeKind: "checkout" | "current" | "upgrade" | "downgrade";
  }>;
}

type ManagedPlanKey = "starter" | "studio" | "agency";

function planLabel(plan: ManagedPlanKey): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function billingError(...errors: Array<unknown>): string | null {
  const error = errors.find(Boolean);
  if (!error) return null;
  return error instanceof ApiClientError ? error.message : "Billing could not be updated. Try again or contact support.";
}

function ManagedBillingPanel() {
  const { session } = useApp();
  const queryClient = useQueryClient();
  const [billingParams, setBillingParams] = useSearchParams();
  const [selectedPlan, setSelectedPlan] = useState<ManagedPlanKey | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const processing = billingParams.get("checkout") === "success" || billingParams.get("plan_change") === "processing" || billingParams.get("cancellation") === "processing";
  const summary = useQuery({
    queryKey: ["managed-billing-summary"],
    queryFn: () => api<ManagedBillingSummary>("/billing/summary"),
    refetchInterval: processing ? 2_000 : false,
  });
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

  useEffect(() => {
    const value = summary.data;
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
  }, [billingParams, processing, setBillingParams, summary.data]);

  if (summary.isPending) return <Skeleton className="billing-chart-skeleton" />;
  if (!summary.data) return null;
  const value = summary.data;
  const managed = value.paymentMode !== "disabled";
  const owner = session.user.role === "owner";
  const activeSubscription = value.subscriptionStatus !== "pending" && value.subscriptionStatus !== "cancelled";
  const changeableSubscription = value.subscriptionStatus === "active";
  const selected = value.plans.find((plan) => plan.key === selectedPlan) ?? null;
  const error = billingError(
    checkout.error,
    portal.error,
    changePlan.error,
    cancelPlanChange.error,
    cancelSubscription.error,
    reactivate.error,
  );
  return (
    <Card className="billing-chart-card">
      <CardHeader
        title={managed ? "Belki subscription" : "Self-hosted allowance"}
        description={`${compact(value.usage.committed)} committed + ${compact(value.usage.reserved)} reserved of ${compact(value.usage.allowance)} units this cycle`}
        action={managed && value.subscriptionStatus !== "pending" && owner
          ? <Button variant="secondary" disabled={portal.isPending} onClick={() => portal.mutate()}>Manage subscription</Button>
          : undefined}
      />
      <div className="billing-summary-grid">
        <BillingMetric label="Remaining units" value={compact(value.usage.remaining)} detail={`Resets ${new Date(value.cycleEndsAt).toLocaleDateString()}`} icon={<Gauge size={18}/>} />
        <BillingMetric label="Projects" value={`${value.usage.projectCount} / ${value.usage.projectLimit}`} detail="Seats are unlimited" icon={<ReceiptText size={18}/>} />
      </div>
      {value.stripeEnvironment === "test" ? (
        <div className="billing-warning" role="status">
          <AlertTriangle size={17} />
          <div>
            <strong>Stripe sandbox</strong>
            <span>No real payment is being collected. This workspace cannot be reconciled with live Stripe credentials.</span>
          </div>
        </div>
      ) : null}
      {processing ? (
        <div className="billing-notice" role="status">
          Stripe confirmed your request. Belki is syncing the subscription now…
        </div>
      ) : null}
      {value.pendingPlanChange ? (
        <div className="billing-warning" role="status">
          <CalendarDays size={17} />
          <div>
            <strong>{planLabel(value.pendingPlanChange.toPlanKey)} is scheduled for {value.pendingPlanChange.effectiveAt ? new Date(value.pendingPlanChange.effectiveAt).toLocaleDateString() : "the next renewal"}</strong>
            <span>Your current allowance stays active until then. New projects are limited to the target plan while the downgrade is pending.</span>
          </div>
          {owner ? <Button variant="secondary" disabled={cancelPlanChange.isPending} onClick={() => cancelPlanChange.mutate()}>Keep current plan</Button> : null}
        </div>
      ) : null}
      {managed && owner && (value.subscriptionStatus === "pending" || changeableSubscription) ? (
        <div className="billing-breakdown-grid">
          {value.plans.map((plan) => (
            <Card className="billing-breakdown-card" key={plan.key}>
              <div><strong>{planLabel(plan.key)}</strong><span>{compact(plan.monthlyUnits)} units · {plan.projectLimit} projects · unlimited seats</span></div>
              <div>
                <strong>€{plan.priceEur}/month</strong>
                {value.subscriptionStatus === "pending" ? (
                  <Button disabled={checkout.isPending} onClick={() => checkout.mutate(plan.key)}>Choose</Button>
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
            </Card>
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
        title={selected?.changeKind === "upgrade" ? `Upgrade to ${selected ? planLabel(selected.key) : "plan"}` : `Schedule ${selected ? planLabel(selected.key) : "plan"}`}
        description={selected?.changeKind === "upgrade"
          ? "Stripe will show the exact prorated amount and ask you to confirm before charging it."
          : `The downgrade takes effect after the current billing period. You must have no more than ${selected?.projectLimit ?? 0} active projects.`}
      >
        {selected ? (
          <div className="form-stack">
            <div className="billing-change-summary">
              <strong>€{selected.priceEur}/month</strong>
              <span>{compact(selected.monthlyUnits)} units · {selected.projectLimit} projects</span>
              {value.pendingPlanChange ? <span>This replaces the pending change to {planLabel(value.pendingPlanChange.toPlanKey)}.</span> : null}
              {selected.changeKind === "downgrade" && value.usage.projectCount > selected.projectLimit ? (
                <p className="form-error">Delete {value.usage.projectCount - selected.projectLimit} active project{value.usage.projectCount - selected.projectLimit === 1 ? "" : "s"} before scheduling this downgrade.</p>
              ) : null}
            </div>
            <div className="dialog-actions">
              <Button onClick={() => setSelectedPlan(null)} type="button" variant="secondary">Back</Button>
              <Button
                disabled={changePlan.isPending || (selected.changeKind === "downgrade" && value.usage.projectCount > selected.projectLimit)}
                onClick={() => changePlan.mutate({ planKey: selected.key, replacePending: Boolean(value.pendingPlanChange) })}
                type="button"
              >{changePlan.isPending ? "Opening Stripe…" : selected.changeKind === "upgrade" ? "Review in Stripe" : "Schedule downgrade"}</Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel subscription"
        description={`Your plan remains active through ${new Date(value.cycleEndsAt).toLocaleDateString()}. Stripe will ask you to confirm.`}
      >
        <div className="form-stack">
          {value.pendingPlanChange ? <p className="billing-help">This also removes the scheduled change to {planLabel(value.pendingPlanChange.toPlanKey)}.</p> : null}
          <div className="dialog-actions">
            <Button onClick={() => setCancelOpen(false)} type="button" variant="secondary">Keep subscription</Button>
            <Button disabled={cancelSubscription.isPending} onClick={() => cancelSubscription.mutate(Boolean(value.pendingPlanChange))} type="button" variant="danger">Continue to Stripe</Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function axisCost(value: number): string {
  if (value === 0) return "$0";
  if (value >= 0.1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
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
  icon: React.ReactNode;
}) {
  return (
    <Card className="billing-metric">
      <span className="billing-metric-icon">{icon}</span>
      <span className="billing-metric-copy">
        <small>{label}</small>
        <strong>{value}</strong>
        <span>{detail}</span>
      </span>
    </Card>
  );
}

export default function BillingPage() {
  const { projectId, projects } = useApp();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPeriod = searchParams.get("period");
  const period: BillingPeriod = requestedPeriod === "month" ? "month" : "30d";
  const requestedProject = searchParams.get("project");
  const billingProjectId = projects.some((project) => project.id === requestedProject)
    ? requestedProject
    : null;
  const report = useQuery({
    queryKey: ["billing", billingProjectId ?? "all", period],
    queryFn: () =>
      api<BillingReport>(
        `/analytics/billing?period=${period}${billingProjectId ? `&projectId=${billingProjectId}` : ""}`,
      ),
    enabled: Boolean(projectId),
  });
  const billingAlerts = useQuery({
    queryKey: ["billing-alerts", billingProjectId],
    queryFn: () => api<BillingAlerts>(`/projects/${billingProjectId}/billing-alerts`),
    enabled: Boolean(billingProjectId),
  });
  const updateAlerts = useMutation({
    mutationFn: (body: {
      productEnrichmentWarningUsd?: number;
      entityExtractionWarningUsd?: number;
    }) => patch(`/projects/${billingProjectId}/billing-alerts`, body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["billing-alerts", billingProjectId] }),
        queryClient.invalidateQueries({ queryKey: ["billing"] }),
      ]);
    },
  });

  if (!projectId) return (
    <div className="page">
      <PageHeader title="Billing" description="Subscription, allowance, and provider usage." />
      <ManagedBillingPanel />
      <NoProject />
    </div>
  );

  const setPeriod = (value: BillingPeriod) => {
    const next = new URLSearchParams(searchParams);
    if (value === "30d") next.delete("period");
    else next.set("period", value);
    setSearchParams(next, { replace: true });
  };
  const setBillingProject = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("project");
    else next.set("project", value);
    setSearchParams(next, { replace: true });
  };
  const warningSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    updateAlerts.mutate({
      productEnrichmentWarningUsd: Number(data.get("productEnrichmentWarningUsd")),
      entityExtractionWarningUsd: Number(data.get("entityExtractionWarningUsd")),
    });
  };
  const periodLabel = period === "month" ? "Current month" : "Last 30 days";
  const summary = report.data?.summary;
  const selectedProjectName = projects.find((project) => project.id === billingProjectId)?.name;
  const exceededAlerts = report.data?.projectAlerts.filter((alert) => alert.exceeded) ?? [];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Provider usage"
        title="Billing"
        description={billingProjectId
          ? `Provider charges and estimated inference costs for ${selectedProjectName}.`
          : "Workspace costs across every project, separated by workload."}
        action={
          <div className="billing-header-controls">
            <Select
              ariaLabel="Billing project scope"
              value={billingProjectId ?? "all"}
              onValueChange={setBillingProject}
              options={[
                { value: "all", label: "All projects" },
                ...projects.map((project) => ({ value: project.id, label: project.name })),
              ]}
            />
            <div className="billing-period-toggle" aria-label="Billing period">
              <button aria-pressed={period === "30d"} className={period === "30d" ? "active" : undefined} onClick={() => setPeriod("30d")} type="button">Last 30 days</button>
              <button aria-pressed={period === "month"} className={period === "month" ? "active" : undefined} onClick={() => setPeriod("month")} type="button">Current month</button>
            </div>
          </div>
        }
      />

      <ManagedBillingPanel />

      {exceededAlerts.length ? (
        <div className="billing-warning" role="status">
          <AlertTriangle size={17} />
          <div>
            <strong>{exceededAlerts.length === 1 ? "A project cost warning was reached" : `${exceededAlerts.length} project cost warnings were reached`}</strong>
            <span>{exceededAlerts.map((alert) => `${alert.projectName} · ${alert.category === "productEnrichment" ? "Product enrichment" : "Entity extraction"}`).join(", ")}</span>
          </div>
        </div>
      ) : null}

      {report.isPending ? (
        <div className="billing-summary-grid">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton className="billing-metric-skeleton" key={index} />
          ))}
        </div>
      ) : (
        <div className="billing-summary-grid">
          <BillingMetric
            label="Total tracked cost"
            value={formatProviderCost(summary?.totalCost ?? 0)}
            detail={periodLabel}
            icon={<CircleDollarSign size={18} />}
          />
          <BillingMetric
            label="Charged tasks"
            value={compact(summary?.chargedTasks ?? 0)}
            detail="All provider and inference workloads"
            icon={<ReceiptText size={18} />}
          />
          <BillingMetric
            label="Average per task"
            value={formatProviderCost(summary?.averageCost ?? 0)}
            detail="Across provider tasks and AI calls"
            icon={<Gauge size={18} />}
          />
          <BillingMetric
            label="Highest daily cost"
            value={formatProviderCost(summary?.highestDailyCost ?? 0)}
            detail="Peak spend within this period"
            icon={<CalendarDays size={18} />}
          />
        </div>
      )}

      {summary ? (
        <div className="billing-breakdown-grid">
          <Card className="billing-breakdown-card">
            <span className="billing-category-swatch prompt" />
            <div>
              <strong>Prompt tracking</strong>
              <span>{compact(summary.byCategory.promptTracking.chargedTasks)} charged tasks</span>
            </div>
            <div>
              <strong>{formatProviderCost(summary.byCategory.promptTracking.totalCost)}</strong>
              <span>{summary.byCategory.promptTracking.sharePercent.toFixed(1)}% of total · {formatProviderCost(summary.byCategory.promptTracking.averageCost)} avg.</span>
            </div>
          </Card>
          <Card className="billing-breakdown-card">
            <span className="billing-category-swatch entities" />
            <div>
              <strong>Entity extraction <small className="estimated-label">Estimated</small></strong>
              <span>{compact(summary.byCategory.entityExtraction.chargedTasks)} inference calls</span>
            </div>
            <div>
              <strong>{formatProviderCost(summary.byCategory.entityExtraction.totalCost)}</strong>
              <span>{summary.byCategory.entityExtraction.sharePercent.toFixed(1)}% of total · {formatProviderCost(summary.byCategory.entityExtraction.averageCost)} avg.</span>
            </div>
          </Card>
          <Card className="billing-breakdown-card">
            <span className="billing-category-swatch enrichment" />
            <div>
              <strong>Product enrichment</strong>
              <span>{compact(summary.byCategory.productEnrichment.chargedTasks)} charged tasks</span>
            </div>
            <div>
              <strong>{formatProviderCost(summary.byCategory.productEnrichment.totalCost)}</strong>
              <span>{summary.byCategory.productEnrichment.sharePercent.toFixed(1)}% of total · {formatProviderCost(summary.byCategory.productEnrichment.averageCost)} avg.</span>
            </div>
          </Card>
        </div>
      ) : null}

      <Card className="billing-chart-card">
        <CardHeader
          title="Daily tracked cost"
          description={`${periodLabel} · provider charges plus estimated entity inference at list price`}
        />
        <div className="billing-chart">
          {report.isPending ? (
            <Skeleton className="billing-chart-skeleton" />
          ) : report.isError ? (
            <EmptyState
              title="Billing data could not be loaded"
              description="Refresh the page to try the report again."
            />
          ) : (summary?.chargedTasks ?? 0) === 0 ? (
            <EmptyState
              title="No tracked costs in this period"
              description="Costs will appear after a monitored prompt or enrichment task runs."
            />
          ) : (
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart
                data={report.data?.series ?? []}
                margin={{ top: 8, right: 8, bottom: 0, left: 4 }}
              >
                <CartesianGrid
                  stroke="#e4e4e7"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  axisLine={false}
                  dataKey="date"
                  interval="preserveStartEnd"
                  minTickGap={28}
                  tick={{ fill: "#71717a", fontSize: 11 }}
                  tickFormatter={shortDate}
                  tickLine={false}
                />
                <YAxis
                  axisLine={false}
                  tick={{ fill: "#71717a", fontSize: 11 }}
                  tickFormatter={axisCost}
                  tickLine={false}
                  width={62}
                />
                <Tooltip
                  contentStyle={{
                    border: "1px solid #d4d4d8",
                    borderRadius: 6,
                    boxShadow: "none",
                  }}
                  formatter={(value, name) => [
                    formatProviderCost(Number(value)),
                    String(name),
                  ]}
                  labelFormatter={(value) => {
                    const date =
                      typeof value === "string"
                        ? new Date(`${value}T00:00:00.000Z`)
                        : null;
                    return date && !Number.isNaN(date.getTime())
                      ? new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                      timeZone: "UTC",
                        }).format(date)
                      : "";
                  }}
                />
                <Bar
                  dataKey="promptTrackingCost"
                  fill="#18181b"
                  maxBarSize={30}
                  name="Prompt tracking"
                  stackId="provider-cost"
                  radius={[0, 0, 2, 2]}
                />
                <Bar
                  dataKey="productEnrichmentCost"
                  fill="#7c3aed"
                  maxBarSize={30}
                  name="Product enrichment"
                  stackId="provider-cost"
                  radius={[2, 2, 0, 0]}
                />
                <Bar
                  dataKey="entityExtractionCost"
                  fill="#0f766e"
                  maxBarSize={30}
                  name="Entity extraction (estimated)"
                  stackId="provider-cost"
                  radius={[2, 2, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      {!billingProjectId && report.data?.projectBreakdown.length ? (
        <Card className="billing-project-table">
          <CardHeader
            title="Cost by project"
            description="Workspace total separated by project and workload."
          />
          <DataTable
            columns={[
              { key: "project", label: "Project" },
              { key: "prompt", label: "Prompt tracking" },
              { key: "enrichment", label: "Product enrichment" },
              { key: "entities", label: "Entity extraction" },
              { key: "tasks", label: "Tasks" },
              { key: "total", label: "Total" },
            ]}
            rows={report.data.projectBreakdown.map((project) => ({
              id: project.projectId,
              project: <strong>{project.projectName}</strong>,
              prompt: formatProviderCost(project.promptTrackingCost),
              enrichment: formatProviderCost(project.productEnrichmentCost),
              entities: <span>{formatProviderCost(project.entityExtractionCost)} <small className="estimated-label">Estimated</small></span>,
              tasks: compact(project.chargedTasks),
              total: <strong>{formatProviderCost(project.totalCost)}</strong>,
            }))}
          />
        </Card>
      ) : null}

      {billingProjectId ? (
        <Card className="billing-alert-settings">
          <CardHeader
            title="Monthly cost warnings"
            description="Warnings are specific to this project and do not pause work."
          />
          {billingAlerts.isPending ? (
            <Skeleton className="billing-alert-skeleton" />
          ) : billingAlerts.data ? (
            <form key={billingProjectId} onSubmit={warningSubmit}>
              <div className="billing-alert-fields">
                <div>
                  <Label hint={`${formatProviderCost(billingAlerts.data.productEnrichment.monthToDateCost)} this month`}>
                    Product enrichment warning (USD)
                  </Label>
                  <Input
                    defaultValue={billingAlerts.data.productEnrichment.threshold}
                    min="0"
                    name="productEnrichmentWarningUsd"
                    step="0.01"
                    type="number"
                  />
                </div>
                <div>
                  <Label hint={`${formatProviderCost(billingAlerts.data.entityExtraction.monthToDateCost)} estimated this month`}>
                    Entity extraction warning (USD)
                  </Label>
                  <Input
                    defaultValue={billingAlerts.data.entityExtraction.threshold}
                    min="0"
                    name="entityExtractionWarningUsd"
                    step="0.01"
                    type="number"
                  />
                </div>
              </div>
              {updateAlerts.isError ? <p className="form-error">Warning levels could not be saved.</p> : null}
              <div className="billing-alert-actions">
                <span>Set a value to 0 to disable that warning.</span>
                <Button disabled={updateAlerts.isPending}>{updateAlerts.isPending ? "Saving…" : "Save warnings"}</Button>
              </div>
            </form>
          ) : <p className="muted">Warning settings could not be loaded.</p>}
        </Card>
      ) : null}
    </div>
  );
}
