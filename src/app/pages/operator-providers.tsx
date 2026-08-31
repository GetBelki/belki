import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Power,
  Route,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
  ProviderTestButtonContent,
  ProviderTestFeedback,
  ProviderTestStatus,
  type ProviderTestResult,
} from "../components/provider-test-feedback";
import {
  ProviderAccountForm,
  ProviderCredentialForm,
} from "../components/provider-account-form";
import { Badge, Button, Dialog, Select, Skeleton, Switch } from "../components/ui";
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

interface ProviderNotice {
  id: number;
  tone: "success" | "error";
  title: string;
  message: string;
}

function ProviderSaveNotice({
  notice,
  onDismiss,
}: {
  notice: ProviderNotice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(onDismiss, notice.tone === "error" ? 7_000 : 4_500);
    return () => window.clearTimeout(timeout);
  }, [notice, onDismiss]);

  if (!notice) return null;

  return (
    <div
      aria-atomic="true"
      aria-live={notice.tone === "error" ? "assertive" : "polite"}
      className={`provider-save-notice provider-save-notice-${notice.tone}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <span className="provider-save-notice-icon">
        {notice.tone === "success" ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
      </span>
      <span className="provider-save-notice-copy">
        <strong>{notice.title}</strong>
        <span>{notice.message}</span>
      </span>
      <button aria-label="Dismiss notification" onClick={onDismiss} type="button">
        <X aria-hidden="true" size={15} />
      </button>
    </div>
  );
}

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
  const [disabling, setDisabling] = useState<ProviderAccount | null>(null);
  const [notice, setNotice] = useState<ProviderNotice | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const showNotice = useCallback((
    tone: ProviderNotice["tone"],
    title: string,
    message: string,
  ) => {
    setNotice({ id: Date.now(), tone, title, message });
  }, []);
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
    onSuccess: async (_, input) => {
      setAddOpen(false);
      await refresh();
      showNotice("success", "Provider added", `${input.label} is verified and ready to use.`);
    },
  });
  const replaceCredentials = useMutation({
    mutationFn: ({ id, input }: { id: string; input: CaptureProviderCredentialInput }) =>
      api(`/operator/providers/${encodeURIComponent(id)}/credentials`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: async (_, variables) => {
      const account = configuration.data?.accounts.find(({ id }) => id === variables.id);
      setRotating(null);
      await refresh();
      showNotice(
        "success",
        "Credentials replaced",
        `${account?.label ?? "Provider"} is verified and using the new credentials.`,
      );
    },
  });
  const testAccount = useMutation({
    mutationFn: (id: string) => post<ProviderTestResult>(
      `/operator/providers/${encodeURIComponent(id)}/test`,
    ),
    onSuccess: refresh,
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => post(`/operator/providers/${encodeURIComponent(id)}/default`),
    onSuccess: async (_, id) => {
      const account = configuration.data?.accounts.find((item) => item.id === id);
      await refresh();
      showNotice(
        "success",
        "Default provider saved",
        `${account?.label ?? "Provider"} will be used when a platform does not have a provider selected.`,
      );
    },
    onError: (error: Error) => showNotice("error", "Default not changed", error.message),
  });
  const updateAccount = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ProviderAccount["status"] }) =>
      patch(`/operator/providers/${encodeURIComponent(id)}`, { status }),
    onSuccess: async (_, variables) => {
      const account = configuration.data?.accounts.find(({ id }) => id === variables.id);
      setDisabling(null);
      await refresh();
      showNotice(
        "success",
        variables.status === "active" ? "Provider enabled" : "Provider disabled",
        `${account?.label ?? "Provider"} ${variables.status === "active" ? "is ready to use" : "will not be used for future requests"}.`,
      );
    },
    onError: (error: Error) => showNotice("error", "Provider not updated", error.message),
  });
  const updateRoute = useMutation({
    mutationFn: ({ source, input }: {
      source: TrackingSource;
      input: { enabled?: boolean; providerAccountId?: string | null };
    }) => patch(`/operator/platforms/${source}`, input),
    onSuccess: async (_, variables) => {
      const platformLabel = TRACKING_SOURCE_LABELS[variables.source];
      await refresh();
      if (variables.input.enabled !== undefined) {
        showNotice(
          "success",
          `${platformLabel} ${variables.input.enabled ? "enabled" : "disabled"}`,
          "Your change has been saved.",
        );
        return;
      }
      const selectedAccount = configuration.data?.accounts.find(
        ({ id }) => id === variables.input.providerAccountId,
      );
      showNotice(
        "success",
        `${platformLabel} provider saved`,
        selectedAccount
          ? `Future requests will use ${selectedAccount.label}.`
          : "Future requests will use your default provider.",
      );
    },
    onError: (error: Error, variables) => showNotice(
      "error",
      `${TRACKING_SOURCE_LABELS[variables.source]} was not saved`,
      error.message,
    ),
  });

  if (configuration.error) {
    return <OperatorDataFailure error={configuration.error} onRetry={() => void configuration.refetch()} />;
  }
  const accounts = configuration.data?.accounts ?? [];
  const routes = configuration.data?.routes ?? [];
  const activity = configuration.data?.activity;
  const activitySummary = activity?.summary ?? EMPTY_ACTIVITY;
  const activeAccounts = accounts.filter((account) => account.status === "active" && account.credentialConfigured);
  const disablingRouteCount = disabling
    ? routes.filter((route) => route.providerAccountId === disabling.id).length
    : 0;
  return (
    <div className="page operator-page provider-operator-page page-flow">
      <PageHeader
        title="AI data providers"
        description="Connect provider accounts, check credentials, and choose a provider for each AI platform."
        action={<Button onClick={() => setAddOpen(true)}><Plus size={16} /> Add provider</Button>}
      />
      <div className="provider-summary-strip" aria-label="Provider activity in the last 30 days">
        <div><strong>{configuration.isPending ? "—" : activitySummary.submitted}</strong><span>Submitted · 30 days</span></div>
        <div><strong>{configuration.isPending ? "—" : activitySummary.completed}</strong><span>Completed</span></div>
        <div><strong>{configuration.isPending ? "—" : activitySummary.needsAttention}</strong><span>Needs attention</span></div>
        <div><strong>{configuration.isPending ? "—" : successRateLabel(activitySummary)}</strong><span>Success rate</span></div>
      </div>

      <section className="operator-section">
        <div className="operator-section-heading">
          <h2>Accounts</h2>
          <p>Credentials are stored securely. Activity covers the last 30 days; needs attention includes requests that failed or returned an unclear result.</p>
        </div>
        {configuration.isPending ? <Skeleton className="settings-feature-skeleton" /> : accounts.length === 0 ? (
          <div className="provider-account-empty">
            <span><KeyRound aria-hidden="true" size={18} /></span>
            <div>
              <h3>No provider accounts</h3>
              <p>Add and verify an account before routing AI platforms.</p>
            </div>
            <Button onClick={() => setAddOpen(true)} variant="secondary"><Plus size={14} /> Add provider</Button>
          </div>
        ) : (
          <div className="provider-account-list">
            <div aria-hidden="true" className="provider-account-list-header">
              <span>Account</span>
              <span>Connection</span>
              <span>Platforms</span>
              <span>30-day activity</span>
              <span>Actions</span>
            </div>
            {accounts.map((account) => {
              const accountActivity = activity?.byAccount.find(
                (item) => item.providerAccountId === account.id,
              ) ?? EMPTY_ACTIVITY;
              const isCurrentTest = testAccount.variables === account.id;
              const isTesting = isCurrentTest && testAccount.isPending;
              const testResult = isCurrentTest && testAccount.isSuccess
                ? testAccount.data
                : null;
              const testError = isCurrentTest && testAccount.isError
                ? testAccount.error
                : null;
              return <article className="provider-account-card" key={account.id}>
                <div className="provider-account-heading">
                  <div className="provider-account-identity">
                    <ProviderIcon provider={account.provider} size={22} />
                    <div>
                      <h3>{account.label}</h3>
                      <span>{CAPTURE_PROVIDER_LABELS[account.provider]}</span>
                    </div>
                  </div>
                  <div className="provider-account-badges">
                    {account.isDefault ? <Badge tone="info">Default</Badge> : null}
                    <Badge tone={account.status === "active" && account.credentialConfigured ? "success" : "warning"}>
                      {account.status === "disabled" ? "Disabled" : account.credentialConfigured ? "Active" : "Needs credentials"}
                    </Badge>
                  </div>
                </div>
                <div className="provider-account-connection">
                  <ProviderTestStatus
                    message={account.lastTestMessage}
                    status={account.lastTestStatus}
                    untestedMessage="Not tested yet"
                  />
                  <span><KeyRound size={14} /> Credentials stored securely</span>
                </div>
                <div className="provider-account-routing">
                  <span><Route size={14} /> {account.supportedSources.map((source) => TRACKING_SOURCE_LABELS[source]).join(", ")}</span>
                </div>
                <div className="provider-account-activity" aria-label={`${account.label} activity in the last 30 days`}>
                  <div><strong>{accountActivity.completed}</strong><span>Completed</span></div>
                  <div className={accountActivity.needsAttention > 0 ? "has-attention" : undefined}><strong>{accountActivity.needsAttention}</strong><span>Attention</span></div>
                  <div><strong>{accountActivity.inProgress}</strong><span>In progress</span></div>
                  <div><strong>{successRateLabel(accountActivity)}</strong><span>Success</span></div>
                  <small>{latencyLabel(accountActivity.averageLatencyMs)} · {lastActivityLabel(accountActivity.lastActivityAt)}</small>
                </div>
                <div className="provider-account-actions">
                  <Button
                    className="provider-test-button"
                    disabled={testAccount.isPending || !account.credentialConfigured}
                    onClick={() => testAccount.mutate(account.id)}
                    variant="secondary"
                  >
                    <ProviderTestButtonContent pending={isTesting} />
                  </Button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <Button
                        aria-label={`More actions for ${account.label}`}
                        className="provider-account-menu-trigger"
                        title="More actions"
                        variant="secondary"
                      >
                        <MoreHorizontal aria-hidden="true" size={16} />
                      </Button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="end"
                        collisionPadding={12}
                        className="prompt-actions-menu provider-account-menu"
                        sideOffset={5}
                      >
                        {!account.isDefault ? (
                          <DropdownMenu.Item
                            className="prompt-actions-menu-item"
                            disabled={!account.credentialConfigured || account.status !== "active" || makeDefault.isPending}
                            onSelect={() => makeDefault.mutate(account.id)}
                          >
                            <Star size={14} />
                            <span>{makeDefault.isPending && makeDefault.variables === account.id ? "Saving…" : "Make default provider"}</span>
                          </DropdownMenu.Item>
                        ) : null}
                        <DropdownMenu.Item asChild className="prompt-actions-menu-item">
                          <a href={CAPTURE_PROVIDER_DASHBOARD_URLS[account.provider]} rel="noreferrer" target="_blank">
                            <ExternalLink size={14} />
                            <span>Open provider dashboard</span>
                          </a>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="prompt-actions-menu-item"
                          onSelect={() => setRotating(account)}
                        >
                          <KeyRound size={14} />
                          <span>Replace credentials</span>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="prompt-actions-menu-separator" />
                        <DropdownMenu.Item
                          className={`prompt-actions-menu-item${account.status === "active" ? " prompt-actions-menu-danger" : ""}`}
                          disabled={account.isDefault || updateAccount.isPending}
                          onSelect={() => {
                            if (account.status === "active") setDisabling(account);
                            else updateAccount.mutate({ id: account.id, status: "active" });
                          }}
                        >
                          {updateAccount.isPending && updateAccount.variables?.id === account.id ? <LoaderCircle className="provider-test-spinner" size={14} /> : <Power size={14} />}
                          <span>{account.status === "active" ? "Disable account" : "Enable account"}</span>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                  <ProviderTestFeedback
                    error={testError}
                    label={account.providerLabel}
                    pending={isTesting}
                    result={testResult}
                  />
                </div>
              </article>;
            })}
          </div>
        )}
      </section>

      <section className="operator-section">
        <div className="operator-section-heading">
          <h2>AI platforms</h2>
          <p>Choose the provider for future requests. Changes save immediately.</p>
        </div>
        <div className="provider-route-list">
          <div aria-hidden="true" className="provider-route-list-header">
            <span>Platform</span>
            <span>Provider</span>
            <span>Collection</span>
          </div>
          {routes.map((route) => {
            const effective = accounts.find((account) => account.id === route.effectiveProviderAccountId);
            const compatible = activeAccounts.filter((account) => account.supportedSources.includes(route.trackingSource));
            const platformActivity = activity?.byPlatform.find(
              (item) => item.trackingSource === route.trackingSource,
            ) ?? EMPTY_ACTIVITY;
            const isSaving = updateRoute.isPending
              && updateRoute.variables?.source === route.trackingSource;
            return (
              <div className="provider-route-row" key={route.trackingSource}>
                <div className="provider-route-name">
                  <strong>{TRACKING_SOURCE_LABELS[route.trackingSource]}</strong>
                  <small>{platformActivity.completed} completed · {platformActivity.needsAttention} need attention · {platformActivity.inProgress} in progress</small>
                </div>
                <div className="provider-route-provider">
                  <Select
                    ariaLabel={`${TRACKING_SOURCE_LABELS[route.trackingSource]} provider`}
                    disabled={isSaving}
                    onValueChange={(value) => updateRoute.mutate({
                      source: route.trackingSource,
                      input: { providerAccountId: value === DEFAULT_ROUTE ? null : value },
                    })}
                    options={[
                      {
                        value: DEFAULT_ROUTE,
                        label: "Use default provider",
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
                  <small>{route.enabled ? `Currently ${effective?.label ?? "no provider available"}` : "Provider choice stays saved while disabled"}</small>
                </div>
                <div className="provider-route-control">
                  <Switch
                    ariaLabel={`${route.enabled ? "Disable" : "Enable"} ${TRACKING_SOURCE_LABELS[route.trackingSource]}`}
                    checked={route.enabled}
                    disabled={isSaving}
                    onCheckedChange={(enabled) => updateRoute.mutate({ source: route.trackingSource, input: { enabled } })}
                  />
                  <span>{isSaving ? "Saving…" : route.enabled ? "Enabled" : "Disabled"}</span>
                  {isSaving ? <LoaderCircle aria-hidden="true" className="provider-test-spinner" size={13} /> : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <Dialog
        contentClassName="provider-dialog"
        description="Belki checks the credentials before storing them securely."
        onOpenChange={setAddOpen}
        open={addOpen}
        title="Add provider"
      >
        <ProviderAccountForm
          error={createAccount.error?.message}
          onSubmit={(input) => createAccount.mutate(input)}
          pending={createAccount.isPending}
          submitLabel="Check and add"
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
      <Dialog
        contentClassName="provider-disable-dialog"
        description={disabling ? `Disabling this account prevents it from handling future requests.${disablingRouteCount > 0 ? ` ${disablingRouteCount} platform ${disablingRouteCount === 1 ? "choice" : "choices"} will switch to the default provider.` : ""}` : undefined}
        onOpenChange={(open) => !open && setDisabling(null)}
        open={Boolean(disabling)}
        title={disabling ? `Disable ${disabling.label}?` : "Disable provider account?"}
      >
        <div className="provider-disable-actions">
          <Button disabled={updateAccount.isPending} onClick={() => setDisabling(null)} variant="secondary">Cancel</Button>
          <Button
            disabled={updateAccount.isPending || !disabling}
            onClick={() => disabling && updateAccount.mutate({ id: disabling.id, status: "disabled" })}
            variant="danger"
          >
            {updateAccount.isPending ? <><LoaderCircle className="provider-test-spinner" size={14} /> Disabling…</> : "Disable account"}
          </Button>
        </div>
      </Dialog>
      <ProviderSaveNotice key={notice?.id ?? "provider-notice"} notice={notice} onDismiss={dismissNotice} />
    </div>
  );
}
