import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Radar } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { post } from "../lib/api";
import { formText } from "../lib/utils";
import { Button, Card, Input, Label } from "../components/ui";

function AuthShell({ children, title, description }: React.PropsWithChildren<{
  title: string;
  description: string;
}>) {
  return (
    <div className="auth-shell">
      <section className="auth-story">
        <div className="loader-brand"><span className="brand-mark">A</span> AI Visibility Tracker</div>
        <div className="story-content">
          <span className="eyebrow">Built for answer visibility</span>
          <h1>Know when AI recommends you, and when it doesn’t.</h1>
          <p>Track citations, brand mentions, domains, products, and evidence from ChatGPT web Search mode.</p>
          <div className="signal-card">
            <Radar size={24} />
            <div><strong>Evidence first</strong><span>Every metric links back to its captured result.</span></div>
          </div>
        </div>
        <small>Cloudflare-native · DataForSEO powered</small>
      </section>
      <section className="auth-form">
        <Card className="auth-card">
          <span className="eyebrow">Welcome</span>
          <h2>{title}</h2>
          <p>{description}</p>
          {children}
        </Card>
      </section>
    </div>
  );
}

export function SetupPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const setup = useMutation({
    mutationFn: (body: Record<string, unknown>) => post("/setup", body),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      window.location.assign("/");
    },
    onError: (value: Error) => setError(value.message),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setup.mutate({
      bootstrapToken: data.get("bootstrapToken"),
      workspaceName: data.get("workspaceName"),
      displayName: data.get("displayName"),
      email: data.get("email"),
      password: data.get("password"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      monthlyRunCap: 1_000_000,
    });
  };
  return (
    <AuthShell title="Configure your tracker" description="Create the installation owner and secure this workspace.">
      <form className="form-stack" onSubmit={submit}>
        <Label>Bootstrap token</Label><Input name="bootstrapToken" type="password" required minLength={16} />
        <div className="form-grid">
          <div><Label>Workspace</Label><Input name="workspaceName" defaultValue="My workspace" required /></div>
          <div><Label>Your name</Label><Input name="displayName" required /></div>
        </div>
        <Label>Email</Label><Input name="email" type="email" required />
        <Label hint="12 characters minimum">Password</Label><Input name="password" type="password" required minLength={12} />
        {error ? <p className="form-error">{error}</p> : null}
        <Button disabled={setup.isPending} type="submit">
          {setup.isPending ? "Configuring…" : "Create workspace"} <ArrowRight size={16} />
        </Button>
      </form>
    </AuthShell>
  );
}

export function LoginPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const login = useMutation({
    mutationFn: (body: { email: string; password: string }) => post("/auth/login", body),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      window.location.assign("/");
    },
    onError: (value: Error) => setError(value.message),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    login.mutate({ email: formText(data, "email"), password: formText(data, "password") });
  };
  return (
    <AuthShell title="Sign in" description="Continue to your ChatGPT visibility workspace.">
      <form className="form-stack" onSubmit={submit}>
        <Label>Email</Label><Input name="email" type="email" autoComplete="email" required />
        <Label>Password</Label><Input name="password" type="password" autoComplete="current-password" required />
        {error ? <p className="form-error">{error}</p> : null}
        <Button disabled={login.isPending} type="submit">
          {login.isPending ? "Signing in…" : "Sign in"} <ArrowRight size={16} />
        </Button>
      </form>
    </AuthShell>
  );
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const accept = useMutation({
    mutationFn: (body: Record<string, string>) => post("/auth/invitations/accept", body),
    onSuccess: () => setComplete(true),
    onError: (value: Error) => setError(value.message),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    accept.mutate({
      token: params.get("token") ?? "",
      displayName: formText(data, "displayName"),
      password: formText(data, "password"),
    });
  };
  return (
    <AuthShell title={complete ? "You’re in" : "Accept your invitation"} description={complete ? "Your account is ready." : "Choose your name and a secure password."}>
      {complete ? (
        <div className="success-panel"><CheckCircle2 /><p>You can now open the workspace.</p><Button onClick={() => window.location.assign("/")}>Continue</Button></div>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          <Label>Your name</Label><Input name="displayName" required />
          <Label>Password</Label><Input name="password" type="password" minLength={12} required />
          {error ? <p className="form-error">{error}</p> : null}
          <Button disabled={accept.isPending}>Accept invitation</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const reset = useMutation({
    mutationFn: (body: Record<string, string>) =>
      post("/auth/password-reset/complete", body),
    onSuccess: () => setComplete(true),
    onError: (value: Error) => setError(value.message),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    reset.mutate({
      token: params.get("token") ?? "",
      password: formText(data, "password"),
    });
  };
  return (
    <AuthShell
      title={complete ? "Password updated" : "Choose a new password"}
      description={complete ? "All previous sessions were signed out." : "Reset links expire after one hour."}
    >
      {complete ? (
        <div className="success-panel">
          <CheckCircle2 />
          <p>Your new password is ready to use.</p>
          <Button onClick={() => window.location.assign("/")}>Sign in</Button>
        </div>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          <Label hint="12 characters minimum">New password</Label>
          <Input name="password" type="password" minLength={12} required />
          {error ? <p className="form-error">{error}</p> : null}
          <Button disabled={reset.isPending}>
            {reset.isPending ? "Updating…" : "Update password"}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
