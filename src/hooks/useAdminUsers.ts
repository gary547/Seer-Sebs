import { useQuery } from "@tanstack/react-query";
import {
  listAdminUsers,
  type TargetAdminUser,
} from "@/integrations/gcp/admin-users";

export type AdminUser = TargetAdminUser;

export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: ["admin-users"],
    enabled,
    queryFn: listAdminUsers,
  });
}
