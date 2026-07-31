import { normaliseDatabaseTransferPlan } from "./database-transfer.js";

interface CatalogTable {
  archiveKeyColumns: string[];
  runtimeDisposition: string;
  runtimeTarget?: string;
  source: string;
}

interface SourceCatalog {
  expectedTableCount: number;
  tables: CatalogTable[];
  version: 1;
}

interface InventoryColumn {
  name: string;
  schema: string;
  table: string;
}

interface InventoryTable {
  name: string;
  schema: string;
}

interface SourceInventory {
  columns: InventoryColumn[];
  tables: InventoryTable[];
}

function relation(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`${label} is not a safe PostgreSQL identifier.`);
  }
}

export function buildDatabaseArchivePlan(
  catalog: SourceCatalog,
  inventory: SourceInventory,
  approved: boolean,
): Record<string, unknown> {
  if (
    catalog.version !== 1 ||
    !Number.isInteger(catalog.expectedTableCount) ||
    catalog.expectedTableCount < 1 ||
    !Array.isArray(catalog.tables) ||
    catalog.tables.length !== catalog.expectedTableCount
  ) {
    throw new Error("The source table catalog is invalid or incomplete.");
  }
  const catalogNames = new Set<string>();
  for (const [index, table] of catalog.tables.entries()) {
    const [schema, name, extra] = table.source.split(".");
    assertIdentifier(schema, `catalog.tables[${index}].source schema`);
    assertIdentifier(name, `catalog.tables[${index}].source table`);
    if (extra || schema !== "public") {
      throw new Error(`catalog.tables[${index}].source must be a public table.`);
    }
    if (catalogNames.has(table.source)) {
      throw new Error(`The source table catalog contains ${table.source} twice.`);
    }
    catalogNames.add(table.source);
    if (
      !Array.isArray(table.archiveKeyColumns) ||
      table.archiveKeyColumns.length === 0
    ) {
      throw new Error(`${table.source} has no archive key.`);
    }
    for (const key of table.archiveKeyColumns) {
      assertIdentifier(key, `${table.source} archive key`);
    }
    if (!table.runtimeDisposition) {
      throw new Error(`${table.source} has no runtime disposition.`);
    }
  }

  const publicInventoryTables = new Set(
    inventory.tables
      .filter((table) => table.schema === "public")
      .map((table) => relation(table.schema, table.name)),
  );
  const missing = [...catalogNames].filter(
    (table) => !publicInventoryTables.has(table),
  );
  const unmapped = [...publicInventoryTables].filter(
    (table) => !catalogNames.has(table),
  );
  if (missing.length > 0 || unmapped.length > 0) {
    throw new Error(
      `Source catalog mismatch. Missing: ${missing.sort().join(", ") || "none"}. ` +
        `Unmapped: ${unmapped.sort().join(", ") || "none"}.`,
    );
  }

  const columns = new Map<string, Set<string>>();
  for (const column of inventory.columns) {
    const name = relation(column.schema, column.table);
    const bucket = columns.get(name) ?? new Set<string>();
    bucket.add(column.name);
    columns.set(name, bucket);
  }
  for (const table of catalog.tables) {
    const available = columns.get(table.source) ?? new Set<string>();
    for (const key of table.archiveKeyColumns) {
      if (!available.has(key)) {
        throw new Error(`${table.source} is missing archive key column ${key}.`);
      }
    }
  }

  const draft = {
    approved,
    sequences: [],
    tables: [...catalog.tables]
      .sort((left, right) => left.source.localeCompare(right.source))
      .map((table) => ({
        id: `archive-${table.source.slice("public.".length).replaceAll("_", "-")}`,
        keyColumns: table.archiveKeyColumns,
        mode: "archive_json",
        source: table.source,
        target: "migration.source_rows",
      })),
    version: 2,
  };
  if (approved) normaliseDatabaseTransferPlan(draft);
  return draft;
}
