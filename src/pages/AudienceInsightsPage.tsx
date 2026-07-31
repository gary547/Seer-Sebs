import { Compass, X } from "lucide-react";
import { useSearchParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { useClients } from "@/hooks/useClients";

export default function AudienceInsightsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const clientIdParam = searchParams.get("clientId");
  const { clients } = useClients();

  const filteredClientName = clientIdParam
    ? clients.find((c) => c.id === clientIdParam)?.company_name ?? "this client"
    : null;

  const clearFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("clientId");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <header>
        <div className="type-eyebrow flex items-center gap-2">
          <span>Audience Insights</span>
          <Badge variant="outline" className="text-[10px] uppercase tracking-wider">Global tool</Badge>
        </div>
      </header>

      {clientIdParam && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink-muted">
            <span>
              Filtered to{" "}
              <span className="font-medium text-ink">{filteredClientName}</span>
            </span>
            <button
              type="button"
              onClick={clearFilter}
              className="text-ink-subtle hover:text-ink"
              aria-label="Clear client filter"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}

      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center space-y-4">
        <Compass className="h-16 w-16 text-muted-foreground/40" />
        <h1 className="text-muted-foreground">Coming Soon</h1>
        <p className="text-muted-foreground max-w-md">
          Audience Insights will provide deep analysis of your target audience behaviour and search intent patterns.
        </p>
      </div>
    </div>
  );
}
