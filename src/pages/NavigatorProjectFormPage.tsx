import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useClients } from "@/hooks/useClients";
import { createProject } from "@/integrations/gcp/tenancy";
import { projectHome } from "@/lib/routes";
import { pctToDecimal } from "@/lib/validation/conversionOverride";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => currentYear + i);

function MonthYearPicker({
  label,
  month,
  year,
  onMonthChange,
  onYearChange,
}: {
  label: string;
  month: string;
  year: string;
  onMonthChange: (v: string) => void;
  onYearChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        <Select value={month} onValueChange={onMonthChange}>
          <SelectTrigger>
            <SelectValue placeholder="Month" />
          </SelectTrigger>
          <SelectContent>
            {MONTHS.map((m, i) => (
              <SelectItem key={m} value={String(i + 1).padStart(2, "0")}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={year} onValueChange={onYearChange}>
          <SelectTrigger>
            <SelectValue placeholder="Year" />
          </SelectTrigger>
          <SelectContent>
            {YEARS.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export default function NavigatorProjectFormPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { clientId: routeClientId } = useParams<{ clientId?: string }>();
  const [saving, setSaving] = useState(false);

  const [clientId, setClientId] = useState(routeClientId ?? "");
  const [projectName, setProjectName] = useState("");
  const [categoryFocus, setCategoryFocus] = useState("");
  const [seasonStartMonth, setSeasonStartMonth] = useState("");
  const [seasonStartYear, setSeasonStartYear] = useState("");
  const [seasonEndMonth, setSeasonEndMonth] = useState("");
  const [seasonEndYear, setSeasonEndYear] = useState("");
  const [aov, setAov] = useState("");
  const [conversionRate, setConversionRate] = useState("");

  const { clients } = useClients();

  const formatSeasonDate = (month: string, year: string) => {
    if (!month || !year) return null;
    return `${year}-${month}-01`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId) {
      toast({ title: "Please select a client", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const project = await createProject(clientId, {
        aov: aov ? Number(aov) : null,
        categoryFocus: categoryFocus.trim() || null,
        conversionRate: pctToDecimal(conversionRate),
        projectName: projectName.trim(),
        seasonalityEnd: formatSeasonDate(seasonEndMonth, seasonEndYear),
        seasonalityStart: formatSeasonDate(seasonStartMonth, seasonStartYear),
      });
      toast({ title: "Project created", description: `${projectName} is ready.` });
      navigate(projectHome(clientId, project.id));
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Project creation failed.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <h1>New Seer® Project</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Project Details</CardTitle>
            <CardDescription>Set up a new Seer® project for a client.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Client *</Label>
              <Select value={clientId} onValueChange={setClientId} disabled={!!routeClientId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select client…" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.company_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {routeClientId && (
                <p className="text-[11px] text-ink-muted">Client is pre-selected from the workspace.</p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="project_name">Project Name *</Label>
                <Input
                  id="project_name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="category_focus">Category Focus</Label>
                <Input
                  id="category_focus"
                  value={categoryFocus}
                  onChange={(e) => setCategoryFocus(e.target.value)}
                  placeholder="e.g. Refrigeration"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <MonthYearPicker
                label="Seasonality Start"
                month={seasonStartMonth}
                year={seasonStartYear}
                onMonthChange={setSeasonStartMonth}
                onYearChange={setSeasonStartYear}
              />
              <MonthYearPicker
                label="Seasonality End"
                month={seasonEndMonth}
                year={seasonEndYear}
                onMonthChange={setSeasonEndMonth}
                onYearChange={setSeasonEndYear}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="aov">Default AOV (£)</Label>
                <Input
                  id="aov"
                  type="number"
                  step="0.01"
                  min="0"
                  value={aov}
                  onChange={(e) => setAov(e.target.value)}
                  placeholder="e.g. 45.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cvr">Default Conversion Rate (%)</Label>
                <Input
                  id="cvr"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={conversionRate}
                  onChange={(e) => setConversionRate(e.target.value)}
                  placeholder="e.g. 2.5"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create Project"}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate(routeClientId ? `/clients/${routeClientId}` : "/clients")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
