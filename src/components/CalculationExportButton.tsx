import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { downloadCalculationResults } from "@/integrations/gcp/calculation-export";

export default function CalculationExportButton({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      await downloadCalculationResults(projectId);
      toast.success("Complete results downloaded — all three scenarios included");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Results could not be downloaded.");
    } finally { setDownloading(false); }
  };
  return <Button variant="outline" size="sm" disabled={disabled || downloading} onClick={() => void download()}>
    <Download className="mr-1 h-4 w-4" />{downloading ? "Preparing results…" : "Download complete results (CSV)"}
  </Button>;
}
