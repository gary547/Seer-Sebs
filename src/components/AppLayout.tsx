import { Outlet } from "react-router";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { CommandPaletteProvider } from "@/hooks/useCommandPalette";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ClientProjectSwitcher } from "@/components/ClientProjectSwitcher";
import { useTheme } from "@/hooks/useTheme";
import noBrainerLogo from "@/assets/no-brainer-logo.png";
import noBrainerLogoWhite from "@/assets/no-brainer-logo-white.png";

export default function AppLayout() {
  const { theme } = useTheme();
  return (
    <CommandPaletteProvider>
      <SidebarProvider>
        <div className="min-h-screen flex w-full bg-background">
          <AppSidebar />
          <div className="flex-1 flex flex-col min-w-0">
            <header className="sticky top-0 z-30 h-12 flex items-center gap-3 border-b border-border bg-canvas/80 backdrop-blur-md px-4 shrink-0">
              <SidebarTrigger className="text-muted-foreground hover:text-foreground shrink-0" />
              <div className="flex-1 min-w-0 flex items-center">
                <ClientProjectSwitcher />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <ThemeToggle />
                <img
                  src={theme === "dark" ? noBrainerLogoWhite : noBrainerLogo}
                  alt="No Brainer"
                  className="h-[30px] opacity-80 hidden sm:block"
                />
              </div>
            </header>
            <main className="flex-1 p-6 overflow-auto">
              <Outlet />
            </main>
          </div>
        </div>
        <CommandPalette />
      </SidebarProvider>
    </CommandPaletteProvider>
  );
}

