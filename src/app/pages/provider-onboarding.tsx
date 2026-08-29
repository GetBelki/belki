import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Navigate, useNavigate } from "react-router-dom";
import type { CaptureProviderAccountInput } from "../../shared/contracts";
import { AppIcon } from "../components/app-icon";
import { ProviderAccountForm } from "../components/provider-account-form";
import { useApp } from "../context";
import { post } from "../lib/api";
import { APP_NAME } from "../lib/branding";
import { OPERATOR_PAYMENT_ONBOARDING_PATH } from "../lib/onboarding-navigation";

export default function ProviderOnboardingPage() {
  const { session } = useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createProvider = useMutation({
    mutationFn: (input: CaptureProviderAccountInput) =>
      post("/operator/providers", input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["status"] }),
        queryClient.invalidateQueries({ queryKey: ["operator-providers"] }),
      ]);
      void navigate(OPERATOR_PAYMENT_ONBOARDING_PATH, { replace: true });
    },
  });

  if (!session.isPlatformOperator) return <Navigate to="/" replace />;

  return (
    <main className="onboarding-shell provider-onboarding-shell">
      <header className="onboarding-brand">
        <span className="brand-mark"><AppIcon /></span>
        <strong>{APP_NAME}</strong>
      </header>
      <div className="onboarding-layout provider-onboarding-layout">
        <aside className="onboarding-progress">
          <span className="eyebrow">Installation setup</span>
          <h2>Connect the service that captures AI answers.</h2>
          <p className="provider-onboarding-copy">Provider accounts belong to the installation, not customer workspaces. You can add more accounts and choose a provider for each AI platform from the operator dashboard later.</p>
        </aside>
        <section className="onboarding-content">
          <div className="onboarding-heading">
            <span>Provider setup</span>
            <h1>Connect your first provider</h1>
            <p>DataForSEO is selected first based on your preferred order. Belki will verify the credentials before saving them.</p>
          </div>
          <ProviderAccountForm
            error={createProvider.error?.message}
            onSubmit={(input) => createProvider.mutate(input)}
            pending={createProvider.isPending}
          />
          <div className="onboarding-assurance">
            <KeyRound size={18} />
            <span>Credentials are encrypted with the installation crypto key and can only be replaced, never revealed.</span>
          </div>
        </section>
      </div>
    </main>
  );
}
