// Pure conversion-override resolver for Revenue v2.
// Precedence (most specific wins): url → category → intent → project → default.
// CVR and AOV are resolved independently (an override row may set only one).

export type OverrideScope = "project" | "url" | "category" | "intent";

export interface OverrideRow {
  id: string;
  scope_type: OverrideScope;
  scope_value: string | null;
  conversion_rate: number | null;
  average_order_value: number | null;
  confidence: "low" | "medium" | "high" | string;
  source?: string | null;
}

export interface KeywordScope {
  keyword_id: string;
  ranking_url: string | null;
  search_intent: string | null;
  tags: (string | null | undefined)[]; // deepest-last (tag_1..tag_5)
}

export interface ProjectDefaults {
  cvr: number | null; // decimal 0..1
  aov: number | null;
}

export type FieldSource =
  | "override_url"
  | "override_category"
  | "override_intent"
  | "override_project"
  | "project_default"
  | "missing";

export interface ResolvedField {
  value: number | null;
  source: FieldSource;
  override_id: string | null;
  confidence: string | null;
}

export interface OverrideResolution {
  cvr: ResolvedField;
  aov: ResolvedField;
}

interface Indexed {
  byUrl: Map<string, OverrideRow>;
  byCategory: Map<string, OverrideRow>; // key = lower(scope_value)
  byIntent: Map<string, OverrideRow>;
  project: OverrideRow | null;
}

export function indexOverrides(rows: OverrideRow[]): Indexed {
  const idx: Indexed = {
    byUrl: new Map(),
    byCategory: new Map(),
    byIntent: new Map(),
    project: null,
  };
  for (const r of rows ?? []) {
    if (!r) continue;
    if (r.scope_type === "project") {
      idx.project = r;
    } else if (r.scope_type === "url" && r.scope_value) {
      idx.byUrl.set(r.scope_value.trim().toLowerCase(), r);
    } else if (r.scope_type === "category" && r.scope_value) {
      idx.byCategory.set(r.scope_value.trim().toLowerCase(), r);
    } else if (r.scope_type === "intent" && r.scope_value) {
      idx.byIntent.set(r.scope_value.trim().toLowerCase(), r);
    }
  }
  return idx;
}

function pickField(
  row: OverrideRow | null | undefined,
  field: "conversion_rate" | "average_order_value",
): number | null {
  if (!row) return null;
  const v = row[field];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

function tierSource(scope: OverrideScope): FieldSource {
  return `override_${scope}` as FieldSource;
}

/**
 * Resolve CVR + AOV for a keyword against overrides + project defaults.
 * Category is matched deepest-first against any non-empty tag_1..tag_5 value.
 */
export function resolveConversionOverride(
  keyword: KeywordScope,
  idx: Indexed,
  defaults: ProjectDefaults,
): OverrideResolution {
  const candidates: Array<{ row: OverrideRow | null; scope: OverrideScope }> = [];

  // 1. url
  const urlKey = keyword.ranking_url?.trim().toLowerCase();
  if (urlKey && idx.byUrl.has(urlKey)) {
    candidates.push({ row: idx.byUrl.get(urlKey)!, scope: "url" });
  }

  // 2. category — deepest tag first
  const tags = [...(keyword.tags ?? [])].reverse();
  for (const t of tags) {
    if (!t) continue;
    const k = String(t).trim().toLowerCase();
    if (idx.byCategory.has(k)) {
      candidates.push({ row: idx.byCategory.get(k)!, scope: "category" });
      break;
    }
  }

  // 3. intent
  const intentKey = keyword.search_intent?.trim().toLowerCase();
  if (intentKey && idx.byIntent.has(intentKey)) {
    candidates.push({ row: idx.byIntent.get(intentKey)!, scope: "intent" });
  }

  // 4. project
  if (idx.project) candidates.push({ row: idx.project, scope: "project" });

  const resolveField = (
    field: "conversion_rate" | "average_order_value",
    defaultVal: number | null,
  ): ResolvedField => {
    for (const c of candidates) {
      const v = pickField(c.row, field);
      if (v != null) {
        return {
          value: v,
          source: tierSource(c.scope),
          override_id: c.row?.id ?? null,
          confidence: c.row?.confidence ?? null,
        };
      }
    }
    if (defaultVal != null && Number.isFinite(defaultVal)) {
      return {
        value: defaultVal,
        source: "project_default",
        override_id: null,
        confidence: null,
      };
    }
    return { value: null, source: "missing", override_id: null, confidence: null };
  };

  return {
    cvr: resolveField("conversion_rate", defaults.cvr),
    aov: resolveField("average_order_value", defaults.aov),
  };
}
