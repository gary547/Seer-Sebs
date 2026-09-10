import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { downloadCalculationResults, type ExportScenario } from "@/integrations/gcp/calculation-export";

export default function CalculationExportButton({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const [downloading, setDownloading] = useState(false);
  const download = async (scenario?: ExportScenario) => {
    setDownloading(true);
    try {
      await downloadCalculationResults(projectId, scenario);
      toast.success(scenario ? `${scenario[0].toUpperCase()}${scenario.slice(1)} results downloaded` : "Complete results downloaded — all three scenarios included");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Results could not be downloaded.");
    } finally { setDownloading(false); }
  };
  return <div className="inline-flex items-center gap-1">
    <Button variant="outline" size="sm" disabled={disabled || downloading} onClick={() => void download()}>
      <Download className="mr-1 h-4 w-4" />{downloading ? "Preparing results…" : "Download complete results (CSV)"}
    </Button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled || downloading} aria-label="Download results by scenario">
          <ChevronDown className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>One CSV per scenario</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(["conservative", "realistic", "stretch"] as const).map((scenario) => (
          <DropdownMenuItem key={scenario} onSelect={() => void download(scenario)}>
            {scenario[0].toUpperCase()}{scenario.slice(1)} (CSV)
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
