import { useQuery } from "@tanstack/react-query";
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
import { Card, CardHeader, EmptyState, Skeleton } from "../components/ui";
import { useApp } from "../context";
import { api } from "../lib/api";
import { formatProviderCost } from "../lib/snapshot-evidence";
import { compact } from "../lib/utils";

type BillingPeriod = "30d" | "month";

interface BillingReport {
  period: BillingPeriod;
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
    };
  };
  series: Array<{
    date: string;
    totalCost: number;
    promptTrackingCost: number;
    productEnrichmentCost: number;
    totalTasks: number;
    promptTrackingTasks: number;
    productEnrichmentTasks: number;
  }>;
  enrichmentWarning: {
    workspaceMonthToDateTasks: number;
    workspaceMonthToDateCost: number;
    threshold: number;
    exceeded: boolean;
  };
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
  const { projectId } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPeriod = searchParams.get("period");
  const period: BillingPeriod = requestedPeriod === "month" ? "month" : "30d";
  const report = useQuery({
    queryKey: ["billing", projectId, period],
    queryFn: () =>
      api<BillingReport>(
        `/analytics/billing?projectId=${projectId}&period=${period}`,
      ),
    enabled: Boolean(projectId),
  });

  if (!projectId) return <NoProject />;

  const setPeriod = (value: BillingPeriod) => {
    setSearchParams(value === "30d" ? {} : { period: value }, { replace: true });
  };
  const periodLabel = period === "month" ? "Current month" : "Last 30 days";
  const summary = report.data?.summary;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Provider usage"
        title="Billing"
        description="Track provider charges across prompt monitoring and product enrichment."
        action={
          <div className="billing-period-toggle" aria-label="Billing period">
            <button
              aria-pressed={period === "30d"}
              className={period === "30d" ? "active" : undefined}
              onClick={() => setPeriod("30d")}
              type="button"
            >
              Last 30 days
            </button>
            <button
              aria-pressed={period === "month"}
              className={period === "month" ? "active" : undefined}
              onClick={() => setPeriod("month")}
              type="button"
            >
              Current month
            </button>
          </div>
        }
      />

      {report.data?.enrichmentWarning.exceeded ? (
        <div className="billing-warning" role="status">
          <AlertTriangle size={17} />
          <div>
            <strong>Product enrichment cost warning</strong>
            <span>
              Workspace enrichment spend is {formatProviderCost(report.data.enrichmentWarning.workspaceMonthToDateCost)} this month,
              above the {formatProviderCost(report.data.enrichmentWarning.threshold)} warning level.
            </span>
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
            label="Total provider cost"
            value={formatProviderCost(summary?.totalCost ?? 0)}
            detail={periodLabel}
            icon={<CircleDollarSign size={18} />}
          />
          <BillingMetric
            label="Charged tasks"
            value={compact(summary?.chargedTasks ?? 0)}
            detail="Prompt tracking and product enrichment"
            icon={<ReceiptText size={18} />}
          />
          <BillingMetric
            label="Average per run"
            value={formatProviderCost(summary?.averageCost ?? 0)}
            detail="Across charged runs"
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
          title="Daily provider cost"
          description={`${periodLabel} · stacked by provider workload`}
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
              title="No provider charges in this period"
              description="Charges will appear after a monitored prompt is submitted."
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
                    name === "Prompt tracking" ? "Prompt tracking" : "Product enrichment",
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
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>
    </div>
  );
}
