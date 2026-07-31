import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Building2, Globe, UserPlus, MoreVertical, ArrowRight, Pencil, Plus, Archive } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { clientHome, clientEdit, newClientProject } from "@/lib/routes";
import { useCanArchive } from "@/hooks/useCanArchive";
import { useClients } from "@/hooks/useClients";
import { ArchiveClientDialog } from "@/components/archive/ArchiveClientDialog";

interface ArchiveTarget {
  id: string;
  name: string;
}

const ClientLogo = ({ logoPath, companyName }: { logoPath: string | null; companyName: string }) => {
  const { data: logoUrl } = useClientLogoUrl(logoPath);

  return (
    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
      {logoUrl ? (
        <img src={logoUrl} alt={`${companyName} logo`} className="h-full w-full object-contain p-1.5" />
      ) : (
        <Building2 className="h-6 w-6 text-muted-foreground" />
      )}
    </div>
  );
};
ClientLogo.displayName = "ClientLogo";

export default function ClientsPage() {
  const { canEdit } = useAuth();
  const { canArchive } = useCanArchive();
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);
  const { clients, isLoading, error } = useClients();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1>Clients</h1>
        {canEdit && (
          <Button asChild>
            <Link to="/clients/new">
              <UserPlus className="mr-2 h-4 w-4" />
              Add New Client
            </Link>
          </Button>
        )}
      </div>

      <div className="rounded-lg border bg-card">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">Loading clients…</div>
        ) : error ? (
          <div className="p-8 text-center text-destructive">Failed to load clients.</div>
        ) : !clients.length ? (
          <div className="p-8 text-center text-muted-foreground">No clients yet. Add your first client to get started.</div>
        ) : (
          <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {clients.map((client) => (
              <Card key={client.id} className="group relative transition-colors hover:bg-muted/40">
                {/* Card body = primary nav. Workspace, not edit. */}
                <Link
                  to={clientHome(client.id)}
                  className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
                  aria-label={`Open ${client.company_name} workspace`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      <ClientLogo logoPath={client.logo_url} companyName={client.company_name} />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div>
                          <h2 className="truncate text-base font-semibold text-accent">{client.company_name}</h2>
                          <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                            <Globe className="h-3.5 w-3.5 shrink-0" />
                            {client.domain}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs">
                          <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">{client.industry ?? "No industry"}</span>
                          <span className="rounded-md bg-muted px-2 py-1 capitalize text-muted-foreground">{client.campaign_type ?? "No campaign"}</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Link>

                {canEdit && (
                  <div className="absolute right-2 top-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Client actions"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem asChild>
                          <Link to={clientHome(client.id)}>
                            <ArrowRight className="mr-2 h-4 w-4" /> Open workspace
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link to={clientEdit(client.id)}>
                            <Pencil className="mr-2 h-4 w-4" /> Edit client
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link to={newClientProject(client.id)}>
                            <Plus className="mr-2 h-4 w-4" /> New Seer® project
                          </Link>
                        </DropdownMenuItem>
                        {canArchive && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={(e) => {
                                e.preventDefault();
                                setArchiveTarget({ id: client.id, name: client.company_name });
                              }}
                            >
                              <Archive className="mr-2 h-4 w-4" /> Archive client
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      <ArchiveClientDialog
        open={!!archiveTarget}
        onOpenChange={(o) => !o && setArchiveTarget(null)}
        clientId={archiveTarget?.id ?? null}
        clientName={archiveTarget?.name}
      />
    </div>
  );
}
