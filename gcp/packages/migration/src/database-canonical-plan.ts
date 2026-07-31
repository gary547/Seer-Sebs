import {
  normaliseDatabaseTransferPlan,
  type TransferColumn,
} from "./database-transfer.js";

interface InventoryColumn {
  column_default?: string | null;
  data_type?: string;
  is_nullable?: "NO" | "YES";
  name: string;
  schema: string;
  table: string;
  udt_name?: string;
}

interface InventoryTable {
  name: string;
  schema: string;
}

interface DatabaseInventory {
  columns: InventoryColumn[];
  tables: InventoryTable[];
}

interface CatalogTable {
  runtimeDisposition: string;
  runtimeTarget?: string;
  source: string;
}

interface SourceCatalog {
  tables: CatalogTable[];
  version: 1;
}

interface CanonicalRule {
  columns?: TransferColumn[];
  disableUserTriggers?: boolean;
  excludeColumns?: string[];
  loadOrder: number;
  source: string;
  target: string;
}

interface CanonicalRules {
  tables: CanonicalRule[];
  version: 1;
}

export interface DatabaseCanonicalPlanDraft {
  approved: boolean;
  sequences: [];
  tables: Array<{
    columns: TransferColumn[];
    disableUserTriggers: boolean;
    id: string;
    keyColumns: [];
    mode: "copy";
    source: string;
    target: string;
  }>;
  version: 2;
}

const canonicalDispositions = new Set([
  "canonical_copy",
  "canonical_transform",
]);

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`${label} is not a safe PostgreSQL identifier.`);
  }
}

function assertRelation(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid.`);
  }
  const [schema, table, extra] = value.split(".");
  assertIdentifier(schema, `${label} schema`);
  assertIdentifier(table, `${label} table`);
  if (extra) throw new Error(`${label} must contain one schema and table.`);
}

function columnsByRelation(
  inventory: DatabaseInventory,
): Map<string, Map<string, InventoryColumn>> {
  const result = new Map<string, Map<string, InventoryColumn>>();
  for (const column of inventory.columns) {
    assertIdentifier(column.schema, "inventory column schema");
    assertIdentifier(column.table, "inventory column table");
    assertIdentifier(column.name, "inventory column name");
    const relation = `${column.schema}.${column.table}`;
    const table = result.get(relation) ?? new Map<string, InventoryColumn>();
    if (table.has(column.name)) {
      throw new Error(`Inventory contains ${relation}.${column.name} twice.`);
    }
    table.set(column.name, column);
    result.set(relation, table);
  }
  return result;
}

function inventoryRelations(inventory: DatabaseInventory): Set<string> {
  return new Set(
    inventory.tables.map((table) => {
      assertIdentifier(table.schema, "inventory table schema");
      assertIdentifier(table.name, "inventory table name");
      return `${table.schema}.${table.name}`;
    }),
  );
}

function compatibleTypes(
  source: InventoryColumn,
  target: InventoryColumn,
): boolean {
  if (!source.udt_name || !target.udt_name) return true;
  if (source.udt_name === target.udt_name) return true;
  const numeric = new Set(["float4", "float8", "int2", "int4", "int8", "numeric"]);
  if (numeric.has(source.udt_name) && numeric.has(target.udt_name)) return true;
  const text = new Set(["bpchar", "citext", "text", "varchar"]);
  if (text.has(source.udt_name) && text.has(target.udt_name)) return true;
  return source.udt_name === "json" && target.udt_name === "jsonb";
}

function normaliseRuleColumn(
  column: TransferColumn,
  label: string,
): TransferColumn {
  assertIdentifier(column.target, `${label}.target`);
  if (column.source !== null) {
    assertIdentifier(column.source, `${label}.source`);
  }
  return { ...column };
}

export function buildDatabaseCanonicalPlan(
  catalog: SourceCatalog,
  rules: CanonicalRules,
  sourceInventory: DatabaseInventory,
  targetInventory: DatabaseInventory,
  approved: boolean,
): DatabaseCanonicalPlanDraft {
  if (
    catalog.version !== 1 ||
    !Array.isArray(catalog.tables) ||
    rules.version !== 1 ||
    !Array.isArray(rules.tables)
  ) {
    throw new Error("The canonical migration configuration is invalid.");
  }

  const catalogBySource = new Map<string, CatalogTable>();
  for (const [index, table] of catalog.tables.entries()) {
    assertRelation(table.source, `catalog.tables[${index}].source`);
    if (catalogBySource.has(table.source)) {
      throw new Error(`The source catalog contains ${table.source} twice.`);
    }
    catalogBySource.set(table.source, table);
  }

  const expectedRules = new Set(
    catalog.tables
      .filter((table) => canonicalDispositions.has(table.runtimeDisposition))
      .map((table) => table.source),
  );
  const configuredRules = new Set<string>();
  for (const [index, rule] of rules.tables.entries()) {
    assertRelation(rule.source, `rules.tables[${index}].source`);
    assertRelation(rule.target, `rules.tables[${index}].target`);
    if (!Number.isInteger(rule.loadOrder) || rule.loadOrder < 1) {
      throw new Error(`${rule.source} has an invalid load order.`);
    }
    const catalogTable = catalogBySource.get(rule.source);
    if (!catalogTable || !expectedRules.has(rule.source)) {
      throw new Error(`${rule.source} is not approved for canonical migration.`);
    }
    if (catalogTable.runtimeTarget !== rule.target) {
      throw new Error(
        `${rule.source} targets ${rule.target}, expected ${catalogTable.runtimeTarget ?? "none"}.`,
      );
    }
    if (configuredRules.has(rule.source)) {
      throw new Error(`Canonical rules contain ${rule.source} twice.`);
    }
    configuredRules.add(rule.source);
  }
  const missingRules = [...expectedRules].filter(
    (source) => !configuredRules.has(source),
  );
  if (missingRules.length > 0) {
    throw new Error(
      `Canonical migration rules are missing: ${missingRules.sort().join(", ")}.`,
    );
  }

  const sourceRelations = inventoryRelations(sourceInventory);
  const targetRelations = inventoryRelations(targetInventory);
  const sourceColumns = columnsByRelation(sourceInventory);
  const targetColumns = columnsByRelation(targetInventory);

  const tables = [...rules.tables]
    .sort(
      (left, right) =>
        left.loadOrder - right.loadOrder ||
        left.source.localeCompare(right.source),
    )
    .map((rule, ruleIndex) => {
      if (!sourceRelations.has(rule.source)) {
        throw new Error(`Source inventory is missing ${rule.source}.`);
      }
      if (!targetRelations.has(rule.target)) {
        throw new Error(`Target inventory is missing ${rule.target}.`);
      }
      const availableSource =
        sourceColumns.get(rule.source) ?? new Map<string, InventoryColumn>();
      const availableTarget =
        targetColumns.get(rule.target) ?? new Map<string, InventoryColumn>();
      const excluded = new Set(rule.excludeColumns ?? []);
      for (const column of excluded) {
        assertIdentifier(column, `${rule.source} excluded column`);
        if (!availableSource.has(column)) {
          throw new Error(`${rule.source} cannot exclude missing column ${column}.`);
        }
      }

      const explicit = (rule.columns ?? []).map((column, columnIndex) =>
        normaliseRuleColumn(
          column,
          `rules.tables[${ruleIndex}].columns[${columnIndex}]`,
        ),
      );
      const explicitTargets = new Set<string>();
      for (const column of explicit) {
        if (explicitTargets.has(column.target)) {
          throw new Error(`${rule.source} maps target ${column.target} twice.`);
        }
        explicitTargets.add(column.target);
        const target = availableTarget.get(column.target);
        if (!target) {
          throw new Error(`${rule.target}.${column.target} does not exist.`);
        }
        if (column.source !== null) {
          const source = availableSource.get(column.source);
          if (!source) {
            throw new Error(`${rule.source}.${column.source} does not exist.`);
          }
          if (!column.transform && !compatibleTypes(source, target)) {
            throw new Error(
              `${rule.source}.${column.source} is incompatible with ${rule.target}.${column.target}.`,
            );
          }
        }
      }

      const implicit: TransferColumn[] = [];
      for (const target of availableTarget.values()) {
        if (explicitTargets.has(target.name) || excluded.has(target.name)) continue;
        const source = availableSource.get(target.name);
        if (!source) continue;
        if (
          source.is_nullable === "YES" &&
          target.is_nullable === "NO" &&
          target.column_default
        ) {
          continue;
        }
        if (!compatibleTypes(source, target)) {
          throw new Error(
            `${rule.source}.${source.name} is incompatible with ${rule.target}.${target.name}.`,
          );
        }
        implicit.push({ source: source.name, target: target.name });
      }
      const columns = [...implicit, ...explicit];
      const mappedTargets = new Set(columns.map((column) => column.target));
      const missingRequired = [...availableTarget.values()]
        .filter(
          (column) =>
            column.is_nullable === "NO" &&
            !column.column_default &&
            !mappedTargets.has(column.name),
        )
        .map((column) => column.name);
      if (missingRequired.length > 0) {
        throw new Error(
          `${rule.source} cannot populate required ${rule.target} columns: ${missingRequired.join(", ")}.`,
        );
      }
      if (columns.length === 0) {
        throw new Error(`${rule.source} has no canonical columns.`);
      }
      return {
        columns,
        disableUserTriggers: rule.disableUserTriggers === true,
        id: `canonical-${rule.source.slice(rule.source.indexOf(".") + 1).replaceAll("_", "-")}`,
        keyColumns: [] as [],
        mode: "copy" as const,
        source: rule.source,
        target: rule.target,
      };
    });

  const draft: DatabaseCanonicalPlanDraft = {
    approved,
    sequences: [],
    tables,
    version: 2,
  };
  if (approved) normaliseDatabaseTransferPlan(draft);
  return draft;
}
