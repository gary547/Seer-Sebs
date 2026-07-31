import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDatabaseCanonicalPlan } from "../src/database-canonical-plan.js";

function column(
  table: string,
  name: string,
  nullable: "NO" | "YES",
  columnDefault: string | null = null,
  udtName = "text",
) {
  return {
    column_default: columnDefault,
    is_nullable: nullable,
    name,
    schema: "public",
    table,
    udt_name: udtName,
  };
}

describe("canonical database plan", () => {
  const catalog = {
    tables: [
      {
        runtimeDisposition: "canonical_transform",
        runtimeTarget: "public.profiles",
        source: "public.profiles",
      },
      {
        runtimeDisposition: "canonical_transform",
        runtimeTarget: "public.keywords",
        source: "public.keywords",
      },
      {
        runtimeDisposition: "recomputed",
        runtimeTarget: "public.site_architecture",
        source: "public.site_architecture",
      },
    ],
    version: 1 as const,
  };
  const rules = {
    tables: [
      {
        columns: [{ source: "id", target: "user_id" }],
        loadOrder: 10,
        source: "public.profiles",
        target: "public.profiles",
      },
      {
        columns: [
          {
            source: "keyword",
            target: "normalised_keyword",
            transform: "normalise_text" as const,
          },
          {
            fallback: "legacy_supabase",
            source: "source",
            target: "sources",
            transform: "singleton_text_array" as const,
          },
        ],
        loadOrder: 20,
        source: "public.keywords",
        target: "public.keywords",
      },
    ],
    version: 1 as const,
  };
  const source = {
    columns: [
      column("profiles", "id", "NO", null, "uuid"),
      column("profiles", "email", "YES"),
      column("keywords", "id", "NO", null, "uuid"),
      column("keywords", "project_id", "NO", null, "uuid"),
      column("keywords", "keyword", "NO"),
      column("keywords", "source", "YES"),
    ],
    tables: [
      { name: "profiles", schema: "public" },
      { name: "keywords", schema: "public" },
    ],
  };
  const target = {
    columns: [
      column("profiles", "user_id", "NO", null, "uuid"),
      column("profiles", "email", "NO"),
      column("profiles", "identity_provider", "NO", "'firebase'::text"),
      column("keywords", "id", "NO", null, "uuid"),
      column("keywords", "project_id", "NO", null, "uuid"),
      column("keywords", "keyword", "NO"),
      column("keywords", "normalised_keyword", "NO"),
      column("keywords", "sources", "NO", "ARRAY['source']::text[]", "_text"),
      column("keywords", "created_at", "NO", "now()", "timestamptz"),
    ],
    tables: [
      { name: "profiles", schema: "public" },
      { name: "keywords", schema: "public" },
    ],
  };

  it("builds dependency-ordered copies and excludes recomputed outputs", () => {
    const plan = buildDatabaseCanonicalPlan(
      catalog,
      rules,
      source,
      target,
      true,
    );

    expect(plan.tables).toHaveLength(2);
    expect(plan.tables[0]).toMatchObject({
      id: "canonical-profiles",
      source: "public.profiles",
      target: "public.profiles",
    });
    expect(plan.tables[1]).toMatchObject({
      columns: expect.arrayContaining([
        {
          source: "keyword",
          target: "normalised_keyword",
          transform: "normalise_text",
        },
      ]),
      source: "public.keywords",
    });
  });

  it("fails closed when a required target column has no source rule", () => {
    expect(() =>
      buildDatabaseCanonicalPlan(
        catalog,
        rules,
        source,
        {
          ...target,
          columns: [
            ...target.columns,
            column("keywords", "required_contract", "NO"),
          ],
        },
        true,
      ),
    ).toThrow("required_contract");
  });

  it("requires a rule for every canonical catalog table", () => {
    expect(() =>
      buildDatabaseCanonicalPlan(
        catalog,
        { ...rules, tables: rules.tables.slice(0, 1) },
        source,
        target,
        false,
      ),
    ).toThrow("public.keywords");
  });

  it("keeps the production canonical rules aligned with the source catalog", () => {
    const productionCatalog = JSON.parse(
      readFileSync(
        resolve("gcp/migration/source-table-catalog.json"),
        "utf8",
      ),
    );
    const productionRules = JSON.parse(
      readFileSync(
        resolve("gcp/migration/canonical-table-rules.json"),
        "utf8",
      ),
    );
    const catalogSources = productionCatalog.tables
      .filter((table: { runtimeDisposition: string }) =>
        ["canonical_copy", "canonical_transform"].includes(
          table.runtimeDisposition,
        ),
      )
      .map((table: { source: string }) => table.source)
      .sort();
    const ruleSources = productionRules.tables
      .map((table: { source: string }) => table.source)
      .sort();
    const loadOrders = productionRules.tables.map(
      (table: { loadOrder: number }) => table.loadOrder,
    );

    expect(ruleSources).toEqual(catalogSources);
    expect(ruleSources).toHaveLength(26);
    expect(new Set(loadOrders).size).toBe(loadOrders.length);
    expect(
      productionRules.tables.find(
        (table: { source: string }) => table.source === "public.user_roles",
      ),
    ).toMatchObject({
      columns: [
        {
          source: "role",
          target: "role",
          transform: "normalise_text",
        },
      ],
    });
    expect(
      productionRules.tables.find(
        (table: { source: string }) => table.source === "public.competitors",
      ),
    ).toMatchObject({ excludeColumns: ["added_by"] });
    expect(
      productionCatalog.tables
        .filter(
          (table: { runtimeDisposition: string }) =>
            table.runtimeDisposition === "recomputed",
        )
        .map((table: { source: string }) => table.source),
    ).toEqual(
      expect.arrayContaining([
        "public.calibration_snapshots",
        "public.ctr_curves",
        "public.keyword_demand_signals",
        "public.link_power_scores",
        "public.site_architecture",
      ]),
    );
  });
});
