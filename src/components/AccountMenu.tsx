import { Link } from "react-router";
import { ChevronsUpDown, LogOut, User as UserIcon } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toDisplayName } from "@/lib/formatName";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface AccountMenuProps {
  collapsed: boolean;
}

export function AccountMenu({ collapsed }: AccountMenuProps) {
  const { user, role, signOut, profile } = useAuth();
  const fullName = toDisplayName(profile?.fullName ?? "");

  const displayName = fullName || (user?.email ?? "");
  const initial = (displayName || "?").charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={
          collapsed
            ? "mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary hover:bg-primary/25 transition-colors"
            : "flex w-full items-center gap-2 rounded-lg p-1.5 hover:bg-sidebar-accent transition-colors text-left"
        }
        title={user?.email ?? "Account"}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
          {initial}
        </div>
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-sidebar-foreground/90">
                {fullName || (user?.email ?? "")}
              </p>
              <p className="truncate text-[10px] text-sidebar-foreground/50">
                {user?.email ?? ""}
              </p>
            </div>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <p className="text-xs text-muted-foreground">Signed in as</p>
          <p className="truncate text-sm font-medium">{fullName || user?.email}</p>
          {fullName && (
            <p className="truncate text-[11px] text-muted-foreground">{user?.email}</p>
          )}
          {role && (
            <p className="mt-1 truncate text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold">
              {role.replace("_", " ")}
            </p>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account" className="cursor-pointer">
            <UserIcon className="mr-2 h-4 w-4" />
            Account settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={signOut}
          className="cursor-pointer text-destructive focus:text-destructive"
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
