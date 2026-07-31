import { useQuery } from "@tanstack/react-query";
import {
  listClients,
  type ClientSummary,
} from "@/integrations/gcp/tenancy";

// Shared shape used by client cards, switchers, and navigation surfaces.
// RLS already filters rows to those the current user can see.
export type { ClientSummary };

export function useClients(enabled = true) {
  const query = useQuery({
    queryKey: ["clients"],
    enabled,
    queryFn: () => listClients(false),
  });

  return {
    clients: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
