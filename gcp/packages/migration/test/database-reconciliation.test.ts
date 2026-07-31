import { describe, expect, it } from "vitest";

import { buildDatabaseReconciliationMap } from "../src/database-reconciliation.js";

describe("database reconciliation mapping", () => {
  it("maps common public tables and records schema differences", () => {
    const result = buildDatabaseReconciliationMap(
      {
        columns: [
          { name: "id", schema: "public", table: "clients" },
          { name: "name", schema: "public", table: "clients" },
          { name: "legacy", schema: "public", table: "clients" },
          { name: "id", schema: "public", table: "missing" },
        ],
        sequences: [
          { name: "audit_id_seq", schema: "public" },
          { name: "auth_seq", schema: "auth" },
        ],
        tables: [
          { name: "clients", rowCount: 10, schema: "public" },
          { name: "missing", rowCount: 2, schema: "public" },
        ],
      },
      {
        columns: [
          { name: "id", schema: "public", table: "clients" },
          { name: "name", schema: "public", table: "clients" },
          { name: "new_field", schema: "public", table: "clients" },
        ],
        sequences: [{ name: "audit_id_seq", schema: "public" }],
        tables: [{ name: "clients", rowCount: 10, schema: "public" }],
      },
    );

    expect(result).toMatchObject({
      approved: false,
      missingTargetTables: ["public.missing"],
      sequences: [
        { source: "public.audit_id_seq", target: "public.audit_id_seq" },
      ],
      tables: [
        {
          columns: ["id", "name"],
          source: "public.clients",
          sourceOnlyColumns: ["legacy"],
          targetOnlyColumns: ["new_field"],
        },
      ],
    });
  });
});
