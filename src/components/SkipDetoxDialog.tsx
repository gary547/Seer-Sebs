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
import type { BlockedDetox } from "@/hooks/useNavigatorSync";

interface Props {
  blocked: BlockedDetox | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Shown when Keyword Detox can't reach Anthropic (no credit, invalid key,
 * permission denied). Lets the user skip detox and promote every keyword to
 * `keep` so the rest of the pipeline (Categorisation → HAR → forecasts)
 * can continue without losing their manually curated keyword list.
 */
export default function SkipDetoxDialog({ blocked, onConfirm, onCancel }: Props) {
  const open = blocked !== null;
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Keyword Detox can't run right now</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>
                Anthropic returned:{" "}
                <span className="font-mono text-xs text-foreground">
                  {blocked?.message || "AI provider unavailable"}
                </span>
              </p>
              <p>
                You can skip detox and keep <strong>all current keywords</strong> as-is.
                They'll move straight into Categorisation, Enrichment and HAR — useful
                when your keyword list has already been manually reviewed.
              </p>
              <p className="text-muted-foreground">
                Or cancel, top up Anthropic credits, and click Sync Now to retry.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => { void onConfirm(); }}>
            Skip detox &amp; keep all keywords
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
