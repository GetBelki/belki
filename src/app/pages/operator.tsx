import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, MailPlus, Settings2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PageHeader } from "../components/layout";
import { OperatorDataFailure } from "../components/operator-access";
import { Button, DataTable, Dialog, EmptyState, Input, Label, Select, Skeleton } from "../components/ui";
import { api, patch, post, remove } from "../lib/api";
import {
  operatorLimitUsage,
  operatorPlanLabel,
  operatorStatusLabel,
  type OperatorWorkspaceStatus,
} from "../lib/operator-console";
import { formText } from "../lib/utils";

const WORKSPACE_STATUS_OPTIONS: Array<{
  value: OperatorWorkspaceStatus;
  label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "pending_payment", label: "Pending payment" },
  { value: "read_only", label: "Read only" },
  { value: "suspended", label: "Suspended" },
  { value: "deleted", label: "Deleted" },
];

const WORKSPACE_STATUS_DESCRIPTION: Record<OperatorWorkspaceStatus, string> = {
  active: "Members retain normal access according to their plan and role.",
  pending_payment: "Members are directed to billing until payment is completed.",
  read_only: "Members can review retained data but cannot make operational changes.",
  suspended: "Workspace access is blocked until an operator restores it.",
  deleted: "The workspace is removed from normal use and requires operator intervention to restore.",
};

interface SignupCode {
  id: string;
  email: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  workspace_id: string | null;
  created_at: string;
}

interface ManagedWorkspace {
  id: string;
  name: string;
  status: OperatorWorkspaceStatus;
  plan_key: string;
  plan_name: string | null;
  subscription_status: string;
  monthly_units: number;
  project_limit: number;
  prompt_limit: number;
  source_limit: number;
  seats: number;
  projects: number;
  prompts: number;
  stripe_livemode: number | null;
  payment_provider: string | null;
  payment_provider_label: string | null;
  payment_environment: "test" | "live" | null;
}

export default function OperatorPage() {
  const queryClient = useQueryClient();
  const [signupUrl, setSignupUrl] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [statusChange, setStatusChange] = useState<{
    workspace: ManagedWorkspace;
    status: ManagedWorkspace["status"];
  } | null>(null);
  const [renderedAt] = useState(() => Date.now());
  const codes = useQuery({
    queryKey: ["operator-signup-codes"],
    queryFn: () => api<SignupCode[]>("/operator/signup-codes"),
  });
  const workspaces = useQuery({
    queryKey: ["operator-workspaces"],
    queryFn: () => api<ManagedWorkspace[]>("/operator/workspaces"),
  });
  const createCode = useMutation({
    mutationFn: (email: string) => post<{ signupUrl: string }>("/operator/signup-codes", { email, expiresInDays: 7 }),
    onSuccess: async (result) => {
      setSignupUrl(result.signupUrl);
      await queryClient.invalidateQueries({ queryKey: ["operator-signup-codes"] });
    },
  });
  const revokeCode = useMutation({
    mutationFn: (id: string) => remove<{ revoked: boolean }>(`/operator/signup-codes/${id}`),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["operator-signup-codes"] }),
  });
  const updateWorkspace = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ManagedWorkspace["status"] }) =>
      patch(`/operator/workspaces/${id}`, { status }),
    onSuccess: async () => {
      setStatusChange(null);
      await queryClient.invalidateQueries({ queryKey: ["operator-workspaces"] });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createCode.mutate(formText(new FormData(event.currentTarget), "email"));
  };
  const queryError = workspaces.error ?? codes.error;
  if (queryError) {
    return (
      <OperatorDataFailure
        error={queryError}
        onRetry={() => {
          void workspaces.refetch();
          void codes.refetch();
        }}
      />
    );
  }
  const workspaceData = workspaces.data ?? [];
  const signupCodes = codes.data ?? [];
  const customerWorkspaces = workspaceData.filter(
    ({ plan_key: planKey }) => planKey !== "self_hosted",
  ).length;
  const activeWorkspaces = workspaceData.filter(
    ({ status }) => status === "active",
  ).length;
  const openInvitations = signupCodes.filter(
    (code) => !code.consumed_at
      && !code.revoked_at
      && Date.parse(code.expires_at) >= renderedAt,
  ).length;
  const openInviteDialog = () => {
    setSignupUrl("");
    createCode.reset();
    setInviteOpen(true);
  };
  const openWorkspaceManager = (workspace: ManagedWorkspace) => {
    updateWorkspace.reset();
    setStatusChange({ workspace, status: workspace.status });
  };
  return (
    <div className="page operator-page page-flow">
      <PageHeader
        title="Platform operations"
        description="Manage customer workspaces, service access, plans, and onboarding."
        action={(
          <Button onClick={openInviteDialog}><MailPlus size={16} /> Create invitation</Button>
        )}
      />
      <div aria-label="Operations summary" className="operator-summary-strip">
        <div><strong>{workspaceData.length}</strong><span>Workspaces</span></div>
        <div><strong>{customerWorkspaces}</strong><span>Managed customers</span></div>
        <div><strong>{activeWorkspaces}</strong><span>Active</span></div>
        <div><strong>{openInvitations}</strong><span>Open invitations</span></div>
      </div>
      <section className="operator-section">
        <div className="operator-section-heading">
          <h2>Workspaces</h2>
          <p>Customer access, subscriptions, usage, and service state.</p>
        </div>
        {workspaces.isPending ? <Skeleton className="settings-feature-skeleton" /> : workspaces.data?.length ? (
          <DataTable
            columns={[{ key: "workspace", label: "Workspace", className: "operator-workspace-column" }, { key: "subscription", label: "Subscription", className: "operator-subscription-column" }, { key: "usage", label: "Usage", className: "operator-usage-column" }, { key: "status", label: "Status", className: "operator-status-column" }, { key: "actions", label: "", className: "operator-actions-column" }]}
            rows={workspaceData.map((workspace) => ({
              id: workspace.id,
              workspace: <div className="primary-cell operator-workspace-cell"><strong>{workspace.name}</strong><span>{workspace.seats} {workspace.seats === 1 ? "seat" : "seats"} · {workspace.projects} {workspace.projects === 1 ? "project" : "projects"}</span></div>,
              subscription: <div className="primary-cell operator-subscription-cell"><strong>{workspace.plan_name ?? operatorPlanLabel(workspace.plan_key)}</strong><span>{workspace.plan_key === "self_hosted" ? "Belki workspace" : workspace.payment_provider_label ? `${workspace.payment_provider_label} ${workspace.payment_environment === "live" ? "production" : "sandbox"}` : operatorPlanLabel(workspace.subscription_status)}</span></div>,
              usage: <div className="operator-usage-cell"><span><strong>{operatorLimitUsage(workspace.prompts, workspace.prompt_limit)}</strong><small>Prompts</small></span><span><strong>{operatorLimitUsage(workspace.projects, workspace.project_limit)}</strong><small>Projects</small></span><span><strong>{workspace.source_limit}</strong><small>Sources / project</small></span></div>,
              status: <span className={`operator-status-text operator-status-${workspace.status}`}>{operatorStatusLabel(workspace.status)}</span>,
              actions: <Button aria-label={`Manage ${workspace.name}`} className="operator-manage-button" onClick={() => openWorkspaceManager(workspace)} variant="secondary"><Settings2 size={14} /> Manage</Button>,
            }))}
          />
        ) : <EmptyState title="No managed workspaces" description="Managed customer workspaces will appear here after their signup is completed." />}
      </section>
      <section className="operator-section operator-invitations-section">
        <div className="operator-section-heading">
          <h2>Customer invitations</h2>
          <p>Email-bound, single-use invitations that expire after seven days.</p>
        </div>
        {codes.isPending ? <Skeleton className="settings-feature-skeleton" /> : codes.data?.length ? (
          <DataTable
            columns={[{ key: "email", label: "Customer" }, { key: "state", label: "Status" }, { key: "created", label: "Created" }, { key: "expires", label: "Expires" }, { key: "actions", label: "" }]}
            rows={signupCodes.map((code) => ({
              id: code.id,
              email: <div className="primary-cell"><strong>{code.email}</strong><span>Managed customer invitation</span></div>,
              state: <span className={`operator-status-text operator-invitation-${code.consumed_at ? "used" : code.revoked_at ? "revoked" : Date.parse(code.expires_at) < renderedAt ? "expired" : "pending"}`}>{code.consumed_at ? "Used" : code.revoked_at ? "Revoked" : Date.parse(code.expires_at) < renderedAt ? "Expired" : "Pending"}</span>,
              created: new Date(code.created_at).toLocaleDateString(),
              expires: new Date(code.expires_at).toLocaleString(),
              actions: !code.consumed_at && !code.revoked_at && Date.parse(code.expires_at) >= renderedAt
                ? <Button disabled={revokeCode.isPending} onClick={() => revokeCode.mutate(code.id)} variant="ghost">Revoke</Button>
                : null,
            }))}
          />
        ) : <EmptyState title="No open invitations" description="New customer invitations will appear here after they are created." />}
      </section>

      <Dialog
        contentClassName="operator-invite-dialog"
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title={signupUrl ? "Invitation ready" : "Invite a managed customer"}
        description={signupUrl ? "Send this private signup URL to the intended recipient." : "The invitation is bound to one email, expires after seven days, and can be used once."}
      >
        {signupUrl ? (
          <div className="form-stack operator-invite-result">
            <Label>Invitation URL</Label>
            <textarea aria-label="Signup URL" className="textarea" readOnly value={signupUrl} onFocus={(event) => event.currentTarget.select()} />
            <div className="dialog-actions">
              <Button type="button" variant="secondary" onClick={() => setInviteOpen(false)}>Done</Button>
              <Button type="button" onClick={() => void navigator.clipboard.writeText(signupUrl)}><Copy size={15} /> Copy URL</Button>
            </div>
          </div>
        ) : (
          <form className="form-stack operator-invite-form" onSubmit={submit}>
            <div className="operator-invite-field"><Label>Customer email</Label><Input name="email" type="email" placeholder="customer@company.com" autoFocus required /></div>
            {createCode.isError ? <p className="form-error">{createCode.error.message}</p> : null}
            <div className="dialog-actions">
              <Button type="button" variant="ghost" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button disabled={createCode.isPending}>{createCode.isPending ? "Creating…" : "Create invitation"}</Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog
        open={Boolean(statusChange)}
        onOpenChange={(open) => { if (!open) { setStatusChange(null); updateWorkspace.reset(); } }}
        title={`Manage ${statusChange?.workspace.name ?? "workspace"}`}
        description="Review service access and make an explicit workspace status change."
      >
        <div className="form-stack">
          <div className="operator-workspace-dialog-summary">
            <div><span>Workspace</span><strong>{statusChange?.workspace.name}</strong></div>
            <div><span>Subscription</span><strong>{statusChange?.workspace.plan_name ?? operatorPlanLabel(statusChange?.workspace.plan_key ?? "")}</strong></div>
            <div><span>Current status</span><strong>{statusChange ? operatorStatusLabel(statusChange.workspace.status) : ""}</strong></div>
          </div>
          <div className="operator-status-field">
            <Label>Workspace status</Label>
            <Select
              ariaLabel="Workspace status"
              value={statusChange?.status ?? "active"}
              onValueChange={(status) => setStatusChange((current) => current
                ? { ...current, status: status as OperatorWorkspaceStatus }
                : current)}
              options={WORKSPACE_STATUS_OPTIONS}
            />
          </div>
          <p className="operator-status-impact">{statusChange ? WORKSPACE_STATUS_DESCRIPTION[statusChange.status] : ""}</p>
          {updateWorkspace.isError ? <p className="form-error">{updateWorkspace.error.message}</p> : null}
          <div className="dialog-actions">
            <Button type="button" variant="ghost" onClick={() => setStatusChange(null)}>Cancel</Button>
            <Button
              disabled={updateWorkspace.isPending || statusChange?.status === statusChange?.workspace.status}
              variant={statusChange?.status === "suspended" || statusChange?.status === "deleted" ? "danger" : "default"}
              onClick={() => statusChange && updateWorkspace.mutate({ id: statusChange.workspace.id, status: statusChange.status })}
              type="button"
            >{updateWorkspace.isPending ? "Updating…" : statusChange?.status === statusChange?.workspace.status ? "No changes" : "Save status"}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
