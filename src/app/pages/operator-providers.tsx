import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  Route,
  Star,
} from "lucide-react";
import { useState } from "react";
import type {
  CaptureProvider,
  CaptureProviderAccountInput,
  CaptureProviderCredentialInput,
  TrackingSource,
} from "../../shared/contracts";
import {
  CAPTURE_PROVIDER_DASHBOARD_URLS,
  CAPTURE_PROVIDER_LABELS,
} from "../../shared/capture-providers";
import { TRACKING_SOURCE_LABELS } from "../../shared/tracking-sources";
import { PageHeader } from "../components/layout";
import { OperatorDataFailure } from "../components/operator-access";
import { ProviderIcon } from "../components/provider-icon";
import {
  ProviderAccountForm,
  ProviderCredentialForm,
} from "../components/provider-account-form";
import { Badge, Button, Card, Dialog, Select, Skeleton, Switch } from "../components/ui";
import { api, patch, post } from "../lib/api";

interface ProviderAccount {
  id: string;
  provider: CaptureProvider;
  providerLabel: string;
  label: string;
  status: "active" | "disabled";
  credentialSource: "environment" | "database";
  credentialConfigured: boolean;
  credentialVersion: number | null;
  isDefault: boolean;
  priority: number;
  supportedSources: TrackingSource[];
  adapterVersion: string;
  lastTestStatus: "passed" | "failed" | null;
  lastTestedAt: string | null;
  lastTestMessage: string | null;
}

interface ProviderRoute {
  trackingSource: TrackingSource;
  enabled: boolean;
  providerAccountId: string | null;
  effectiveProviderAccountId: string | null;
}

interface ProviderConfiguration {
  accounts: ProviderAccount[];
  routes: ProviderRoute[];
  activity: ProviderActivity;
}

interface ProviderActivityMetrics {
  attempts: number;
  submitted: number;
  completed: number;
  failed: number;
  ambiguous: number;
  needsAttention: number;
  inProgress: number;
  successRate: number;
  averageLatencyMs: number | null;
  lastActivityAt: string | null;
}

interface ProviderActivity {
  period: "30d";
  range: { from: string; to: string };
  summary: ProviderActivityMetrics;
  byAccount: Array<ProviderActivityMetrics & {
    providerAccountId: string;
    provider: CaptureProvider;
  }>;
  byPlatform: Array<ProviderActivityMetrics & {
    trackingSource: TrackingSource;
  }>;
}

const DEFAULT_ROUTE = "__default__";

const EMPTY_ACTIVITY: ProviderActivityMetrics = {
  attempts: 0,
  submitted: 0,
  completed: 0,
  failed: 0,
  ambiguous: 0,
  needsAttention: 0,
  inProgress: 0,
  successRate: 0,
  averageLatencyMs: null,
  lastActivityAt: null,
};

function latencyLabel(value: number | null): string {
  if (value === null) return "No completed requests";
  if (value < 1_000) return `${value} ms average`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s average`;
  return `${(value / 60_000).toFixed(1)} min average`;
}

function successRateLabel(activity: ProviderActivityMetrics): string {
  return activity.completed + activity.needsAttention > 0
    ? `${activity.successRate.toFixed(1)}%`
    : "—";
}

function lastActivityLabel(value: string | null): string {
  if (!value) return "No activity in the last 30 days";
  return `Last activity ${new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))}`;
}

export default function OperatorProvidersPage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [rotating, setRotating] = useState<ProviderAccount | null>(null);
  const configuration = useQuery({
    queryKey: ["operator-providers"],
    queryFn: () => api<ProviderConfiguration>("/operator/providers"),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["operator-providers"] }),
      queryClient.invalidateQueries({ queryKey: ["status"] }),
    ]);
  };
  const createAccount = useMutation({
    mutationFn: (input: CaptureProviderAccountInput) => post("/operator/providers", input),
    onSuccess: async () => {
      setAddOpen(false);
      await refresh();
    },
  });
  const replaceCredentials = useMutation({
    mutationFn: ({ id, input }: { id: string; input: CaptureProviderCredentialInput }) =>
      api(`/operator/providers/${encodeURIComponent(id)}/credentials`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      setRotating(null);
      await refresh();
    },
  });
  const testAccount = useMutation({
    mutationFn: (id: string) => post(`/operator/providers/${encodeURIComponent(id)}/test`),
    onSuccess: refresh,
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => post(`/operator/providers/${encodeURIComponent(id)}/default`),
    onSuccess: refresh,
  });
  const updateAccount = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ProviderAccount["status"] }) =>
      patch(`/operator/providers/${encodeURIComponent(id)}`, { status }),
    onSuccess: refresh,
  });
  const updateRoute = useMutation({
    mutationFn: ({ source, input }: {
      source: TrackingSource;
      input: { enabled?: boolean; providerAccountId?: string | null };
    }) => patch(`/operator/platforms/${source}`, input),
    onSuccess: refresh,
  });

  if (configuration.error) {
    return <OperatorDataFailure error={configuration.error} onRetry={() => void configuration.refetch()} />;
  }
  const accounts = configuration.data?.accounts ?? [];
  const routes = configuration.data?.routes ?? [];
  const activity = configuration.data?.activity;
  const activitySummary = activity?.summary ?? EMPTY_ACTIVITY;
  const activeAccounts = accounts.filter((account) => account.status === "active" && account.credentialConfigured);
  return (
    <div className="page operator-page provider-operator-page page-flow">
      <PageHeader
        title="AI data providers"
        description="Manage installation-owned credentials, choose the default provider, and select a provider for each AI platform."
        action={<Button onClick={() => setAddOpen(true)}><Plus size={16} /> Add provider</Button>}
      />
      <div className="provider-summary-strip" aria-label="Provider activity in the last 30 days">
        <div><strong>{activitySummary.submitted}</strong><span>Submitted · 30 days</span></div>
        <div><strong>{activitySummary.completed}</strong><span>Completed</span></div>
        <div><strong>{activitySummary.needsAttention}</strong><span>Needs attention</span></div>
        <div><strong>{successRateLabel(activitySummary)}</strong><span>Settled success rate</span></div>
      </div>

      <section className="operator-section">
        <div className="operator-section-heading">
          <h2>Accounts</h2>
          <p>Credentials are encrypted at rest. Activity covers the last 30 days; needs attention combines failed and uncertain attempts.</p>
        </div>
        {configuration.isPending ? <Skeleton className="settings-feature-skeleton" /> : (
          <div className="provider-account-grid">
            {accounts.map((account) => {
              const accountActivity = activity?.byAccount.find(
                (item) => item.providerAccountId === account.id,
              ) ?? EMPTY_ACTIVITY;
              return <Card className="provider-account-card" key={account.id}>
                <div className="provider-account-heading">
                  <div className="provider-account-identity">
                    <ProviderIcon provider={account.provider} size={22} />
                    <div>
                      <span>{CAPTURE_PROVIDER_LABELS[account.provider]}</span>
                      <h3>{account.label}</h3>
                    </div>
                  </div>
                  <div className="provider-account-badges">
                    {account.isDefault ? <Badge tone="info">Default</Badge> : null}
                    <Badge tone={account.status === "active" && account.credentialConfigured ? "success" : "warning"}>
                      {account.status === "disabled" ? "Disabled" : account.credentialConfigured ? "Active" : "Needs credentials"}
                    </Badge>
                  </div>
                </div>
                <div className="provider-account-activity" aria-label={`${account.label} activity in the last 30 days`}>
                  <div><strong>{accountActivity.submitted}</strong><span>Submitted</span></div>
                  <div><strong>{accountActivity.completed}</strong><span>Completed</span></div>
                  <div><strong>{accountActivity.needsAttention}</strong><span>Needs attention</span></div>
                  <div><strong>{accountActivity.inProgress}</strong><span>In progress</span></div>
                </div>
                <div className="provider-account-performance">
                  <span>{successRateLabel(accountActivity)} success after settlement</span>
                  <span>{latencyLabel(accountActivity.averageLatencyMs)}</span>
                  <span>{lastActivityLabel(accountActivity.lastActivityAt)}</span>
                </div>
                <div className="provider-account-meta">
                  <span><KeyRound size={14} /> {account.credentialSource === "environment" ? "Worker secret" : `Encrypted version ${account.credentialVersion ?? "—"}`}</span>
                  <span><Route size={14} /> {account.supportedSources.map((source) => TRACKING_SOURCE_LABELS[source]).join(", ")}</span>
                  <span className={account.lastTestStatus === "failed" ? "provider-test-failed" : undefined}>
                    <CheckCircle2 size={14} /> {account.lastTestMessage ?? "Not tested from the dashboard"}
                  </span>
                </div>
                <div className="provider-account-actions">
                  {!account.isDefault ? <Button disabled={!account.credentialConfigured || account.status !== "active" || makeDefault.isPending} onClick={() => makeDefault.mutate(account.id)} variant="secondary"><Star size={14} /> Make default</Button> : null}
                  <Button asChild variant="secondary"><a href={CAPTURE_PROVIDER_DASHBOARD_URLS[account.provider]} rel="noreferrer" target="_blank">Provider dashboard <ExternalLink size={13} /></a></Button>
                  <Button disabled={testAccount.isPending || !account.credentialConfigured} onClick={() => testAccount.mutate(account.id)} variant="ghost"><RefreshCw size={14} /> Test</Button>
                  <Button onClick={() => setRotating(account)} variant="ghost"><KeyRound size={14} /> Replace credentials</Button>
                  <Button disabled={account.isDefault || updateAccount.isPending} onClick={() => updateAccount.mutate({ id: account.id, status: account.status === "active" ? "disabled" : "active" })} variant="ghost">
                    {account.status === "active" ? "Disable" : "Enable"}
                  </Button>
                </div>
              </Card>;
            })}
          </div>
        )}
      </section>

      <section className="operator-section">
        <div className="operator-section-heading">
          <h2>AI platforms</h2>
          <p>Choose which provider captures answers from each AI platform.</p>
        </div>
        <div className="provider-route-list">
          {routes.map((route) => {
            const effective = accounts.find((account) => account.id === route.effectiveProviderAccountId);
            const compatible = activeAccounts.filter((account) => account.supportedSources.includes(route.trackingSource));
            const platformActivity = activity?.byPlatform.find(
              (item) => item.trackingSource === route.trackingSource,
            ) ?? EMPTY_ACTIVITY;
            return (
              <div className="provider-route-row" key={route.trackingSource}>
                <Switch
                  ariaLabel={`${route.enabled ? "Disable" : "Enable"} ${TRACKING_SOURCE_LABELS[route.trackingSource]}`}
                  checked={route.enabled}
                  disabled={updateRoute.isPending}
                  onCheckedChange={(enabled) => updateRoute.mutate({ source: route.trackingSource, input: { enabled } })}
                />
                <div className="provider-route-name">
                  <strong>{TRACKING_SOURCE_LABELS[route.trackingSource]}</strong>
                  <span>{route.enabled ? `Using: ${effective?.label ?? "No configured provider"}` : "Disabled"}</span>
                  <small>{platformActivity.completed} completed · {platformActivity.needsAttention} need attention · {platformActivity.inProgress} in progress</small>
                </div>
                <Select
                  ariaLabel={`${TRACKING_SOURCE_LABELS[route.trackingSource]} provider`}
                  onValueChange={(value) => updateRoute.mutate({
                    source: route.trackingSource,
                    input: { providerAccountId: value === DEFAULT_ROUTE ? null : value },
                  })}
                  options={[
                    {
                      value: DEFAULT_ROUTE,
                      label: "Use installation default",
                      icon: effective ? <ProviderIcon provider={effective.provider} /> : undefined,
                    },
                    ...compatible.map((account) => ({
                      value: account.id,
                      label: `${account.label} · ${account.providerLabel}`,
                      icon: <ProviderIcon provider={account.provider} />,
                    })),
                  ]}
                  value={route.providerAccountId ?? DEFAULT_ROUTE}
                />
              </div>
            );
          })}
        </div>
        {updateRoute.isError ? <p className="form-error">{updateRoute.error.message}</p> : null}
      </section>

      <Dialog
        contentClassName="provider-dialog"
        description="Belki verifies the credentials before encrypting and storing the account."
        onOpenChange={setAddOpen}
        open={addOpen}
        title="Add capture provider"
      >
        <ProviderAccountForm
          error={createAccount.error?.message}
          onSubmit={(input) => createAccount.mutate(input)}
          pending={createAccount.isPending}
          submitLabel="Verify and add"
        />
      </Dialog>
      <Dialog
        contentClassName="provider-dialog"
        description={rotating ? `Enter a new ${CAPTURE_PROVIDER_LABELS[rotating.provider]} credential set. Existing values cannot be viewed.` : undefined}
        onOpenChange={(open) => !open && setRotating(null)}
        open={Boolean(rotating)}
        title={rotating ? `Replace credentials for ${rotating.label}` : "Replace credentials"}
      >
        {rotating ? (
          <ProviderCredentialForm
            error={replaceCredentials.error?.message}
            onSubmit={(input) => replaceCredentials.mutate({ id: rotating.id, input })}
            pending={replaceCredentials.isPending}
            provider={rotating.provider}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
