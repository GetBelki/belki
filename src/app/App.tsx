import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppProvider } from "./context";
import { ApiClientError, api, type Session } from "./lib/api";
import { AppLayout } from "./components/layout";
import { AcceptInvitePage, LoginPage, ResetPasswordPage, SetupPage } from "./pages/auth";
import { Skeleton } from "./components/ui";

const OverviewPage = lazy(() =>
  import("./pages/main").then((module) => ({ default: module.OverviewPage })),
);
const QueriesPage = lazy(() =>
  import("./pages/main").then((module) => ({ default: module.QueriesPage })),
);
const SnapshotExplorerPage = lazy(() =>
  import("./pages/main").then((module) => ({ default: module.SnapshotExplorerPage })),
);
const DomainsPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.DomainsPage })),
);
const BrandsPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.BrandsPage })),
);
const ProductsPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.ProductsPage })),
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
const SettingsPage = lazy(() =>
  import("./pages/insights").then((module) => ({ default: module.SettingsPage })),
);

export function App() {
  const location = useLocation();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => api<{ setupRequired: boolean }>("/status"),
  });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api<Session>("/auth/session"),
    enabled: status.data?.setupRequired === false && location.pathname !== "/accept-invite",
    retry: false,
  });

  if (location.pathname === "/accept-invite") return <AcceptInvitePage />;
  if (location.pathname === "/reset-password") return <ResetPasswordPage />;
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

  return (
    <AppProvider session={session.data}>
      <Suspense fallback={<AppLoader />}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="/queries" element={<QueriesPage />} />
            <Route path="/snapshots" element={<SnapshotExplorerPage />} />
            <Route path="/domains" element={<DomainsPage />} />
            <Route path="/brands" element={<BrandsPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/exports" element={<ExportsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/settings" element={<SettingsPage />} />
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
      <div className="loader-brand"><span className="brand-mark">A</span> AI Tracker</div>
      <Skeleton className="loader-line" />
      <Skeleton className="loader-line short" />
    </div>
  );
}
