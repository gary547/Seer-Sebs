# SEER design system

SEER uses an editorial briefing style built from No Brainer's navy, teal, coral and amber palette. The source of truth for rendered values is `src/index.css`; `tailwind.config.ts` maps those semantic tokens into utilities. Use the same tokens in both light and dark themes.

## Color

- Canvas: warm off-white in light mode (`--canvas: 40 30% 97%`) and deep navy in dark mode (`211 100% 7%`).
- Primary ink: deep navy (`--ink: 211 100% 11%`) on light surfaces and near-white on dark surfaces.
- Brand signal: teal (`--signal: 182 100% 32%` light, `182 100% 38%` dark). Coral (`--signal-2`) and amber (`--signal-3`) are secondary signals.
- Surfaces, borders and status colors use `--surface`, `--surface-sunk`, `--hairline`, `--pos`, `--neg` and `--warn`. Do not hardcode a theme-specific color in a new component.

## Typography

- Montserrat is the heading and display face; Open Sans is the body face; JetBrains Mono is for IDs and dense numeric data.
- Existing heading sizes are 22 px for `h1`, 17 px for `h2` and 15 px for `h3`. Use `type-eyebrow` for small uppercase section labels and tabular numerals for counts and financial values.

## Spacing and shape

- Use the existing 4 px Tailwind spacing scale. Project admin pages use a 24 px page inset, 24 px section gaps and compact 12–16 px control gaps.
- The base radius is `0.875rem`; use the existing Card, Dialog, Select, Button, Badge and Table components instead of custom replacements.
- Cards use the semantic hairline border and `--shadow-card` when elevation helps hierarchy. Keep data entry calm and dense enough for administrative work.

## Interaction patterns

- Put one clear primary action in the page header. Forms open in a Dialog and show validation next to the affected field.
- For financial assumptions, show the selected scope and the population it matches before save. Distinguish a category's matching keyword count from the final number receiving its values when higher-priority URL overrides exist.
- Keep light and dark mode legible, use keyboard-accessible controls, and state when a saved change requires a forecast recalculation.
