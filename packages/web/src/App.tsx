import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SentryProvider, SentryErrorBoundary } from "./contexts/SentryContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { AppConfigProvider, useAppConfig } from "./contexts/AppConfigContext";
import { Layout } from "./components/Layout";
import { AdminLayout } from "./components/AdminLayout";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";

import { SettingsPage } from "./pages/SettingsPage";
import { InvitePage } from "./pages/InvitePage";
import { SetupPage } from "./pages/SetupPage";
import { ProductBrandProvider, Toaster, TooltipProvider, useProductBrand } from "@easytestdata/ui";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Component, lazy, Suspense, useEffect, type ReactNode, type ReactElement } from "react";
import { connectErrorMessage } from "./connect-errors";
import extensions from "@easytestdata/web-extensions";
import { brand } from "./brand";

export { connectErrorMessage };

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30 * 1000 }
  }
});

const AdminDashboard = lazy(() =>
  import("./pages/admin/AdminDashboard").then((module) => ({ default: module.AdminDashboard }))
);
const UserManagementPage = lazy(() =>
  import("./pages/admin/UserManagementPage").then((module) => ({
    default: module.UserManagementPage
  }))
);
const UserDetailPage = lazy(() =>
  import("./pages/admin/UserDetailPage").then((module) => ({ default: module.UserDetailPage }))
);
const JobManagementPage = lazy(() =>
  import("./pages/admin/JobManagementPage").then((module) => ({
    default: module.JobManagementPage
  }))
);
const JobDetailPage = lazy(() =>
  import("./pages/admin/JobDetailPage").then((module) => ({ default: module.JobDetailPage }))
);
const ConnectionHealthPage = lazy(() =>
  import("./pages/admin/ConnectionHealthPage").then((module) => ({
    default: module.ConnectionHealthPage
  }))
);

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { name } = useProductBrand();
  const { user, loading } = useAuth();
  const { deployment } = useAppConfig();
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("connected") === "true") {
      toast.success("QuickBooks connected successfully!");
      window.history.replaceState({}, "", location.pathname);
    }
    const errorMsg = params.get("error");
    if (errorMsg) {
      toast.error(connectErrorMessage(errorMsg));
      window.history.replaceState({}, "", location.pathname);
    }
  }, [location.search, location.pathname]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  // Local mode has no sign-in page to send anyone to: the built-in user failed to load.
  if (!user && deployment === "local") {
    return (
      <div className="flex h-screen items-center justify-center p-6 text-center">
        <p className="text-lg text-muted-foreground">
          Could not reach the local {name} server. Check that it is still running, then refresh the
          page.
        </p>
      </div>
    );
  }
  if (!user) {
    const destination = location.pathname + location.search + location.hash;
    return <Navigate to={`/login?next=${encodeURIComponent(destination)}`} replace />;
  }
  return <>{children}</>;
}

function RouteLoadingFallback() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

class StaticErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactElement },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

const errorFallback = (
  <div className="flex h-screen items-center justify-center">
    <p className="text-lg text-muted-foreground">Something went wrong. Please refresh the page.</p>
  </div>
);

/**
 * Invite links go to the invite page; local mode, and a build whose brand turns teams off, have
 * no invites, so they go home.
 */
function InviteRoute() {
  const { deployment } = useAppConfig();
  return deployment === "local" || brand.teams === false ? (
    <Navigate to="/home" replace />
  ) : (
    <InvitePage />
  );
}

// Extension pages that need no sign-in live under /p/, which is theirs alone: a signed-in route
// there could catch a public address first and send a signed-out visitor to the login page.
// React Router matches paths case-insensitively, so /P/ counts as /p/.
const inPublicSpace = (path: string) => {
  const lower = path.toLowerCase();
  return lower === "/p" || lower.startsWith("/p/");
};
const publicRoutes = extensions.publicRoutes ?? [];
for (const route of publicRoutes) {
  if (!inPublicSpace(route.path) || route.path === "/p") {
    throw new Error(`Public extension route ${route.path} must start with /p/`);
  }
}
for (const route of extensions.routes) {
  if (inPublicSpace(route.path)) {
    throw new Error(`Extension route ${route.path} must not use /p/, which is for public pages`);
  }
}

/** First-run Intuit keys setup exists only in local mode; Cloud reads the keys from its env. */
function SetupRoute() {
  const { deployment } = useAppConfig();
  return deployment === "local" ? <SetupPage /> : <Navigate to="/home" replace />;
}

export function App() {
  return (
    <StaticErrorBoundary fallback={errorFallback}>
      <QueryClientProvider client={queryClient}>
        <AppConfigProvider>
          <SentryProvider>
            <AuthProvider>
              <TooltipProvider delayDuration={300}>
                <SentryErrorBoundary fallback={errorFallback}>
                  <ProductBrandProvider value={brand}>
                    <BrowserRouter>
                      <Routes>
                        {/* Public extension pages first: when a signed-in pattern ties with a
                            public one (an optional segment, a parameter), React Router picks the
                            first declared, so a public page is never sent to the login page. */}
                        {publicRoutes.map((route) => {
                          const Element = route.element;
                          return (
                            <Route
                              key={route.path}
                              path={route.path}
                              element={
                                <Suspense fallback={<RouteLoadingFallback />}>
                                  <Element />
                                </Suspense>
                              }
                            />
                          );
                        })}
                        <Route path="/login" element={<LoginPage />} />
                        <Route path="/invite" element={<InviteRoute />} />
                        {/* Main app routes */}
                        <Route
                          element={
                            <ProtectedRoute>
                              <Layout />
                            </ProtectedRoute>
                          }
                        >
                          <Route path="/home" element={<HomePage />} />
                          <Route path="/setup" element={<SetupRoute />} />
                          <Route path="/settings" element={<SettingsPage />} />
                          <Route path="/settings/:section" element={<SettingsPage />} />
                          {extensions.routes.map((route) => {
                            const Element = route.element;
                            return (
                              <Route
                                key={route.path}
                                path={route.path}
                                element={
                                  <Suspense fallback={<RouteLoadingFallback />}>
                                    <Element />
                                  </Suspense>
                                }
                              />
                            );
                          })}
                        </Route>
                        {/* Admin routes */}
                        <Route
                          element={
                            <ProtectedRoute>
                              <Suspense fallback={<RouteLoadingFallback />}>
                                <AdminLayout />
                              </Suspense>
                            </ProtectedRoute>
                          }
                        >
                          <Route path="/admin" element={<AdminDashboard />} />
                          <Route path="/admin/users" element={<UserManagementPage />} />
                          <Route path="/admin/users/:id" element={<UserDetailPage />} />
                          <Route path="/admin/jobs" element={<JobManagementPage />} />
                          <Route path="/admin/jobs/:id" element={<JobDetailPage />} />
                          <Route path="/admin/connections" element={<ConnectionHealthPage />} />
                        </Route>
                        <Route path="*" element={<Navigate to="/home" replace />} />
                      </Routes>
                    </BrowserRouter>
                  </ProductBrandProvider>
                </SentryErrorBoundary>
                <Toaster position="bottom-right" richColors closeButton />
              </TooltipProvider>
            </AuthProvider>
          </SentryProvider>
        </AppConfigProvider>
      </QueryClientProvider>
    </StaticErrorBoundary>
  );
}
