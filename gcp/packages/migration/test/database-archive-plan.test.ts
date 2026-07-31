import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDatabaseArchivePlan } from "../src/database-archive-plan.js";

describe("database source archive plan", () => {
  it("covers every catalogued source table with a validated archive key", () => {
    const catalog = JSON.parse(
      readFileSync(
        resolve("gcp/migration/source-table-catalog.json"),
        "utf8",
      ),
    );
    const inventory = {
      columns: catalog.tables.flatMap(
        (table: { archiveKeyColumns: string[]; source: string }) => {
          const [schema, name] = table.source.split(".");
          return table.archiveKeyColumns.map((column) => ({
            name: column,
            schema,
            table: name,
          }));
        },
      ),
      tables: catalog.tables.map((table: { source: string }) => {
        const [schema, name] = table.source.split(".");
        return { name, schema };
      }),
    };

    const plan = buildDatabaseArchivePlan(catalog, inventory, true);

    expect(plan.approved).toBe(true);
    expect(plan.version).toBe(2);
    expect(plan.tables).toHaveLength(58);
  });

  it("fails closed when the live inventory has an uncatalogued table", () => {
    const catalog = {
      expectedTableCount: 1,
      tables: [
        {
          archiveKeyColumns: ["id"],
          runtimeDisposition: "archive_only",
          source: "public.known",
        },
      ],
      version: 1 as const,
    };
    expect(() =>
      buildDatabaseArchivePlan(
        catalog,
        {
          columns: [
            { name: "id", schema: "public", table: "known" },
            { name: "id", schema: "public", table: "unexpected" },
          ],
          tables: [
            { name: "known", schema: "public" },
            { name: "unexpected", schema: "public" },
          ],
        },
        false,
      ),
    ).toThrow("Unmapped: public.unexpected");
  });
});
