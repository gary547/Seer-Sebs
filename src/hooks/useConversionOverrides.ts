import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteConversionOverride,
  listConversionOverrides,
  upsertConversionOverride,
  type ConversionOverrideRecord,
} from "@/integrations/gcp/admin-reference";

export type ConversionOverrideRow = ConversionOverrideRecord;

export type ConversionOverrideWithActor = ConversionOverrideRow & {
  created_by_email?: string | null;
  updated_by_email?: string | null;
};

const KEY = (projectId: string) => ["conversion-overrides", projectId] as const;

export function useConversionOverrides(projectId: string | undefined) {
  return useQuery({
    queryKey: KEY(projectId ?? ""),
    enabled: !!projectId,
    queryFn: () => listConversionOverrides(projectId as string),
  });
}

export type UpsertPayload = {
  id?: string;
  project_id: string;
  scope_type: "project" | "url" | "category" | "intent";
  scope_value: string | null;
  conversion_rate: number | null;
  average_order_value: number | null;
  confidence: "low" | "medium" | "high";
  note: string | null;
};

export function useUpsertConversionOverride(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpsertPayload) => {
      await upsertConversionOverride({
        ...payload,
        scope_value:
          payload.scope_type === "project" ? null : payload.scope_value,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(projectId) }),
  });
}

export function useDeleteConversionOverride(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await deleteConversionOverride(id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(projectId) }),
  });
}
