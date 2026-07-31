import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Plus, Sliders } from "lucide-react";
import { toast } from "sonner";
import { getProjectSummary } from "@/integrations/gcp/tenancy";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import ConversionOverridesTable from "@/components/admin/ConversionOverridesTable";
import ConversionOverrideFormDialog from "@/components/admin/ConversionOverrideFormDialog";
import {
  useConversionOverrides,
  useDeleteConversionOverride,
  type ConversionOverrideWithActor,
} from "@/hooks/useConversionOverrides";

export default function ConversionOverridesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { canManageUsers } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConversionOverrideWithActor | null>(null);
  const [toDelete, setToDelete] = useState<ConversionOverrideWithActor | null>(null);

  const { data: project } = useQuery({
    queryKey: ["conversion-overrides", "project-meta", projectId],
    enabled: !!projectId,
    queryFn: () => getProjectSummary(projectId as string),
  });

  const { data: rows, isLoading } = useConversionOverrides(projectId);
  const del = useDeleteConversionOverride(projectId ?? "");

  const sortedRows = useMemo(() => rows ?? [], [rows]);

  const backHref = project?.client_id
    ? `/clients/${project.client_id}/projects/${projectId}/overview`
    : "/admin/calculations";

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="-ml-2 h-7 text-xs text-muted-foreground"
          >
            <Link to={backHref}>
              <ArrowLeft className="mr-1 h-3 w-3" />
              Back
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Sliders className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">Conversion overrides</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {project?.project_name ?? "Project"}
            {project?.client_name ? ` · ${project.client_name}` : ""}
          </p>
        </div>
        {canManageUsers && (
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            New override
          </Button>
        )}
      </header>

      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="pt-4 pb-4 text-sm">
          <p>
            Overrides are applied on the next forecast calculation, with URL taking
            precedence over category, intent and project defaults. Notes are required for
            URL and category overrides because those assumptions can materially change
            forecasts.
          </p>
          {!canManageUsers && (
            <p className="mt-2 text-muted-foreground">
              You have read-only access. Ask an admin to add or edit overrides.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Existing overrides</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <ConversionOverridesTable
              rows={sortedRows}
              canWrite={canManageUsers}
              onEdit={(r) => {
                setEditing(r);
                setDialogOpen(true);
              }}
              onDelete={(r) => setToDelete(r)}
            />
          )}
        </CardContent>
      </Card>

      {projectId && (
        <ConversionOverrideFormDialog
          projectId={projectId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editing={editing}
        />
      )}

      <AlertDialog open={!!toDelete} onOpenChange={(v) => !v && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this override?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the override permanently. The next forecast calculation will
              fall back to the next matching scope or the project defaults.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!toDelete) return;
                try {
                  await del.mutateAsync(toDelete.id);
                  toast.success("Override deleted");
                } catch (e: any) {
                  toast.error(`Delete failed: ${e?.message ?? String(e)}`);
                } finally {
                  setToDelete(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
