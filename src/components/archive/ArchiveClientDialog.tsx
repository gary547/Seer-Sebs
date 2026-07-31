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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useArchiveClient } from "@/hooks/useArchiveActions";
import { useCanArchive } from "@/hooks/useCanArchive";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string | null;
  clientName?: string | null;
  onArchived?: () => void;
}

const MAX_REASON = 280;

export function ArchiveClientDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
  onArchived,
}: Props) {
  const { canArchive } = useCanArchive();
  const { mutateAsync, isPending } = useArchiveClient();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  if (!canArchive) return null;

  const handleConfirm = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!clientId) return;
    try {
      await mutateAsync({
        clientId,
        reason: reason.trim() ? reason.trim() : null,
        clientName: clientName ?? null,
      });
      onArchived?.();
      onOpenChange(false);
    } catch {
      // toast handled in hook
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => !isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Archive {clientName ?? "this client"}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                All Seer® projects, keywords, forecasts, content plans and URL Monitor
                data for this client will be hidden from the live workspace.
              </p>
              <p className="text-muted-foreground">
                Admins can review or restore archived clients from the Archive area at
                any time. Nothing is permanently deleted.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="archive-client-reason" className="text-xs uppercase tracking-wider text-muted-foreground">
            Reason (optional)
          </Label>
          <Textarea
            id="archive-client-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON))}
            placeholder="e.g. Engagement ended Q2"
            disabled={isPending}
            rows={3}
          />
          <div className="text-[11px] text-muted-foreground text-right">
            {reason.length}/{MAX_REASON}
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isPending || !clientId}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {isPending ? "Archiving…" : "Archive client"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default ArchiveClientDialog;
