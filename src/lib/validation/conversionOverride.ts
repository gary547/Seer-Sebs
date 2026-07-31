import { z } from "zod";

export const SCOPE_TYPES = ["project", "url", "category", "intent"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const INTENT_VALUES = [
  "informational",
  "navigational",
  "commercial",
  "transactional",
  "unknown",
] as const;

export const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

export const NOTE_REQUIRED_SCOPES: ScopeType[] = ["url", "category"];

/**
 * Form schema — accepts strings from inputs and coerces numerics.
 * CVR is stored as a decimal (0–1); AOV as a number ≥ 0.
 */
export const conversionOverrideFormSchema = z
  .object({
    scope_type: z.enum(SCOPE_TYPES),
    scope_value: z.string().trim().optional().default(""),
    conversion_rate_pct: z
      .string()
      .trim()
      .optional()
      .default(""), // percent input, e.g. "2.5"
    average_order_value: z
      .string()
      .trim()
      .optional()
      .default(""),
    confidence: z.enum(CONFIDENCE_VALUES).default("medium"),
    note: z.string().trim().optional().default(""),
  })
  .superRefine((val, ctx) => {
    // scope_value rules
    if (val.scope_type !== "project" && !val.scope_value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope_value"],
        message: "Required for this scope",
      });
    }
    if (val.scope_type === "url" && val.scope_value) {
      try {
        // eslint-disable-next-line no-new
        new URL(val.scope_value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope_value"],
          message: "Must be a valid URL (include https://)",
        });
      }
    }
    if (val.scope_type === "intent" && val.scope_value) {
      if (!(INTENT_VALUES as readonly string[]).includes(val.scope_value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope_value"],
          message: "Invalid intent",
        });
      }
    }

    // note required for url/category
    if (NOTE_REQUIRED_SCOPES.includes(val.scope_type) && !val.note) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["note"],
        message: "Note is required for URL and category overrides",
      });
    }

    // numeric parsing / at-least-one rule
    const cvrRaw = val.conversion_rate_pct;
    const aovRaw = val.average_order_value;
    const hasCvr = cvrRaw !== "";
    const hasAov = aovRaw !== "";
    if (!hasCvr && !hasAov) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conversion_rate_pct"],
        message: "Provide at least a conversion rate or an AOV",
      });
    }
    if (hasCvr) {
      const n = Number(cvrRaw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conversion_rate_pct"],
          message: "Enter a percent between 0 and 100",
        });
      }
    }
    if (hasAov) {
      const n = Number(aovRaw);
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["average_order_value"],
          message: "Must be a non-negative number",
        });
      }
    }
  });

export type ConversionOverrideFormValues = z.infer<typeof conversionOverrideFormSchema>;

export function pctToDecimal(pct: string | number | null | undefined): number | null {
  if (pct === "" || pct == null) return null;
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

export function decimalToPct(dec: number | null | undefined): string {
  if (dec == null || !Number.isFinite(dec)) return "";
  return String(Number((dec * 100).toFixed(4)));
}

export function parseNumberOrNull(s: string): number | null {
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
