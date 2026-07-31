interface InventoryColumn {
  name: string;
  schema: string;
  table: string;
}

interface InventorySequence {
  name: string;
  schema: string;
}

interface InventoryTable {
  name: string;
  rowCount: number;
  schema: string;
}

export interface DatabaseInventory {
  columns: InventoryColumn[];
  sequences: InventorySequence[];
  tables: InventoryTable[];
}

export interface DatabaseReconciliationMap {
  approved: boolean;
  missingTargetTables: string[];
  sequences: Array<{ source: string; target: string }>;
  tables: Array<{
    checksumMode: "equal";
    columns: string[];
    countMode: "equal";
    source: string;
    sourceOnlyColumns: string[];
    target: string;
    targetOnlyColumns: string[];
  }>;
  version: 1;
}

function relation(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function columnsByRelation(inventory: DatabaseInventory): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const column of inventory.columns) {
    const key = relation(column.schema, column.table);
    const columns = result.get(key) ?? new Set<string>();
    columns.add(column.name);
    result.set(key, columns);
  }
  return result;
}

export function buildDatabaseReconciliationMap(
  source: DatabaseInventory,
  target: DatabaseInventory,
): DatabaseReconciliationMap {
  const sourceColumns = columnsByRelation(source);
  const targetColumns = columnsByRelation(target);
  const targetTables = new Set(
    target.tables
      .filter((table) => table.schema === "public")
      .map((table) => relation(table.schema, table.name)),
  );
  const missingTargetTables: string[] = [];
  const tables: DatabaseReconciliationMap["tables"] = [];

  for (const table of source.tables.filter((item) => item.schema === "public")) {
    const name = relation(table.schema, table.name);
    if (!targetTables.has(name)) {
      missingTargetTables.push(name);
      continue;
    }
    const sourceSet = sourceColumns.get(name) ?? new Set<string>();
    const targetSet = targetColumns.get(name) ?? new Set<string>();
    const common = [...sourceSet].filter((column) => targetSet.has(column)).sort();
    if (common.length === 0) {
      throw new Error(`${name} has no common source and target columns.`);
    }
    tables.push({
      checksumMode: "equal",
      columns: common,
      countMode: "equal",
      source: name,
      sourceOnlyColumns: [...sourceSet]
        .filter((column) => !targetSet.has(column))
        .sort(),
      target: name,
      targetOnlyColumns: [...targetSet]
        .filter((column) => !sourceSet.has(column))
        .sort(),
    });
  }

  const targetSequences = new Set(
    target.sequences.map((sequence) => relation(sequence.schema, sequence.name)),
  );
  const sequences = source.sequences
    .filter((sequence) => sequence.schema === "public")
    .map((sequence) => relation(sequence.schema, sequence.name))
    .filter((name) => targetSequences.has(name))
    .map((name) => ({ source: name, target: name }));

  return {
    approved: false,
    missingTargetTables: missingTargetTables.sort(),
    sequences,
    tables: tables.sort((left, right) => left.source.localeCompare(right.source)),
    version: 1,
  };
}
