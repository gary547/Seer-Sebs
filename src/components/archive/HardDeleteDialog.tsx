import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCanArchive } from "@/hooks/useCanArchive";

interface HardDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "client" | "project";
  entityName: string;
  isPending: boolean;
  onConfirm: () => Promise<void> | void;
}

/**
 * Destructive confirmation dialog requiring the admin to type the entity
 * name before the destructive action is enabled. Used for hard-deletion of
 * archived clients and projects.
 */
export function HardDeleteDialog({
  open,
  onOpenChange,
  scope,
  entityName,
  isPending,
  onConfirm,
}: HardDeleteDialogProps) {
  const { canHardDelete } = useCanArchive();
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  if (!canHardDelete) return null;

  const matches = typed.trim() === entityName.trim() && entityName.trim().length > 0;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Permanently delete {scope} "{entityName}"?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p className="text-destructive font-medium">
                This action cannot be undone.
              </p>
              <p className="text-muted-foreground">
                All related projects, keywords, forecasts, content plans, monitor
                campaigns and historical snapshots will be permanently removed.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="hard-delete-confirm" className="text-xs uppercase tracking-wider text-muted-foreground">
            Type <span className="font-mono text-foreground">{entityName}</span> to confirm
          </Label>
          <Input
            id="hard-delete-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={isPending}
            autoComplete="off"
            autoFocus
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              if (!matches) return;
              void onConfirm();
            }}
            disabled={isPending || !matches}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {isPending ? "Deleting…" : `Permanently delete ${scope}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default HardDeleteDialog;
