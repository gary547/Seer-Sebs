import { describe, expect, it } from "vitest";

import {
  aggregateGscKeywordRows,
  archiveInsertBatchStatement,
  archiveRowValues,
  copyRowValues,
  insertBatchStatement,
  latestSerpSnapshotRows,
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
            {
              source: "metadata",
              target: "metadata",
              transform: "json_value",
            },
            {
              source: "detox_status",
              target: "detox_status",
              transform: "legacy_detox_status",
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
        metadata: [{ email: "member@example.com", name: "Member" }],
        detox_status: "removed",
        sources: null,
      }),
    ).toEqual([
      "summer shoes",
      ["legacy_supabase"],
      "https://example.com/path",
      '[{"email":"member@example.com","name":"Member"}]',
      "remove",
      "deterministic",
    ]);
  });

  it("rejects unknown legacy detox statuses", () => {
    const plan = normaliseDatabaseTransferPlan({
      approved: true,
      sequences: [],
      tables: [
        {
          columns: [
            {
              source: "detox_status",
              target: "detox_status",
              transform: "legacy_detox_status",
            },
          ],
          id: "copy-keywords",
          mode: "copy",
          source: "public.keywords",
          target: "public.keywords",
        },
      ],
      version: 2,
    });

    expect(() =>
      copyRowValues(plan.tables[0]!, { detox_status: "unknown" }),
    ).toThrow("unsupported status unknown");
  });

  it("aggregates duplicate legacy GSC keyword metrics deterministically", () => {
    const plan = normaliseDatabaseTransferPlan({
      approved: true,
      sequences: [],
      tables: [
        {
          columns: [
            "id",
            "upload_id",
            { source: "keyword", target: "query" },
            {
              source: "keyword",
              target: "normalised_query",
              transform: "normalise_text",
            },
            { target: "page", constant: "" },
            { source: "device", target: "device", fallback: "all" },
            "clicks",
            "impressions",
            "ctr",
            "position",
          ],
          id: "canonical-gsc-upload-keywords",
          mode: "copy",
          rowTransform: "aggregate_gsc_keywords",
          source: "public.gsc_upload_keywords",
          target: "public.gsc_upload_keywords",
        },
      ],
      version: 2,
    });
    const table = plan.tables[0];
    if (!table || table.mode !== "copy") throw new Error("Expected copy table.");

    expect(
      aggregateGscKeywordRows(table, [
        {
          clicks: 5,
          ctr: "0.1",
          device: "desktop",
          id: "00000000-0000-4000-8000-000000000002",
          impressions: 50,
          normalised_query: "summer   shoes",
          position: "4",
          query: "summer   shoes",
          upload_id: "10000000-0000-4000-8000-000000000001",
        },
        {
          clicks: 10,
          ctr: "0.1",
          device: "desktop",
          id: "00000000-0000-4000-8000-000000000001",
          impressions: 100,
          normalised_query: " Summer Shoes ",
          position: "2",
          query: " Summer Shoes ",
          upload_id: "10000000-0000-4000-8000-000000000001",
        },
      ]),
    ).toEqual([
      [
        "00000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000001",
        " Summer Shoes ",
        "summer shoes",
        "",
        "desktop",
        15,
        150,
        0.1,
        8 / 3,
      ],
    ]);
  });

  it("keeps the best URL rank from each latest SERP snapshot", () => {
    const plan = normaliseDatabaseTransferPlan({
      approved: true,
      sequences: [],
      tables: [
        {
          columns: [
            "id",
            "project_id",
            "keyword_id",
            "rank_absolute",
            "url",
            "domain",
            {
              source: "fetched_at",
              target: "fetched_at",
              fallback: "1970-01-01T00:00:00Z",
            },
          ],
          id: "canonical-serp-results",
          mode: "copy",
          rowTransform: "latest_serp_snapshot",
          source: "public.serp_results",
          target: "public.serp_results",
        },
      ],
      version: 2,
    });
    const table = plan.tables[0];
    if (!table || table.mode !== "copy") throw new Error("Expected copy table.");
    const row = (
      id: string,
      rank: number,
      url: string,
      fetchedAt: string,
    ) => ({
      domain: new URL(url).hostname,
      fetched_at: new Date(fetchedAt),
      id,
      keyword_id: "10000000-0000-4000-8000-000000000001",
      project_id: "20000000-0000-4000-8000-000000000001",
      rank_absolute: rank,
      url,
    });

    const rows = latestSerpSnapshotRows(table, [
      row("30000000-0000-4000-8000-000000000001", 1, "https://old.test", "2026-01-01T00:00:00Z"),
      row("30000000-0000-4000-8000-000000000002", 2, "https://same.test", "2026-02-01T00:00:00Z"),
      row("30000000-0000-4000-8000-000000000003", 1, "https://same.test", "2026-02-01T00:00:00Z"),
      row("30000000-0000-4000-8000-000000000004", 3, "https://other.test", "2026-02-01T00:00:00Z"),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((result) => [result[0], result[3], result[4]])).toEqual([
      [
        "30000000-0000-4000-8000-000000000003",
        1,
        "https://same.test",
      ],
      [
        "30000000-0000-4000-8000-000000000004",
        3,
        "https://other.test",
      ],
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
