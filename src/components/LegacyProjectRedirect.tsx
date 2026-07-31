import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router";
import { getProjectSummary } from "@/integrations/gcp/tenancy";
import { dashboardPath, projectHome } from "@/lib/routes";

/**
 * Legacy /navigator/:id → /clients/:clientId/projects/:id redirect.
 * The authenticated API resolves access before returning the project.
 */
export default function LegacyProjectRedirect() {
  const { id } = useParams<{ id: string }>();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!id) {
      setTarget(dashboardPath());
      return;
    }
    (async () => {
      const project = await getProjectSummary(id).catch(() => null);
      if (!active) return;
      if (project?.client_id) {
        setTarget(projectHome(project.client_id, project.id));
      } else {
        setTarget(dashboardPath());
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  if (!target) {
    return <div className="min-h-[40vh]" aria-busy="true" />;
  }
  return <Navigate to={target} replace />;
}
