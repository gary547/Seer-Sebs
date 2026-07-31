import { useAuth } from "@/contexts/AuthContext";

/**
 * Pure derivation of archive privileges from AuthContext.
 * No network calls. Source of truth for "can this user archive / hard-delete?".
 *
 * Both archive and hard-delete map to admin / super_admin. Hard-delete adds a
 * typed-name confirmation in the UI (Phase E); this hook only gates capability.
 */
export function useCanArchive() {
  const { role, isApproved } = useAuth();
  const isAdminScope = isApproved && (role === "admin" || role === "super_admin");
  return {
    canArchive: isAdminScope,
    canHardDelete: isAdminScope,
    isAdminScope,
  };
}
