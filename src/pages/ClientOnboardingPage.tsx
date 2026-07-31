import { useState, useEffect } from "react";
import { useNavigate, useParams, Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Building2, Plus, Trash2, Info, Upload, Download } from "lucide-react";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";
import ClientAppUsersSection from "@/components/client/ClientAppUsersSection";
import { SeerBreadcrumbs } from "@/components/SeerBreadcrumbs";
import { normalizeDomain } from "@/lib/domain";
import { clientHome } from "@/lib/routes";
import {
  createClient,
  getClient,
  updateClient,
  uploadClientLogo,
} from "@/integrations/gcp/tenancy";
import { SeerApiError } from "@/integrations/gcp/api";


const INDUSTRIES = [
  "Retail", "Finance", "Professional Services", "Ecommerce", "SaaS",
  "Tech", "Health", "Charities/Non Profit", "Construction",
  "Manufacturing", "Property", "Other",
];

interface TeamMember {
  name: string;
  email: string;
}

interface Competitor {
  id?: string;
  competitor_name: string;
  competitor_domain: string;
  verified: boolean;
}

const RULE_TYPES = [
  { value: "whitelist", label: "Whitelist" },
  { value: "blacklist", label: "Blacklist" },
  { value: "competitor_brand", label: "Competitor Brand" },
  { value: "own_brand", label: "Own Brand" },
];

interface KeywordRule {
  id?: string;
  rule_type: string;
  keyword_categorisation: string;
}

export default function ClientOnboardingPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  // Form state
  const [companyName, setCompanyName] = useState("");
  const [domain, setDomain] = useState("");
  const [domainConflict, setDomainConflict] = useState<
    | { id: string; company_name: string | null; canonical: string }
    | { unknown: true; canonical: string }
    | null
  >(null);
  const [industry, setIndustry] = useState("");
  const [campaignType, setCampaignType] = useState("");
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [keywordRules, setKeywordRules] = useState<KeywordRule[]>([]);
  const [gscConnected, setGscConnected] = useState(false);
  const [analyticsConnected, setAnalyticsConnected] = useState(false);
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const { data: signedLogoUrl } = useClientLogoUrl(logoPath);

  const { data: client, isLoading } = useQuery({
    queryKey: ["client", id],
    queryFn: () => getClient(id as string),
    enabled: isEdit,
  });

  useEffect(() => {
    if (client) {
      setCompanyName(client.company_name);
      setDomain(client.domain);
      setIndustry(client.industry ?? "");
      setCampaignType(client.campaign_type ?? "");
      setTeamMembers(Array.isArray(client.team_members) ? (client.team_members as unknown as TeamMember[]) : []);
      setGscConnected(client.gsc_connected);
      setAnalyticsConnected(client.analytics_connected);
      setLogoPath(client.logo_url ?? null);
      setCompetitors(
        client.competitors.map((competitor) => ({
          competitor_domain: competitor.competitor_domain,
          competitor_name: competitor.competitor_name,
          id: competitor.id,
          verified: competitor.verified,
        })),
      );
      setKeywordRules(
        client.keyword_rules.map((rule) => ({
          id: rule.id,
          keyword_categorisation: rule.keyword_categorisation,
          rule_type: rule.rule_type,
        })),
      );
    }
  }, [client]);

  useEffect(() => {
    if (!logoFile) {
      setLogoPreview(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  // Competitor logic
  const addCompetitor = () => {
    setCompetitors((prev) => [
      ...prev,
      { competitor_name: "", competitor_domain: "", verified: false },
    ]);
  };

  const updateCompetitor = (index: number, field: keyof Competitor, value: string | boolean) => {
    setCompetitors((prev) =>
      prev.map((c, i) => (i === index ? { ...c, [field]: value } : c))
    );
  };

  const removeCompetitor = (index: number) => {
    setCompetitors((prev) => prev.filter((_, i) => i !== index));
  };

  // Keyword rules logic
  const addRule = () => {
    setKeywordRules((prev) => [...prev, { rule_type: "blacklist", keyword_categorisation: "" }]);
  };

  const updateRule = (index: number, field: keyof KeywordRule, value: string) => {
    setKeywordRules((prev) =>
      prev.map((r, i) => (i === index ? { ...r, [field]: value } : r))
    );
  };

  const removeRule = (index: number) => {
    setKeywordRules((prev) => prev.filter((_, i) => i !== index));
  };

  // Save
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Pre-flight: block duplicate live client on the same normalised domain.
    const canonical = normalizeDomain(domain);
    if (!canonical) {
      toast({
        title: "Domain required",
        description: "Enter a valid domain (e.g. example.com).",
        variant: "destructive",
      });
      return;
    }
    setDomainConflict(null);

    setSaving(true);

    try {
      let clientId = id;

      const validCompetitors = competitors.filter(
        (competitor) =>
          competitor.competitor_name.trim() &&
          competitor.competitor_domain.trim(),
      );
      const validRules = keywordRules.filter((rule) =>
        rule.keyword_categorisation.trim(),
      );
      const clientPayload = {
        analyticsConnected,
        campaignType: campaignType || null,
        companyName: companyName.trim(),
        competitors: validCompetitors.map((competitor) => ({
          competitorDomain: competitor.competitor_domain.trim(),
          competitorName: competitor.competitor_name.trim(),
          verified: competitor.verified,
        })),
        domain: domain.trim(),
        industry: industry || null,
        gscConnected,
        keywordRules: validRules.map((rule) => ({
          keywordCategorisation: rule.keyword_categorisation.trim(),
          ruleType: rule.rule_type,
        })),
        teamMembers: teamMembers.length ? teamMembers : null,
      };

      if (isEdit && clientId) {
        await updateClient(clientId, clientPayload);
      } else {
        clientId = (await createClient(clientPayload)).id;
      }

      if (clientId && logoFile) {
        setLogoPath(await uploadClientLogo(clientId, logoFile));
      }

      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["client", clientId] });
      toast({
        title: isEdit ? "Client updated" : "Client added",
        description: `${companyName} has been ${isEdit ? "updated" : "created"}.`,
      });
      navigate("/clients");
    } catch (error) {
      if (
        error instanceof SeerApiError &&
        error.code === "client_domain_conflict"
      ) {
        setDomainConflict({ unknown: true, canonical });
        toast({
          title: "Domain already in use",
          description: `A client with the domain ${canonical} already exists.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error",
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        });
      }
    } finally {
      setSaving(false);
    }
  };

  if (isEdit && isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading client…</div>;
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SeerBreadcrumbs
        items={
          isEdit
            ? [
                { label: "Dashboard", to: "/dashboard" },
                { label: "Clients", to: "/clients" },
                { label: companyName || "Client", to: id ? `/clients/${id}` : undefined },
                { label: "Edit" },
              ]
            : [
                { label: "Dashboard", to: "/dashboard" },
                { label: "Clients", to: "/clients" },
                { label: "New client" },
              ]
        }
      />
      <h1>{isEdit ? "Edit Client" : "Add New Client"}</h1>

      <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Section 1: Company Details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Company Details</CardTitle>
            <CardDescription>Basic information about the client.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="company_name">Company Name *</Label>
                <Input
                  id="company_name"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="domain">Domain *</Label>
                <Input
                  id="domain"
                  value={domain}
                  onChange={(e) => {
                    setDomain(e.target.value);
                    if (domainConflict) setDomainConflict(null);
                  }}
                  placeholder="www.example.com"
                  required
                  aria-invalid={domainConflict ? true : undefined}
                />
                {(() => {
                  const canonical = normalizeDomain(domain);
                  if (domainConflict) {
                    const canonicalShown = domainConflict.canonical;
                    return (
                      <p className="text-xs text-destructive" role="alert">
                        A client for <strong>{canonicalShown}</strong> already exists
                        {"unknown" in domainConflict ? (
                          <> — contact an admin.</>
                        ) : (
                          <>
                            {" "}— <em>{domainConflict.company_name ?? "Unnamed"}</em>.{" "}
                            <Link
                              to={clientHome(domainConflict.id)}
                              className="underline underline-offset-2"
                            >
                              Open workspace →
                            </Link>
                          </>
                        )}
                      </p>
                    );
                  }
                  if (canonical && canonical !== domain.trim().toLowerCase()) {
                    return (
                      <p className="text-xs text-muted-foreground">
                        Will be saved as <span className="font-mono">{canonical}</span>
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="industry">Industry</Label>
              <Select value={industry} onValueChange={setIndustry}>
                <SelectTrigger>
                  <SelectValue placeholder="Select industry…" />
                </SelectTrigger>
                <SelectContent>
                  {INDUSTRIES.map((ind) => (
                    <SelectItem key={ind} value={ind}>
                      {ind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Campaign Type</Label>
              <RadioGroup
                value={campaignType}
                onValueChange={setCampaignType}
                className="flex gap-6"
              >
                {[{ value: "retainer", label: "Retainer" }, { value: "project", label: "Project" }, { value: "pitch", label: "Pitch" }].map((type) => (
                  <div key={type.value} className="flex items-center gap-2">
                    <RadioGroupItem value={type.value} id={`campaign-${type.value}`} />
                    <Label htmlFor={`campaign-${type.value}`} className="font-normal cursor-pointer">
                      {type.label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label htmlFor="client-logo">Client Logo</Label>
              <div className="flex items-center gap-4">
                <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                  {logoPreview || signedLogoUrl ? (
                    <img src={logoPreview ?? signedLogoUrl ?? ""} alt="Client logo preview" className="h-full w-full object-contain p-2" />
                  ) : (
                    <Building2 className="h-8 w-8 text-muted-foreground" />
                  )}
                </div>
                <div className="space-y-2">
                  <Input
                    id="client-logo"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
                    className="max-w-xs"
                  />
                  <p className="text-xs text-muted-foreground">Square PNG, JPG, WebP or SVG recommended.</p>
                </div>
              </div>
            </div>

          </CardContent>
        </Card>

        {/* App Users with Access — sits beside Company Details in edit mode */}
        {isEdit && id ? (
          <ClientAppUsersSection clientId={id} />
        ) : (
          <div aria-hidden className="hidden lg:block" />
        )}

        {/* Section 2: Data Connections */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Data Connections</CardTitle>
            <CardDescription>
              Connection status for third-party data sources.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* GSC */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">Google Search Console</Label>
                <p className="text-xs text-muted-foreground">
                  For MVP, export your data as CSV and upload it in the Seer® project.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {gscConnected ? "Connected" : "Not connected"}
                </span>
                <Switch checked={gscConnected} onCheckedChange={setGscConnected} />
              </div>
            </div>

            <Separator />

            {/* Analytics */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">Google Analytics</Label>
                <p className="text-xs text-muted-foreground">
                  For MVP, export your data as CSV and upload it in the Seer® project.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {analyticsConnected ? "Connected" : "Not connected"}
                </span>
                <Switch checked={analyticsConnected} onCheckedChange={setAnalyticsConnected} />
              </div>
            </div>

            <Separator />

            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="outline" size="sm" disabled>
                    <Upload className="mr-1 h-4 w-4" />
                    Upload Data
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  <p className="text-xs">
                    Upload Google Search Console & Google Analytics CSV exports. Download the template below to see the expected format.
                  </p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => {
                      const csv = "keyword,clicks,impressions,ctr,position\n";
                      const blob = new Blob([csv], { type: "text/csv" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "data_template.csv";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download className="mr-1 h-4 w-4" />
                    Download Template
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p className="text-xs">Download a blank CSV template with the expected columns.</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger>
                  <Info className="h-4 w-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-xs">
                    Data upload will be available in a future release. For now, use the Seer® project to import CSV files.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Competitors */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Competitors</CardTitle>
            <CardDescription>
              Add known competitors for this client.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {competitors.length > 0 && (
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 text-xs font-medium text-muted-foreground px-1">
                  <span>Name</span>
                  <span>Domain</span>
                  <span>Verified</span>
                  <span />
                </div>
                {competitors.map((comp, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-center"
                  >
                    <Input
                      value={comp.competitor_name}
                      onChange={(e) => updateCompetitor(i, "competitor_name", e.target.value)}
                      placeholder="Competitor name"
                    />
                    <Input
                      value={comp.competitor_domain}
                      onChange={(e) => updateCompetitor(i, "competitor_domain", e.target.value)}
                      placeholder="competitor.com"
                    />
                    <Checkbox
                      checked={comp.verified}
                      onCheckedChange={(v) => updateCompetitor(i, "verified", Boolean(v))}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCompetitor(i)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button type="button" variant="outline" size="sm" onClick={addCompetitor}>
              <Plus className="mr-1 h-4 w-4" />
              Add Competitor
            </Button>
          </CardContent>
        </Card>

        {/* Section 4: Keyword Rules Library */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Keyword Rules Library</CardTitle>
            <CardDescription>
              These rules carry across all Seer® projects for this client. Blacklisted terms will be flagged for removal. Whitelisted terms will be protected. Competitor and own-brand terms help the detox AI make better decisions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {keywordRules.length > 0 && (
              <div className="space-y-2">
                <div className="grid grid-cols-[180px_1fr_auto] gap-2 text-xs font-medium text-muted-foreground px-1">
                  <span>Rule Type</span>
                  <span>Keyword Pattern</span>
                  <span />
                </div>
                {keywordRules.map((rule, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[180px_1fr_auto] gap-2 items-center"
                  >
                    <Select
                      value={rule.rule_type}
                      onValueChange={(v) => updateRule(i, "rule_type", v)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RULE_TYPES.map((rt) => (
                          <SelectItem key={rt.value} value={rt.value}>
                            {rt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={rule.keyword_categorisation}
                      onChange={(e) => updateRule(i, "keyword_categorisation", e.target.value)}
                      placeholder="e.g. brand name, keyword pattern…"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeRule(i)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button type="button" variant="outline" size="sm" onClick={addRule}>
              <Plus className="mr-1 h-4 w-4" />
              Add Rule
            </Button>
          </CardContent>
        </Card>

        {/* spacer for grid alignment */}

        {/* Actions — span full width */}
        <div className="flex gap-3 lg:col-span-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Client"}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate("/clients")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
