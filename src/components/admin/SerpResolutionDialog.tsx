import { useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { approveSerpExclusions, getSerpResolution, type SerpResolution } from "@/integrations/gcp/pipeline";

export default function SerpResolutionDialog({ runId, disabled, onResume }: {
  runId: string; disabled: boolean; onResume: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<SerpResolution | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function showReview() {
    setOpen(true); setConfirmed(false); setReview(null); setError(null); setBusy(true);
    try { setReview(await getSerpResolution(runId)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The affected queries could not be loaded."); }
    finally { setBusy(false); }
  }

  async function approveAndResume() {
    if (!review || !confirmed || busy) return;
    setBusy(true); setError(null);
    try {
      await approveSerpExclusions(runId, review.keywords.map(keyword => keyword.id));
      await onResume();
      setOpen(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The pipeline could not resume."); }
    finally { setBusy(false); }
  }

  return <>
    <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void showReview()}>
      <TriangleAlert className="mr-2 h-4 w-4" />Review queries without results
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review forecast exclusions</DialogTitle>
          <DialogDescription>These searches returned no results. Review the complete affected scope before continuing from saved progress.</DialogDescription>
        </DialogHeader>
        {busy && !review ? <p className="py-6 text-sm text-ink-muted" role="status">Loading affected queries…</p> : null}
        {review ? <div className="space-y-4">
          <div className="rounded-lg border border-hairline bg-canvas p-4">
            <p className="font-semibold text-ink">{review.queryCount} searches · {review.keywordCount} keywords excluded from forecasts</p>
            <p className="mt-1 text-xs font-semibold text-ink">{review.remainingKeywordCount.toLocaleString()} keywords remain in the forecast scope.</p>
            <p className="mt-1 text-xs leading-5 text-ink-muted">The scope includes variants sharing these search results. Original queries, qualification decisions and saved provider results remain available.</p>
          </div>
          <ul className="max-h-64 divide-y divide-hairline overflow-y-auto rounded-lg border border-hairline px-4">
            {review.keywords.map(keyword => <li key={keyword.id} className="py-3">
              <p className="break-words text-sm text-ink">{keyword.text}</p>
              {keyword.id !== keyword.sourceKeywordId ? <p className="mt-1 break-words text-xs text-ink-muted">Shares search results with: {keyword.query}</p> : null}
            </li>)}
          </ul>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-hairline p-3 text-sm leading-5 text-ink">
            <Checkbox checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} disabled={busy} />
            <span>I approve excluding these keywords from this run's forecasts. They will appear as excluded in the results export, with unavailable forecast values.</span>
          </label>
        </div> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!review || !confirmed || busy} onClick={() => void approveAndResume()}>{busy && review ? "Resuming…" : "Exclude and resume"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
