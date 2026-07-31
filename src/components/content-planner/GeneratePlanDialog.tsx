import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { generateContentPlan } from "@/integrations/gcp/content-plans";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type Mix = { hero: number; blog: number; page: number; category: number; product: number };

interface SelectedKeyword {
  keywordId: string;
  keyword: string;
  clientId: string | null;
  projectId: string;
  projectName: string;
  clientName: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selected: SelectedKeyword[];
}

export function GeneratePlanDialog({ open, onOpenChange, selected }: Props) {
  const navigate = useNavigate();
  const [name, setName] = useState(`Q${Math.floor(new Date().getMonth() / 3) + 1} ${new Date().getFullYear()} content plan`);
  const [mix, setMix] = useState<Mix>({ hero: 2, blog: 6, page: 2, category: 1, product: 1 });
  const [defaultLeadWeeks, setDefaultLeadWeeks] = useState(12);
  const [heroLeadWeeks, setHeroLeadWeeks] = useState(16);
  const [submitting, setSubmitting] = useState(false);

  // Group selected by client+project (one plan must target a single client/project).
  const groups = useMemo(() => {
    const m = new Map<string, { clientId: string; projectId: string; clientName: string; projectName: string; ids: string[] }>();
    for (const s of selected) {
      if (!s.clientId) continue;
      const key = `${s.clientId}|${s.projectId}`;
      const existing = m.get(key) ?? {
        clientId: s.clientId,
        projectId: s.projectId,
        clientName: s.clientName ?? "—",
        projectName: s.projectName,
        ids: [],
      };
      existing.ids.push(s.keywordId);
      m.set(key, existing);
    }
    return Array.from(m.values());
  }, [selected]);

  const [target, setTarget] = useState<string>("");
  const targetGroup = groups.find((g) => `${g.clientId}|${g.projectId}` === target) ?? groups[0];
  const total = mix.hero + mix.blog + mix.page + mix.category + mix.product;
  const valid = total === 12 && !!targetGroup && targetGroup.ids.length > 0;

  async function submit() {
    if (!targetGroup) return;
    setSubmitting(true);
    try {
      const data = await generateContentPlan({
        clientId: targetGroup.clientId,
        projectId: targetGroup.projectId,
        name,
        keywordIds: targetGroup.ids,
        mix,
        defaultLeadWeeks,
        heroLeadWeeks,
      });
      const planId = data.planId;
      if (!planId) throw new Error("Generation finished without a plan id");
      toast.success("Content plan created", { description: `${data.items} items briefed and ready for review.` });
      onOpenChange(false);
      navigate(`/content-plans/${planId}`);
    } catch (e: any) {
      console.error(e);
      toast.error("Couldn't generate plan", { description: e?.message ?? "Unknown error" });
    } finally {
      setSubmitting(false);
    }
  }

  function MixField({ k, label }: { k: keyof Mix; label: string }) {
    return (
      <div className="space-y-1">
        <Label className="text-[11px] uppercase tracking-wider text-ink-muted">{label}</Label>
        <Input
          type="number"
          min={0}
          max={12}
          value={mix[k]}
          onChange={(e) => setMix({ ...mix, [k]: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })}
          className="h-9"
        />
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Generate 3-month content plan</DialogTitle>
          <DialogDescription>
            Build a 12-piece editorial calendar from {selected.length} selected keyword{selected.length === 1 ? "" : "s"}.
            Pieces back-date from peak − 8 weeks, and the plan is briefed by default.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>Plan name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {groups.length > 1 ? (
            <div className="space-y-1">
              <Label>Client / project</Label>
              <Select value={target || `${groups[0].clientId}|${groups[0].projectId}`} onValueChange={setTarget}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={`${g.clientId}|${g.projectId}`} value={`${g.clientId}|${g.projectId}`}>
                      {g.clientName} · {g.projectName} ({g.ids.length} kw)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-ink-muted">A plan targets one project. Only the chosen group's keywords are used.</p>
            </div>
          ) : targetGroup ? (
            <div className="rounded-md border border-hairline bg-secondary/40 p-3 text-[12.5px]">
              <span className="text-ink-muted">Target:</span>{" "}
              <span className="font-medium">{targetGroup.clientName}</span> ·{" "}
              <span className="text-ink-muted">{targetGroup.projectName}</span>{" "}
              <span className="text-ink-muted">· {targetGroup.ids.length} keywords</span>
            </div>
          ) : (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-[12.5px] text-ink">
              Select keywords with an assigned client to generate a plan.
            </div>
          )}

          <div>
            <Label className="text-[11px] uppercase tracking-wider text-ink-muted">Mix (must total 12)</Label>
            <div className="mt-2 grid grid-cols-5 gap-2">
              <MixField k="hero" label="Hero" />
              <MixField k="blog" label="Blog" />
              <MixField k="page" label="Page" />
              <MixField k="category" label="Category" />
              <MixField k="product" label="Product" />
            </div>
            <p className={`mt-1 text-[11px] ${total === 12 ? "text-ink-muted" : "text-amber-600"}`}>Total: {total} / 12</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Default lead time (weeks)</Label>
              <Input type="number" min={1} value={defaultLeadWeeks} onChange={(e) => setDefaultLeadWeeks(Number(e.target.value) || 12)} />
            </div>
            <div className="space-y-1">
              <Label>Hero lead time (weeks)</Label>
              <Input type="number" min={1} value={heroLeadWeeks} onChange={(e) => setHeroLeadWeeks(Number(e.target.value) || 16)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button variant="signal" onClick={submit} disabled={!valid || submitting}>
            {submitting ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…</> : "Generate plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
