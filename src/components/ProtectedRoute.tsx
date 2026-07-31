import { Navigate, useLocation } from "react-router";
import { useAuth } from "@/contexts/AuthContext";
import type { AppRole } from "@/contexts/AuthContext";

interface ProtectedRouteProps {
  children: React.ReactNode;
  /**
   * Restrict the route to a specific set of roles. When omitted, any
   * approved authenticated user is allowed.
   */
  requireRole?: Array<AppRole>;
}

export default function ProtectedRoute({ children, requireRole }: ProtectedRouteProps) {
  const { user, loading, approvalStatus, role } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!user) {
    // UX-002 (Phase H2): preserve the requested destination so AuthPage can
    // bounce the user back after a successful sign-in.
    return <Navigate to="/auth" replace state={{ from: location }} />;
  }

  if (approvalStatus !== "approved") {
    return <Navigate to="/pending-approval" replace />;
  }

  if (requireRole && requireRole.length > 0) {
    if (!role || !requireRole.includes(role)) {
      return <Navigate to="/dashboard" replace />;
    }
  }

  return <>{children}</>;
}
