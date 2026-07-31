import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { createMonitorCampaign } from "@/integrations/gcp/url-monitor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft } from "lucide-react";
import { useClients } from "@/hooks/useClients";
import { useNavigatorProjects } from "@/hooks/useNavigatorProjects";
import { listEligibleClientOwners } from "@/integrations/gcp/tenancy";

export default function UrlMonitorCampaignFormPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { clients } = useClients();
  const { projects } = useNavigatorProjects();
  const [owners, setOwners] = useState<{ id: string; label: string }[]>([]);
  const [loadingOwners, setLoadingOwners] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    client_id: "",
    navigator_project_id: "",
    name: "",
    description: "",
    owner: "",
    check_frequency: "24h",
    daily_check_time: "07:00",
  });

  const projectsForClient = projects.filter((p) => p.client_id === form.client_id);

  // Load eligible owners whenever the client changes: union of users with explicit
  // access to that client + internal team members (super_admin/admin/user).
  useEffect(() => {
    if (!form.client_id) {
      setOwners([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingOwners(true);
      try {
        const list = (await listEligibleClientOwners(form.client_id))
          .map((owner) => ({
            id: owner.id,
            label: owner.full_name?.trim() || owner.email || owner.id,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
        if (!cancelled) {
          setOwners(list);
          if (form.owner && !list.some((owner) => owner.label === form.owner)) {
            setForm((current) => ({ ...current, owner: "" }));
          }
        }
      } catch {
        if (!cancelled) setOwners([]);
      } finally {
        if (!cancelled) setLoadingOwners(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.client_id]);

  const submit = async () => {
    if (!form.client_id || !form.name) {
      toast({ title: "Missing fields", description: "Client and name are required.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const created = await createMonitorCampaign({
      clientId: form.client_id,
      projectId: form.navigator_project_id || null,
      name: form.name,
      description: form.description || null,
      owner: form.owner || null,
      checkFrequency: form.check_frequency,
      dailyCheckTime: form.daily_check_time,
      });
      toast({ title: "Campaign created" });
      navigate(`/tools/url-monitor/campaigns/${created.campaign.id}`);
    } catch (error) {
      toast({
        title: "Could not create campaign",
        description: error instanceof Error ? error.message : "The campaign could not be created.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <Button variant="ghost" size="sm" onClick={() => navigate("/tools/url-monitor")} className="-ml-2">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back
      </Button>
      <header>
        <div className="type-eyebrow">Tools / URL Monitor</div>
        <h1 className="type-headline-lg mt-1">New monitoring campaign</h1>
      </header>

      <Card className="p-5 space-y-4">
        <div className="space-y-1.5">
          <Label>Client *</Label>
          <Select value={form.client_id} onValueChange={(v) => setForm({ ...form, client_id: v, navigator_project_id: "" })}>
            <SelectTrigger><SelectValue placeholder="Select a client" /></SelectTrigger>
            <SelectContent>
              {clients.map((c) => <SelectItem key={c.id} value={c.id}>{c.company_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Campaign name *</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Spring 2026 Launch" />
        </div>

        <div className="space-y-1.5">
          <Label>Link to a Seer project (optional)</Label>
          <Select
            value={form.navigator_project_id || "none"}
            onValueChange={(v) => setForm({ ...form, navigator_project_id: v === "none" ? "" : v })}
            disabled={!form.client_id}
          >
            <SelectTrigger><SelectValue placeholder={form.client_id ? "Optional" : "Select a client first"} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No link — isolated campaign</SelectItem>
              {projectsForClient.map((p) => <SelectItem key={p.id} value={p.id}>{p.project_name}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-ink-muted">DB-only link for now; no Seer integration yet.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Check cadence</Label>
            <Select value={form.check_frequency} onValueChange={(v) => setForm({ ...form, check_frequency: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1h">Every hour</SelectItem>
                <SelectItem value="6h">Every 6 hours</SelectItem>
                <SelectItem value="24h">Daily</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.check_frequency === "24h" && (
            <div className="space-y-1.5">
              <Label>Daily check time (UK)</Label>
              <Input type="time" value={form.daily_check_time} onChange={(e) => setForm({ ...form, daily_check_time: e.target.value })} />
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label>Owner</Label>
          <Select
            value={form.owner || undefined}
            onValueChange={(v) => setForm({ ...form, owner: v })}
            disabled={!form.client_id || loadingOwners}
          >
            <SelectTrigger>
              <SelectValue placeholder={
                !form.client_id
                  ? "Select a client first"
                  : loadingOwners
                    ? "Loading users…"
                    : owners.length === 0
                      ? "No users with access to this client"
                      : "Select an owner"
              } />
            </SelectTrigger>
            <SelectContent>
              {owners.map((o) => (
                <SelectItem key={o.id} value={o.label}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Description</Label>
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => navigate("/tools/url-monitor")}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Creating…" : "Create campaign"}</Button>
        </div>
      </Card>
    </div>
  );
}
