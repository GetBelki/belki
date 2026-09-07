import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppProvider } from "./context";
import { ApiClientError, api, type Session } from "./lib/api";
import { AppLayout } from "./components/layout";
import { AcceptInvitePage, LoginPage, ResetPasswordPage, SetupPage, SignupPage } from "./pages/auth";
import { Skeleton } from "./components/ui";
import { AppIcon } from "./components/app-icon";
import { APP_NAME } from "./lib/branding";
import {
  needsProjectOnboarding,
  OPERATOR_PAYMENT_ONBOARDING_PATH,
  OPERATOR_PROVIDER_ONBOARDING_PATH,
  requiredOperatorOnboardingPath,
} from "./lib/onboarding-navigation";

const TrafficPage = lazy(() => import("./pages/traffic").then((module) => ({ default: module.TrafficPage })));
const OverviewPage = lazy(() =>
  import("./pages/main").then((module) => ({ default: module.OverviewPage })),
);
const PromptsPage = lazy(() =>
  import("./pages/main").then((module) => ({ default: module.PromptsPage })),
);
const RelatedQueriesPage = lazy(() =>
  import("./pages/related-queries").then((module) => ({
    default: module.RelatedQueriesPage,
  })),
);
const RelatedQueryDetailPage = lazy(() =>
  import("./pages/related-queries").then((module) => ({
    default: module.RelatedQueryDetailPage,
  })),
);
const PromptLibraryPage = lazy(() => import("./pages/prompt-library"));
const SnapshotExplorerPage = lazy(() =>
  import("./pages/snapshots").then((module) => ({ default: module.SnapshotExplorerPage })),
);
const QuerySnapshotsPage = lazy(() =>
  import("./pages/snapshots").then((module) => ({ default: module.QuerySnapshotsPage })),
);
const SnapshotDetailPage = lazy(() =>
  import("./pages/snapshots").then((module) => ({ default: module.SnapshotDetailPage })),
);
const DomainsPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.DomainsPage })),
);
const CitationSourcesPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.CitationSourcesPage })),
);
const CitationSourceDetailPage = lazy(() =>
  import("./pages/insights").then((module) => ({
    default: module.CitationSourceDetailPage,
  })),
);
const EntitiesPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.EntitiesPage })),
);
const ProductsPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.ProductsPage })),
);
const ShoppingPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.ShoppingPage })),
);
const ProductAnalyticsPage = lazy(() =>
  import("./pages/insights").then((module) => ({
    default: module.ProductAnalyticsPage,
  })),
);
const AdsPage = lazy(() =>
  import("./pages/ads").then((module) => ({ default: module.AdsPage })),
);
const AdvertiserDetailPage = lazy(() =>
  import("./pages/ads").then((module) => ({ default: module.AdvertiserDetailPage })),
);
const AlertsPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.AlertsPage })),
);
const ExportsPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.ExportsPage })),
);
const UsersPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.UsersPage })),
);
const BillingPage = lazy(() => import("./pages/billing"));
const SettingsPage = lazy(() => import("./pages/settings"));
const OperatorPage = lazy(() => import("./pages/operator"));
const OperatorProvidersPage = lazy(() => import("./pages/operator-providers"));
const ProviderOnboardingPage = lazy(() => import("./pages/provider-onboarding"));
const OperatorPaymentsPage = lazy(() => import("./pages/operator-payments"));
const PaymentOnboardingPage = lazy(() => import("./pages/payment-onboarding"));
const OperatorCitationTrendsPage = lazy(() =>
  import("./pages/operator-insights").then((module) => ({
    default: module.OperatorCitationTrendsPage,
  })),
);
const OperatorSourceDiscoveryPage = lazy(() =>
  import("./pages/operator-insights").then((module) => ({
    default: module.OperatorSourceDiscoveryPage,
  })),
);
const OperatorFanOutTrendsPage = lazy(() =>
  import("./pages/operator-insights").then((module) => ({
    default: module.OperatorFanOutTrendsPage,
  })),
);
const ProjectOnboardingPage = lazy(() =>
  import("./pages/onboarding").then((module) => ({ default: module.ProjectOnboardingPage })),
);
const PromptOnboardingPage = lazy(() =>
  import("./pages/onboarding").then((module) => ({ default: module.PromptOnboardingPage })),
);

export function App() {
  const location = useLocation();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => api<{
      setupRequired: boolean;
      providerSetupRequired: boolean;
      paymentSetupRequired: boolean;
      emailDeliveryConfigured: boolean;
    }>("/status"),
  });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api<Session>("/auth/session"),
    enabled: !["/accept-invite", "/reset-password", "/signup"].includes(location.pathname),
    retry: false,
  });

  if (location.pathname === "/accept-invite") return <AcceptInvitePage />;
  if (location.pathname === "/reset-password") return <ResetPasswordPage />;
  if (location.pathname === "/signup") return <SignupPage />;
  if (status.isPending) return <AppLoader />;
  if (status.data?.setupRequired) return <SetupPage />;
  if (session.isPending) return <AppLoader />;
  if (
    session.error instanceof ApiClientError &&
    [401, 403].includes(session.error.status)
  ) {
    return <LoginPage emailDeliveryConfigured={status.data?.emailDeliveryConfigured ?? false} />;
  }
  if (!session.data) {
    return <LoginPage emailDeliveryConfigured={status.data?.emailDeliveryConfigured ?? false} />;
  }
  const operatorOnboardingPath = requiredOperatorOnboardingPath({
    isPlatformOperator: session.data.isPlatformOperator,
    pathname: location.pathname,
    paymentSetupRequired: status.data?.paymentSetupRequired ?? false,
    providerSetupRequired: status.data?.providerSetupRequired ?? false,
  });
  if (operatorOnboardingPath) return <DocumentRedirect to={operatorOnboardingPath} />;
  if (session.data.workspace.status === "pending_payment" && location.pathname !== "/billing") {
    return <Navigate to="/billing" replace />;
  }
  if (needsProjectOnboarding(session.data, location.pathname)) {
    return <Navigate to="/onboarding/project" replace />;
  }

  return (
    <AppProvider session={session.data}>
      <Suspense fallback={<AppLoader />}>
        <Routes>
          <Route
            path="/onboarding/provider"
            element={<DocumentRedirect to={OPERATOR_PROVIDER_ONBOARDING_PATH} />}
          />
          <Route
            path="/onboarding/payments"
            element={<DocumentRedirect to={OPERATOR_PAYMENT_ONBOARDING_PATH} />}
          />
          <Route
            path={OPERATOR_PROVIDER_ONBOARDING_PATH}
            element={<ProviderOnboardingPage />}
          />
          <Route
            path={OPERATOR_PAYMENT_ONBOARDING_PATH}
            element={<PaymentOnboardingPage />}
          />
          <Route path="/onboarding/project" element={<ProjectOnboardingPage />} />
          <Route path="/onboarding/prompts" element={<PromptOnboardingPage />} />
          <Route element={<AppLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="/ai-traffic/*" element={<TrafficPage />} />
            <Route path="/prompts" element={<PromptsPage />} />
            <Route path="/related-queries" element={<RelatedQueriesPage />} />
            <Route
              path="/related-queries/:queryKey"
              element={<RelatedQueryDetailPage />}
            />
            <Route path="/prompts/library" element={<PromptLibraryPage />} />
            <Route path="/prompts/:queryId" element={<QuerySnapshotsPage />} />
            <Route
              path="/prompts/:queryId/snapshots/:snapshotId"
              element={<SnapshotDetailPage />}
            />
            <Route path="/queries" element={<Navigate to="/prompts" replace />} />
            <Route path="/queries/:queryId" element={<QuerySnapshotsPage />} />
            <Route
              path="/queries/:queryId/snapshots/:snapshotId"
              element={<SnapshotDetailPage />}
            />
            <Route path="/snapshots" element={<SnapshotExplorerPage />} />
            <Route path="/snapshots/:snapshotId" element={<SnapshotDetailPage />} />
            <Route path="/domains" element={<DomainsPage />} />
            <Route path="/citations" element={<CitationSourcesPage />} />
            <Route path="/citations/:domain" element={<CitationSourceDetailPage />} />
            <Route path="/entities" element={<EntitiesPage />} />
            <Route path="/brands" element={<Navigate to="/entities" replace />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/ads" element={<AdsPage />} />
            <Route path="/ads/:advertiserKey" element={<AdvertiserDetailPage />} />
            <Route path="/shopping" element={<ShoppingPage />} />
            <Route
              path="/shopping/:productKey"
              element={<ProductAnalyticsPage />}
            />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/exports" element={<ExportsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/operator" element={session.data.isPlatformOperator ? <OperatorPage /> : <Navigate to="/" replace />} />
            <Route path="/operator/providers" element={session.data.isPlatformOperator ? <OperatorProvidersPage /> : <Navigate to="/" replace />} />
            <Route path="/operator/payments" element={session.data.isPlatformOperator ? <OperatorPaymentsPage /> : <Navigate to="/" replace />} />
            <Route path="/operator/insights/citations" element={session.data.isPlatformOperator ? <OperatorCitationTrendsPage /> : <Navigate to="/" replace />} />
            <Route path="/operator/insights/source-discovery" element={session.data.isPlatformOperator ? <OperatorSourceDiscoveryPage /> : <Navigate to="/" replace />} />
            <Route path="/operator/insights/fan-out" element={session.data.isPlatformOperator ? <OperatorFanOutTrendsPage /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </AppProvider>
  );
}

function DocumentRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return <AppLoader />;
}

function AppLoader() {
  return (
    <div className="app-loader">
      <div className="loader-brand"><span className="brand-mark"><AppIcon /></span> {APP_NAME}</div>
      <Skeleton className="loader-line" />
      <Skeleton className="loader-line short" />
    </div>
  );
}
