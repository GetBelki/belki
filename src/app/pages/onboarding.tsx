import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, FolderKanban, MessageSquareText } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { AppIcon } from "../components/app-icon";
import { Button, Input, Label, Select } from "../components/ui";
import { useApp } from "../context";
import { post } from "../lib/api";
import { APP_NAME } from "../lib/branding";
import { LOCATION_OPTIONS, languagesForLocation } from "../lib/locale-catalog";
import { formText, pluralize } from "../lib/utils";

function OnboardingShell({
  step,
  title,
  description,
  children,
}: React.PropsWithChildren<{
  step: 1 | 2;
  title: string;
  description: string;
}>) {
  return (
    <main className="onboarding-shell">
      <header className="onboarding-brand">
        <span className="brand-mark"><AppIcon /></span>
        <strong>{APP_NAME}</strong>
      </header>
      <div className="onboarding-layout">
        <aside className="onboarding-progress" aria-label="Setup progress">
          <span className="eyebrow">Workspace setup</span>
          <h2>Start tracking in two steps.</h2>
          <ol>
            <li className={step >= 1 ? "active" : undefined}>
              <span>{step > 1 ? <Check size={15} /> : "1"}</span>
              <div><strong>Create a project</strong><small>Define the brand you want to monitor.</small></div>
            </li>
            <li className={step >= 2 ? "active" : undefined}>
              <span>2</span>
              <div><strong>Add prompts</strong><small>Tell Belki which questions to track.</small></div>
            </li>
          </ol>
        </aside>
        <section className="onboarding-content">
          <div className="onboarding-heading">
            <span>Step {step} of 2</span>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {children}
        </section>
      </div>
    </main>
  );
}

export function ProjectOnboardingPage() {
  const { projects, session } = useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createProject = useMutation({
    mutationFn: (body: Record<string, unknown>) => post<{ id: string }>("/projects", body),
    onSuccess: async ({ id }) => {
      localStorage.setItem("ai-tracker-project", id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["session"] }),
      ]);
      void navigate("/onboarding/prompts", { replace: true });
    },
  });

  if (projects.length > 0) return <Navigate to="/onboarding/prompts" replace />;
  if (session.user.role === "viewer") return <Navigate to="/" replace />;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    createProject.mutate({
      name: formText(data, "name"),
      primaryDomain: formText(data, "primaryDomain") || null,
      ownedBrandName: formText(data, "brand"),
      ownedBrandAliases: [],
      competitorBrands: [],
      htmlCaptureEnabled: false,
    });
  };

  return (
    <OnboardingShell
      step={1}
      title="Create your first project"
      description="A project connects one brand, its website, and the prompts your audience asks AI."
    >
      <form className="onboarding-form" onSubmit={submit}>
        <div className="onboarding-field">
          <Label>Project name</Label>
          <Input name="name" placeholder="Acme visibility" autoFocus required />
          <small>A private name for this monitoring project.</small>
        </div>
        <div className="onboarding-field">
          <Label>Brand name</Label>
          <Input name="brand" placeholder="Acme" required />
          <small>The name you expect ChatGPT to mention in an answer.</small>
        </div>
        <div className="onboarding-field">
          <Label>Primary website <span className="optional-label">Optional</span></Label>
          <Input name="primaryDomain" placeholder="acme.com" inputMode="url" />
          <small>Used to identify citations and links that belong to you.</small>
        </div>
        {createProject.isError ? <p className="form-error">{createProject.error.message}</p> : null}
        <Button className="onboarding-primary-action" disabled={createProject.isPending}>
          {createProject.isPending ? "Creating project…" : "Continue to prompts"}
          <ArrowRight size={17} />
        </Button>
      </form>
      <div className="onboarding-assurance">
        <FolderKanban size={18} />
        <span>You can change these details and add competitors later.</span>
      </div>
    </OnboardingShell>
  );
}

export function PromptOnboardingPage() {
  const { projectId, currentProject } = useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [promptText, setPromptText] = useState("");
  const [locationCode, setLocationCode] = useState("2840");
  const [languageCode, setLanguageCode] = useState(
    languagesForLocation("2840")[0]?.value ?? "en",
  );
  const prompts = promptText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const createPrompts = useMutation({
    mutationFn: (queryTexts: string[]) => post(`/projects/${projectId}/queries/bulk`, {
      queryTexts,
      locationCode: Number(locationCode),
      languageCode,
      forceWebSearch: true,
      schedule: {
        cadence: "daily",
        time: "09:00",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      tags: [],
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompts", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["session"] }),
      ]);
      void navigate("/prompts", { replace: true });
    },
  });

  if (!projectId) return <Navigate to="/onboarding/project" replace />;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (prompts.length === 0 || prompts.length > 50) return;
    createPrompts.mutate(prompts);
  };

  return (
    <OnboardingShell
      step={2}
      title="Add the questions that matter"
      description={`Start with the questions customers ask when comparing or discovering ${currentProject?.name ?? "your brand"}. Add one per line.`}
    >
      <form className="onboarding-form onboarding-prompts-form" onSubmit={submit}>
        <div className="onboarding-field">
          <Label>Prompts</Label>
          <textarea
            autoFocus
            className="textarea onboarding-prompt-input"
            maxLength={100_000}
            onChange={(event) => setPromptText(event.target.value)}
            placeholder={"What are the best tools for my team?\nWhich product is best for small businesses?\nWhat are the alternatives to [competitor]?"}
            required
            value={promptText}
          />
          <small className={prompts.length > 50 ? "form-error" : undefined}>
            {prompts.length} of 50 prompts
          </small>
        </div>
        <div className="form-grid onboarding-locale-grid">
          <div className="onboarding-field">
            <Label>Audience location</Label>
            <Select
              value={locationCode}
              onValueChange={(value) => {
                setLocationCode(value);
                const languages = languagesForLocation(value);
                if (!languages.some((language) => language.value === languageCode)) {
                  setLanguageCode(languages[0]?.value ?? "en");
                }
              }}
              options={LOCATION_OPTIONS}
            />
          </div>
          <div className="onboarding-field">
            <Label>Answer language</Label>
            <Select
              value={languageCode}
              onValueChange={setLanguageCode}
              options={languagesForLocation(locationCode)}
            />
          </div>
        </div>
        <div className="onboarding-actions">
          <Button asChild variant="ghost"><Link to="/">Skip for now</Link></Button>
          <Button disabled={createPrompts.isPending || prompts.length === 0 || prompts.length > 50}>
            {createPrompts.isPending ? "Adding prompts…" : `Add ${pluralize(prompts.length, "prompt")}`}
            <ArrowRight size={17} />
          </Button>
        </div>
        {createPrompts.isError ? <p className="form-error">{createPrompts.error.message}</p> : null}
      </form>
      <div className="onboarding-assurance">
        <MessageSquareText size={18} />
        <span>Prompts run daily at 09:00 in your local timezone. You can customize schedules later.</span>
      </div>
    </OnboardingShell>
  );
}
