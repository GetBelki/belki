import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppProvider } from "./context";
import { ApiClientError, api, type Session } from "./lib/api";
import { AppLayout } from "./components/layout";
import { AcceptInvitePage, LoginPage, ResetPasswordPage, SetupPage, SignupPage } from "./pages/auth";
import { Skeleton } from "./components/ui";
import { AppIcon } from "./components/app-icon";
import { APP_NAME } from "./lib/branding";

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
const BrandsPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.BrandsPage })),
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

export function App() {
  const location = useLocation();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => api<{ setupRequired: boolean }>("/status"),
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
    return <LoginPage />;
  }
  if (!session.data) return <LoginPage />;
  if (session.data.workspace.status === "pending_payment" && location.pathname !== "/billing") {
    return <Navigate to="/billing" replace />;
  }

  return (
    <AppProvider session={session.data}>
      <Suspense fallback={<AppLoader />}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<OverviewPage />} />
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
            <Route path="/brands" element={<BrandsPage />} />
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </AppProvider>
  );
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
