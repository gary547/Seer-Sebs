import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/hooks/useTheme";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppLayout from "@/components/AppLayout";
import ErrorBoundary from "@/components/ErrorBoundary";
import ResetPasswordPage from "@/pages/ResetPasswordPage";

import NavigatorProjectDetailPage from "@/pages/NavigatorProjectDetailPage";
import LegacyProjectRedirect from "@/components/LegacyProjectRedirect";
import ProjectWorkspaceLayout from "@/pages/ProjectWorkspaceLayout";

const ClientsPage = lazy(() => import("@/pages/ClientsPage"));
const ClientOnboardingPage = lazy(() => import("@/pages/ClientOnboardingPage"));
const NavigatorProjectFormPage = lazy(() => import("@/pages/NavigatorProjectFormPage"));
const AudienceInsightsPage = lazy(() => import("@/pages/AudienceInsightsPage"));
const ReferenceDataPage = lazy(() => import("@/pages/ReferenceDataPage"));
const AuthPage = lazy(() => import("@/pages/AuthPage"));
const AccountPage = lazy(() => import("@/pages/AccountPage"));
const UsersPage = lazy(() => import("@/pages/admin/UsersPage"));
const CategoriesPage = lazy(() => import("@/pages/admin/CategoriesPage"));
const CalculationsPage = lazy(() => import("@/pages/admin/CalculationsPage"));
const ConversionOverridesPage = lazy(() => import("@/pages/admin/ConversionOverridesPage"));
const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const ClientDashboardPage = lazy(() => import("@/pages/ClientDashboardPage"));
const ProjectOverviewPage = lazy(() => import("@/pages/project/ProjectOverviewPage"));
const CaptureWindowPage = lazy(() => import("@/pages/CaptureWindowPage"));
const ContentPlansPage = lazy(() => import("@/pages/ContentPlansPage"));
const ContentPlanDetailPage = lazy(() => import("@/pages/ContentPlanDetailPage"));
const UrlMonitorOverviewPage = lazy(() => import("@/pages/tools/UrlMonitorOverviewPage"));
const UrlMonitorCampaignFormPage = lazy(() => import("@/pages/tools/UrlMonitorCampaignFormPage"));
const UrlMonitorCampaignDetailPage = lazy(() => import("@/pages/tools/UrlMonitorCampaignDetailPage"));
const ArchivePage = lazy(() => import("@/pages/admin/ArchivePage"));
const ArchiveClientPage = lazy(() => import("@/pages/admin/ArchiveClientPage"));
const ArchiveProjectPage = lazy(() => import("@/pages/admin/ArchiveProjectPage"));
const PendingApprovalPage = lazy(() => import("@/pages/PendingApprovalPage"));
const NotFound = lazy(() => import("@/pages/NotFound"));

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <ThemeProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <ErrorBoundary scope="application">
            <Suspense fallback={<div className="min-h-screen bg-background" />}>
              <Routes>
              <Route path="/auth" element={<AuthPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/pending-approval" element={<PendingApprovalPage />} />
              <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/capture-window" element={<CaptureWindowPage />} />
                <Route path="/content-plans" element={<ContentPlansPage />} />
                <Route path="/content-plans/:id" element={<ContentPlanDetailPage />} />
                <Route path="/clients" element={<ClientsPage />} />
                <Route path="/clients/new" element={<ClientOnboardingPage />} />
                <Route path="/clients/:id/edit" element={<ClientOnboardingPage />} />
                {/* Canonical client/project shells — internals unchanged for now. */}
                <Route path="/clients/:clientId" element={<ClientDashboardPage />} />
                <Route path="/clients/:clientId/projects/new" element={<NavigatorProjectFormPage />} />
                <Route path="/clients/:clientId/projects/:id" element={<ProjectWorkspaceLayout />}>
                  <Route index element={<ProjectOverviewPage />} />
                  {/* Project-scoped content plans inbox (filtered by project_id). */}
                  <Route path="content-plans" element={<ContentPlansPage />} />
                  {/* Single route element keeps NavigatorProjectDetailPage mounted across
                      tab swaps so useNavigatorSync state is not torn down between views. */}
                  <Route path=":view" element={<NavigatorProjectDetailPage />} />
                </Route>
                <Route path="/navigator" element={<Navigate to="/dashboard" replace />} />
                <Route path="/navigator/new" element={<NavigatorProjectFormPage />} />
                <Route path="/navigator/:id" element={<LegacyProjectRedirect />} />
                <Route path="/audience-insights" element={<AudienceInsightsPage />} />
                <Route path="/reference-data" element={<ReferenceDataPage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/admin/users" element={<UsersPage />} />
                <Route path="/admin/categories" element={<CategoriesPage />} />
                <Route path="/admin/calculations" element={<CalculationsPage />} />
                <Route
                  path="/admin/projects/:projectId/conversion-overrides"
                  element={<ConversionOverridesPage />}
                />
                <Route path="/tools/url-monitor" element={<UrlMonitorOverviewPage />} />
                <Route path="/tools/url-monitor/campaigns/new" element={<UrlMonitorCampaignFormPage />} />
                <Route path="/tools/url-monitor/campaigns/:id" element={<UrlMonitorCampaignDetailPage />} />
                {/* Phase D — Admin-only archive surface */}
                <Route
                  path="/archive"
                  element={
                    <ProtectedRoute requireRole={["admin", "super_admin"]}>
                      <ArchivePage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/archive/clients/:clientId"
                  element={
                    <ProtectedRoute requireRole={["admin", "super_admin"]}>
                      <ArchiveClientPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/archive/clients/:clientId/projects/:projectId"
                  element={
                    <ProtectedRoute requireRole={["admin", "super_admin"]}>
                      <ArchiveProjectPage />
                    </ProtectedRoute>
                  }
                />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          </ErrorBoundary>
        </BrowserRouter>
      </TooltipProvider>
      </ThemeProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
