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
import { NoProject, PageHeader } from "../components/layout";
import { Button, Card, CardHeader, DataTable, EmptyState, Input, Label, Select, Skeleton } from "../components/ui";
import { useApp } from "../context";
import { api, patch } from "../lib/api";
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

  if (!projectId) return <NoProject />;

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
