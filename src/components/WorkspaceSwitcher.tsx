import { useState } from "react";
import { useNavigate } from "react-router";
import { Building2, ChevronsUpDown, Eye, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useActiveClient } from "@/hooks/useActiveClient";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";
import { useClients } from "@/hooks/useClients";
import { listProjects } from "@/integrations/gcp/tenancy";

interface WorkspaceSwitcherProps {
  collapsed: boolean;
}

function ClientAvatar({ logoPath, name, size = "md" }: { logoPath: string | null; name: string; size?: "sm" | "md" }) {
  const { data: url } = useClientLogoUrl(logoPath);
  const dim = size === "sm" ? "h-6 w-6" : "h-9 w-9";
  return (
    <div className={`${dim} shrink-0 overflow-hidden rounded-md border border-sidebar-foreground/10 bg-sidebar-accent flex items-center justify-center`}>
      {url ? (
        <img src={url} alt={`${name} logo`} className="h-full w-full object-contain p-0.5" />
      ) : (
        <Building2 className="h-4 w-4 text-sidebar-foreground/50" />
      )}
    </div>
  );
}

export function WorkspaceSwitcher({ collapsed }: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { client: active } = useActiveClient();

  const { clients: visibleClients } = useClients(open);
  const clients = [...visibleClients].sort((left, right) =>
    left.company_name.localeCompare(right.company_name),
  );

  const switchToClient = async (clientId: string) => {
    setOpen(false);
    // Try newest project for this client; fall back to client home.
    const [project] = await listProjects(clientId);
    if (project?.id) {
      navigate(`/clients/${clientId}/projects/${project.id}`);
    } else {
      navigate(`/clients/${clientId}`);
    }
  };

  // Brand fallback (no active client → show app brand, not interactive as a switcher)
  if (!active) {
    if (collapsed) {
      return (
        <div className="flex justify-center">
          <div className="h-9 w-9 rounded-full bg-primary flex items-center justify-center">
            <Eye className="h-5 w-5 text-primary-foreground" />
          </div>
        </div>
      );
    }
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="flex w-full items-center gap-2.5 rounded-lg p-1 hover:bg-sidebar-accent transition-colors text-left">
            <div className="h-9 w-9 rounded-full bg-primary flex items-center justify-center shrink-0">
              <Eye className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="flex-1 font-heading font-bold text-base text-sidebar-foreground tracking-tight truncate">
              Seer®
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
          </button>
        </PopoverTrigger>
        <SwitcherContent
          clients={clients}
          activeId={null}
          onPick={switchToClient}
          onAllClients={() => {
            setOpen(false);
            navigate("/clients");
          }}
        />
      </Popover>
    );
  }

  // Active client → show client identity
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={
            collapsed
              ? "mx-auto flex items-center justify-center"
              : "flex w-full items-center gap-2.5 rounded-lg p-1 hover:bg-sidebar-accent transition-colors text-left"
          }
          title={active.company_name}
        >
          <ClientAvatar logoPath={active.logo_url} name={active.company_name} />
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/40 font-semibold">Workspace</p>
                <p className="truncate text-sm font-semibold text-sidebar-foreground">{active.company_name}</p>
              </div>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
            </>
          )}
        </button>
      </PopoverTrigger>
      <SwitcherContent
        clients={clients}
        activeId={active.id}
        onPick={switchToClient}
        onAllClients={() => {
          setOpen(false);
          navigate("/clients");
        }}
      />
    </Popover>
  );
}

function SwitcherContent({
  clients,
  activeId,
  onPick,
  onAllClients,
}: {
  clients: { id: string; company_name: string; logo_url: string | null }[];
  activeId: string | null;
  onPick: (id: string) => void;
  onAllClients: () => void;
}) {
  return (
    <PopoverContent side="right" align="start" className="w-72 p-0">
      <Command>
        <CommandInput placeholder="Switch workspace…" />
        <CommandList>
          <CommandEmpty>No clients found.</CommandEmpty>
          <CommandGroup>
            <CommandItem value="all-clients" onSelect={onAllClients}>
              <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
              All clients
            </CommandItem>
          </CommandGroup>
          {clients.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Clients">
                {clients.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`client ${c.company_name}`}
                    onSelect={() => onPick(c.id)}
                    className="gap-2"
                  >
                    <ClientAvatar logoPath={c.logo_url} name={c.company_name} size="sm" />
                    <span className="flex-1 truncate">{c.company_name}</span>
                    {activeId === c.id && <Check className="h-4 w-4 text-primary" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </PopoverContent>
  );
}
