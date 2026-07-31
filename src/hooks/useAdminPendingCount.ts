import { useMemo } from "react";
import { useAdminUsers } from "@/hooks/useAdminUsers";

/**
 * Unified pending-approval count used by both AppSidebar and the
 * admin Users page. Reuses the shared `["admin-users"]` React Query
 * cache so any mutation that invalidates it (approve / reject /
 * role change) re-renders both surfaces in lock-step.
 */
export function useAdminPendingCount(enabled = true) {
  const { data, isLoading, refetch } = useAdminUsers(enabled);
  const count = useMemo(
    () => (data ?? []).filter((u) => u.approval_status === "pending").length,
    [data],
  );
  return { count, isLoading, refetch };
}
