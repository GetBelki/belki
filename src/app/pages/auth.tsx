import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Radar } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { post } from "../lib/api";
import { APP_NAME } from "../lib/branding";
import { formText } from "../lib/utils";
import { AppIcon } from "../components/app-icon";
import { Button, Card, Input, Label } from "../components/ui";

function AuthShell({ children, title, description }: React.PropsWithChildren<{
  title: string;
  description: string;
}>) {
  return (
    <div className="auth-shell">
      <section className="auth-story">
        <div className="loader-brand"><span className="brand-mark"><AppIcon /></span> {APP_NAME}</div>
        <div className="story-content">
          <span className="eyebrow">Built for answer visibility</span>
          <h1>Know when AI recommends you, and when it doesn’t.</h1>
          <p>Track citations, brand mentions, sources, and products across ChatGPT web Search responses.</p>
          <div className="signal-card">
            <Radar size={24} />
            <div><strong>Source-linked insights</strong><span>Every metric links back to the captured AI response.</span></div>
          </div>
        </div>
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
  const [resetRequested, setResetRequested] = useState(false);
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
  const requestReset = useMutation({
    mutationFn: (email: string) => post("/auth/password-reset/request", { email }),
    onSuccess: () => setResetRequested(true),
    onError: (value: Error) => setError(value.message),
  });
  const resetSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    requestReset.mutate(formText(new FormData(event.currentTarget), "email"));
  };
  return (
    <AuthShell title="Sign in" description="Continue to your ChatGPT visibility workspace.">
      {resetRequested ? (
        <div className="success-panel"><CheckCircle2/><p>If that account exists, a reset link has been sent.</p><Button onClick={() => setResetRequested(false)}>Back to sign in</Button></div>
      ) : (
        <>
          <form className="form-stack" onSubmit={submit}>
            <Label>Email</Label><Input name="email" type="email" autoComplete="email" required />
            <Label>Password</Label><Input name="password" type="password" autoComplete="current-password" required />
            {error ? <p className="form-error">{error}</p> : null}
            <Button disabled={login.isPending} type="submit">
              {login.isPending ? "Signing in…" : "Sign in"} <ArrowRight size={16} />
            </Button>
          </form>
          <form className="form-stack" onSubmit={resetSubmit}>
            <Label hint="We will email a one-hour link">Forgot password?</Label>
            <Input name="email" type="email" placeholder="you@example.com" required />
            <Button variant="secondary" disabled={requestReset.isPending}>Send reset link</Button>
          </form>
        </>
      )}
    </AuthShell>
  );
}

export function SignupPage() {
  const [params] = useSearchParams();
  const [error, setError] = useState("");
  const signup = useMutation({
    mutationFn: (body: Record<string, unknown>) => post<{ checkoutRequired: boolean }>("/auth/signup/redeem", body),
    onSuccess: ({ checkoutRequired }) => window.location.assign(checkoutRequired ? "/billing" : "/"),
    onError: (value: Error) => setError(value.message),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    signup.mutate({
      code: params.get("code") ?? formText(data, "code"),
      email: formText(data, "email"),
      workspaceName: formText(data, "workspaceName"),
      displayName: formText(data, "displayName"),
      password: formText(data, "password"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  };
  return (
    <AuthShell title="Create your workspace" description="Signup is currently available with an email-bound invitation code.">
      <form className="form-stack" onSubmit={submit}>
        {!params.get("code") ? <><Label>Signup code</Label><Input name="code" required minLength={32}/></> : null}
        <Label>Email</Label><Input name="email" type="email" defaultValue={params.get("email") ?? ""} required/>
        <div className="form-grid">
          <div><Label>Workspace</Label><Input name="workspaceName" required/></div>
          <div><Label>Your name</Label><Input name="displayName" required/></div>
        </div>
        <Label hint="12 characters minimum">Password</Label><Input name="password" type="password" minLength={12} required/>
        {error ? <p className="form-error">{error}</p> : null}
        <Button disabled={signup.isPending}>{signup.isPending ? "Creating…" : "Continue to checkout"}<ArrowRight size={16}/></Button>
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
