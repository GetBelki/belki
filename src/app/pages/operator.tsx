import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { PageHeader } from "../components/layout";
import { Badge, Button, Card, CardHeader, DataTable, Input, Label, Select, Skeleton } from "../components/ui";
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
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["operator-workspaces"] }),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createCode.mutate(formText(new FormData(event.currentTarget), "email"));
  };
  return (
    <div className="page">
      <PageHeader title="Operator console" description="Invite managed customers and control workspace access. Cloudflare Access must protect this route in production." />
      <Card>
        <CardHeader title="Create signup code" description="Codes are bound to one email, expire after seven days, and can be redeemed once." />
        <form className="form-stack" onSubmit={submit}>
          <Label>Email</Label><Input name="email" type="email" required />
          <Button disabled={createCode.isPending}>Create invitation URL</Button>
          {signupUrl ? <Input aria-label="Signup URL" readOnly value={signupUrl} onFocus={(event) => event.currentTarget.select()} /> : null}
        </form>
      </Card>
      <Card>
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
                onValueChange={(status) => updateWorkspace.mutate({ id: workspace.id, status: status as ManagedWorkspace["status"] })}
                options={["active", "pending_payment", "read_only", "suspended", "deleted"].map((status) => ({ value: status, label: status.replaceAll("_", " ") }))}
              />,
            }))}
          />
        )}
      </Card>
      <Card>
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
      </Card>
    </div>
  );
}
