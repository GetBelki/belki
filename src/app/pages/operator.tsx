import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, MailPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PageHeader } from "../components/layout";
import { Badge, Button, CardHeader, DataTable, Dialog, Input, Label, Select, Skeleton } from "../components/ui";
import { api, patch, post, remove } from "../lib/api";
import { formText } from "../lib/utils";

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
  status: "pending_payment" | "active" | "read_only" | "suspended" | "deleted";
  plan_key: string;
  subscription_status: string;
  monthly_units: number;
  project_limit: number;
  seats: number;
  projects: number;
  stripe_livemode: number | null;
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
  return (
    <div className="page operator-page page-flow">
      <PageHeader
        title="Operator console"
        description="Invite managed customers and intervene in workspace access when support or abuse response requires it."
        action={<Button onClick={() => { setSignupUrl(""); createCode.reset(); setInviteOpen(true); }}><MailPlus size={16} /> Invite customer</Button>}
      />
      <div className="operator-security-note">
        <strong>Protected operations</strong>
        <span>Cloudflare Access must remain enabled for this route in production.</span>
      </div>
      <section className="operator-section">
        <CardHeader title="Managed workspaces" description="Subscription webhooks normally control these states; manual suspension is available for support and abuse response." />
        {workspaces.isPending ? <Skeleton className="settings-feature-skeleton" /> : (
          <DataTable
            columns={[{ key: "workspace", label: "Workspace" }, { key: "plan", label: "Plan" }, { key: "usage", label: "Limits" }, { key: "status", label: "Status" }]}
            rows={(workspaces.data ?? []).map((workspace) => ({
              id: workspace.id,
              workspace: <div className="primary-cell"><strong>{workspace.name}</strong><span>{workspace.seats} seats · {workspace.projects} projects</span></div>,
              plan: <div className="primary-cell"><strong>{workspace.plan_key}</strong>{workspace.stripe_livemode === null ? null : <span>{workspace.stripe_livemode === 1 ? "Stripe live" : "Stripe sandbox"}</span>}</div>,
              usage: `${workspace.monthly_units.toLocaleString()} units · ${workspace.project_limit} projects`,
              status: <Select
                ariaLabel={`Status for ${workspace.name}`}
                value={workspace.status}
                onValueChange={(status) => setStatusChange({ workspace, status: status as ManagedWorkspace["status"] })}
                options={["active", "pending_payment", "read_only", "suspended", "deleted"].map((status) => ({ value: status, label: status.replaceAll("_", " ") }))}
              />,
            }))}
          />
        )}
      </section>
      <section className="operator-section">
        <CardHeader title="Recent signup codes" />
        {codes.isPending ? <Skeleton className="settings-feature-skeleton" /> : (
          <DataTable
            columns={[{ key: "email", label: "Email" }, { key: "state", label: "State" }, { key: "expires", label: "Expires" }, { key: "actions", label: "" }]}
            rows={(codes.data ?? []).map((code) => ({
              id: code.id,
              email: code.email,
              state: <Badge tone={code.consumed_at ? "success" : code.revoked_at || Date.parse(code.expires_at) < renderedAt ? "danger" : "info"}>{code.consumed_at ? "Used" : code.revoked_at ? "Revoked" : Date.parse(code.expires_at) < renderedAt ? "Expired" : "Pending"}</Badge>,
              expires: new Date(code.expires_at).toLocaleString(),
              actions: !code.consumed_at && !code.revoked_at && Date.parse(code.expires_at) >= renderedAt
                ? <Button disabled={revokeCode.isPending} onClick={() => revokeCode.mutate(code.id)} variant="ghost">Revoke</Button>
                : null,
            }))}
          />
        )}
      </section>

      <Dialog
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
          <form className="form-stack" onSubmit={submit}>
            <div><Label>Customer email</Label><Input name="email" type="email" placeholder="customer@company.com" autoFocus required /></div>
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
        onOpenChange={(open) => { if (!open) setStatusChange(null); }}
        title={`Change ${statusChange?.workspace.name ?? "workspace"} to ${statusChange?.status.replaceAll("_", " ") ?? "new status"}?`}
        description="This manual action can immediately change customer access. Stripe webhooks may update the status again later."
      >
        <div className="form-stack">
          <div className="operator-status-summary">
            <span>Current status <strong>{statusChange?.workspace.status.replaceAll("_", " ")}</strong></span>
            <span>New status <strong>{statusChange?.status.replaceAll("_", " ")}</strong></span>
          </div>
          {updateWorkspace.isError ? <p className="form-error">{updateWorkspace.error.message}</p> : null}
          <div className="dialog-actions">
            <Button type="button" variant="ghost" onClick={() => setStatusChange(null)}>Cancel</Button>
            <Button
              disabled={updateWorkspace.isPending}
              variant={statusChange?.status === "suspended" || statusChange?.status === "deleted" ? "danger" : "default"}
              onClick={() => statusChange && updateWorkspace.mutate({ id: statusChange.workspace.id, status: statusChange.status })}
              type="button"
            >{updateWorkspace.isPending ? "Updating…" : "Confirm status change"}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
