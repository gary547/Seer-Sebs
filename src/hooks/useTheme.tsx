import * as React from "react";

import { useAuth } from "@/contexts/AuthContext";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const STORAGE_KEY = "seer-theme";
const DEFAULT_THEME: Theme = "dark";
const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

function readInitial(): Theme {
  if (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  ) {
    return "dark";
  }
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  }
  return DEFAULT_THEME;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { profile, updateProfile, user } = useAuth();
  const [theme, setThemeState] = React.useState<Theme>(() => readInitial());
  const writeDebounceRef = React.useRef<number | null>(null);
  const reconciledForUserRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      return;
    }
  }, [theme]);

  React.useEffect(() => {
    if (!user) {
      reconciledForUserRef.current = null;
      return;
    }
    if (!profile || reconciledForUserRef.current === user.id) return;
    reconciledForUserRef.current = user.id;
    setThemeState(profile.themePreference);
  }, [profile, user]);

  React.useEffect(
    () => () => {
      if (writeDebounceRef.current) window.clearTimeout(writeDebounceRef.current);
    },
    [],
  );

  const persist = React.useCallback(
    (next: Theme) => {
      if (!user) return;
      if (writeDebounceRef.current) window.clearTimeout(writeDebounceRef.current);
      writeDebounceRef.current = window.setTimeout(() => {
        void updateProfile({ themePreference: next });
      }, 300);
    },
    [updateProfile, user],
  );

  const setTheme = React.useCallback(
    (next: Theme) => {
      setThemeState(next);
      persist(next);
    },
    [persist],
  );
  const toggle = React.useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      persist(next);
      return next;
    });
  }, [persist]);

  const value = React.useMemo(
    () => ({ setTheme, theme, toggle }),
    [setTheme, theme, toggle],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = React.useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
