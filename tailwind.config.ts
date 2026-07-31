import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        heading: ["Montserrat", "ui-sans-serif", "system-ui", "sans-serif"],
        body: ["Open Sans", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ['"Montserrat"', "ui-serif", "serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      letterSpacing: {
        eyebrow: "0.14em",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        peach: {
          DEFAULT: "hsl(var(--peach))",
          foreground: "hsl(var(--peach-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },

        /* Editorial extension tokens */
        canvas: "hsl(var(--canvas))",
        surface: {
          DEFAULT: "hsl(var(--surface))",
          sunk: "hsl(var(--surface-sunk))",
          raised: "hsl(var(--surface-raised))",
        },
        hairline: {
          DEFAULT: "hsl(var(--hairline))",
          strong: "hsl(var(--hairline-strong))",
        },
        ink: {
          DEFAULT: "hsl(var(--ink))",
          muted: "hsl(var(--ink-muted))",
          subtle: "hsl(var(--ink-subtle))",
        },
        signal: {
          DEFAULT: "hsl(var(--signal))",
          soft: "hsl(var(--signal-soft))",
          ink: "hsl(var(--signal-ink))",
        },
        obsidian: {
          DEFAULT: "hsl(var(--obsidian))",
          2: "hsl(var(--obsidian-2))",
          3: "hsl(var(--obsidian-3))",
          line: "hsl(var(--obsidian-line))",
          ink: "hsl(var(--obsidian-ink))",
          "ink-muted": "hsl(var(--obsidian-ink-muted))",
        },
        pos: {
          DEFAULT: "hsl(var(--pos))",
          soft: "hsl(var(--pos-soft))",
        },
        neg: {
          DEFAULT: "hsl(var(--neg))",
          soft: "hsl(var(--neg-soft))",
        },
        warn: {
          DEFAULT: "hsl(var(--warn))",
          soft: "hsl(var(--warn-soft))",
        },
        neutral: "hsl(var(--neutral))",
      },
      boxShadow: {
        hairline: "var(--shadow-hairline)",
        card: "var(--shadow-card)",
        raised: "var(--shadow-raised)",
        obsidian: "var(--shadow-obsidian)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
