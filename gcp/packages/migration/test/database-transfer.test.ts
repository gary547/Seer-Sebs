import { describe, expect, it } from "vitest";

import {
  archiveInsertBatchStatement,
  archiveRowValues,
  copyRowValues,
  insertBatchStatement,
  normaliseDatabaseTransferPlan,
} from "../src/database-transfer.js";

describe("database transfer plan", () => {
  it("supports identity mappings and explicit source-to-target column names", () => {
    const plan = normaliseDatabaseTransferPlan({
      approved: true,
      sequences: [],
      tables: [
        {
          columns: ["email", { source: "id", target: "user_id" }],
          source: "public.profiles",
          target: "public.profiles",
        },
      ],
      version: 1,
    });

    expect(plan.tables[0]).toEqual({
      columns: [
        { source: "email", target: "email" },
        { source: "id", target: "user_id" },
      ],
      disableUserTriggers: false,
      id: "copy-public-profiles",
      keyColumns: [],
      mode: "copy",
      source: "public.profiles",
      target: "public.profiles",
    });
    expect(insertBatchStatement(plan.tables[0]!, 2)).toBe(
      'INSERT INTO "public"."profiles" ("email", "user_id") VALUES ($1, $2), ($3, $4)',
    );
  });

  it("supports keyed lossless JSON archives alongside canonical copies", () => {
    const plan = normaliseDatabaseTransferPlan({
      approved: true,
      sequences: [],
      tables: [
        {
          id: "archive-keyword-forecasts",
          keyColumns: ["id"],
          mode: "archive_json",
          source: "public.keyword_forecasts",
          target: "migration.source_rows",
        },
        {
          columns: ["id", "project_id"],
          id: "copy-projects",
          mode: "copy",
          source: "public.navigator_projects",
          target: "public.navigator_projects",
        },
      ],
      version: 2,
    });

    expect(plan.tables[0]).toEqual({
      columns: [],
      id: "archive-keyword-forecasts",
      keyColumns: ["id"],
      mode: "archive_json",
      source: "public.keyword_forecasts",
      target: "migration.source_rows",
    });
    expect(archiveInsertBatchStatement(2)).toContain(
      'VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)',
    );
    const row = { id: "forecast-1", value: 12 };
    const values = archiveRowValues(plan.tables[0]!, row);
    expect(values.slice(0, 4)).toEqual([
      "archive-keyword-forecasts",
      "public.keyword_forecasts",
      '["forecast-1"]',
      row,
    ]);
    expect(values[4]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies deterministic canonical transformations and constants", () => {
    const plan = normaliseDatabaseTransferPlan({
      approved: true,
      sequences: [],
      tables: [
        {
          columns: [
            {
              source: "keyword",
              target: "normalised_keyword",
              transform: "normalise_text",
            },
            {
              source: "source",
              target: "sources",
              transform: "singleton_text_array",
              fallback: "legacy_supabase",
            },
            {
              source: "url",
              target: "normalized_url",
              transform: "normalise_url",
            },
            { target: "generation_source", constant: "deterministic" },
          ],
          id: "copy-transformed",
          mode: "copy",
          source: "public.source_rows",
          target: "public.target_rows",
        },
      ],
      version: 2,
    });

    expect(
      copyRowValues(plan.tables[0]!, {
        normalised_keyword: "  Summer   SHOES ",
        normalized_url: "HTTPS://Example.COM/path#fragment",
        sources: null,
      }),
    ).toEqual([
      "summer shoes",
      ["legacy_supabase"],
      "https://example.com/path",
      "deterministic",
    ]);
  });

  it("rejects unapproved plans and unsafe identifiers", () => {
    expect(() =>
      normaliseDatabaseTransferPlan({
        approved: false,
        tables: [],
        version: 1,
      }),
    ).toThrow("explicitly approved");
    expect(() =>
      normaliseDatabaseTransferPlan({
        approved: true,
        tables: [
          {
            columns: ["id"],
            source: "public.clients;drop",
            target: "public.clients",
          },
        ],
        version: 1,
      }),
    ).toThrow("safe PostgreSQL identifier");
    expect(() =>
      normaliseDatabaseTransferPlan({
        approved: true,
        tables: [
          {
            columns: ["id"],
            disableUserTriggers: "yes",
            id: "copy-clients",
            mode: "copy",
            source: "public.clients",
            target: "public.clients",
          },
        ],
        version: 2,
      }),
    ).toThrow("disableUserTriggers");
  });
});
