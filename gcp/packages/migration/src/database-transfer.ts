export type TransferTransform =
  | "json_array_or_empty"
  | "json_value"
  | "normalise_text"
  | "normalise_url"
  | "singleton_text_array";

export type TransferValue = boolean | number | string | string[];

export interface TransferColumn {
  constant?: TransferValue;
  fallback?: TransferValue;
  source: string | null;
  target: string;
  transform?: TransferTransform;
}

export interface CopyTransferTable {
  columns: TransferColumn[];
  disableUserTriggers: boolean;
  id: string;
  keyColumns: [];
  mode: "copy";
  source: string;
  target: string;
}

export interface ArchiveTransferTable {
  columns: [];
  id: string;
  keyColumns: string[];
  mode: "archive_json";
  source: string;
  target: "migration.source_rows";
}

export type TransferTable = ArchiveTransferTable | CopyTransferTable;

export interface DatabaseTransferPlan {
  approved: true;
  sequences: Array<{ source: string; target: string }>;
  tables: TransferTable[];
  version: 1 | 2;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`${label} is not a safe PostgreSQL identifier.`);
  }
  return value;
}

function relation(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid.`);
  }
  const parts = value.split(".");
  if (parts.length !== 2) {
    throw new Error(`${label} must contain a schema and table name.`);
  }
  return parts
    .map((part, index) => identifier(part, `${label} part ${index + 1}`))
    .join(".");
}

function columns(value: unknown, label: string): TransferColumn[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one column.`);
  }
  const result = value.map((column, index) => {
    if (typeof column === "string") {
      const name = identifier(column, `${label}[${index}]`);
      return { source: name, target: name };
    }
    if (!column || typeof column !== "object" || Array.isArray(column)) {
      throw new Error(`${label}[${index}] is invalid.`);
    }
    const record = column as Record<string, unknown>;
    const target = identifier(record.target, `${label}[${index}].target`);
    if (Object.hasOwn(record, "constant")) {
      if (
        !isTransferValue(record.constant) ||
        (typeof record.constant === "number" &&
          !Number.isFinite(record.constant))
      ) {
        throw new Error(`${label}[${index}].constant is invalid.`);
      }
      if (
        (Object.hasOwn(record, "source") && record.source !== null) ||
        Object.hasOwn(record, "fallback") ||
        Object.hasOwn(record, "transform")
      ) {
        throw new Error(
          `${label}[${index}] cannot combine constant with source rules.`,
        );
      }
      return {
        constant: record.constant,
        source: null,
        target,
      };
    }
    const source = identifier(record.source, `${label}[${index}].source`);
    const transform = record.transform;
    if (
      transform !== undefined &&
      transform !== "json_array_or_empty" &&
      transform !== "json_value" &&
      transform !== "normalise_text" &&
      transform !== "normalise_url" &&
      transform !== "singleton_text_array"
    ) {
      throw new Error(`${label}[${index}].transform is invalid.`);
    }
    const result: TransferColumn = {
      source,
      target,
    };
    if (transform !== undefined) {
      result.transform = transform;
    }
    if (Object.hasOwn(record, "fallback")) {
      if (
        !isTransferValue(record.fallback) ||
        (typeof record.fallback === "number" &&
          !Number.isFinite(record.fallback))
      ) {
        throw new Error(`${label}[${index}].fallback is invalid.`);
      }
      result.fallback = record.fallback;
    }
    return result;
  });
  if (new Set(result.map((column) => column.target)).size !== result.length) {
    throw new Error(`${label} contains duplicate target columns.`);
  }
  return result;
}

function isTransferValue(value: unknown): value is TransferValue {
  return (
    ["boolean", "number", "string"].includes(typeof value) ||
    (Array.isArray(value) &&
      value.every((item) => typeof item === "string"))
  );
}

function normaliseText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function normaliseUrl(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const url = new URL(value.trim());
  url.hash = "";
  return url.toString().toLowerCase();
}

export function copyRowValues(
  table: TransferTable,
  sourceRow: Record<string, unknown>,
): unknown[] {
  if (table.mode !== "copy") {
    throw new Error("copyRowValues requires a copy table.");
  }
  return table.columns.map((column) => {
    if (Object.hasOwn(column, "constant")) {
      return column.constant;
    }
    if (column.source === null || !Object.hasOwn(sourceRow, column.target)) {
      throw new Error(
        `Copy source column ${table.source}.${column.source ?? "unknown"} is missing from a source row.`,
      );
    }
    const sourceValue = sourceRow[column.target];
    const value =
      (sourceValue === null || sourceValue === undefined) &&
      Object.hasOwn(column, "fallback")
        ? column.fallback
        : sourceValue;
    if (column.transform === "json_array_or_empty") {
      if (value !== null && value !== undefined && !Array.isArray(value)) {
        throw new Error(
          `${table.source}.${column.source} for ${column.target} must be an array.`,
        );
      }
      return JSON.stringify(value ?? []);
    }
    if (column.transform === "json_value") {
      if (value === null || value === undefined) return value;
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new Error(
          `${table.source}.${column.source} for ${column.target} is not JSON serializable.`,
        );
      }
      return encoded;
    }
    if (!column.transform || value === null || value === undefined) {
      return value;
    }
    if (column.transform === "normalise_text") {
      return normaliseText(
        value,
        `${table.source}.${column.source} for ${column.target}`,
      );
    }
    if (column.transform === "normalise_url") {
      return normaliseUrl(
        value,
        `${table.source}.${column.source} for ${column.target}`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `${table.source}.${column.source} for ${column.target} must be a string.`,
      );
    }
    return [value];
  });
}

function planEntryId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)
  ) {
    throw new Error(`${label} is not a safe plan entry identifier.`);
  }
  return value;
}

function keyColumns(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one key column.`);
  }
  const result = value.map((column, index) =>
    identifier(column, `${label}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} contains duplicate columns.`);
  }
  return result;
}

export function normaliseDatabaseTransferPlan(
  value: unknown,
): DatabaseTransferPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The database transfer plan is invalid.");
  }
  const record = value as Record<string, unknown>;
  if ((record.version !== 1 && record.version !== 2) || record.approved !== true) {
    throw new Error(
      "The database transfer plan must be version 1 or 2 and explicitly approved.",
    );
  }
  if (!Array.isArray(record.tables) || record.tables.length === 0) {
    throw new Error("The database transfer plan contains no tables.");
  }
  const tables: TransferTable[] = record.tables.map((table, index) => {
    if (!table || typeof table !== "object" || Array.isArray(table)) {
      throw new Error(`tables[${index}] is invalid.`);
    }
    const item = table as Record<string, unknown>;
    const source = relation(item.source, `tables[${index}].source`);
    const target = relation(item.target, `tables[${index}].target`);
    if (record.version === 2 && item.mode === "archive_json") {
      if (target !== "migration.source_rows") {
        throw new Error(
          `tables[${index}].target must be migration.source_rows for archive_json mode.`,
        );
      }
      return {
        columns: [],
        id: planEntryId(item.id, `tables[${index}].id`),
        keyColumns: keyColumns(
          item.keyColumns,
          `tables[${index}].keyColumns`,
        ),
        mode: "archive_json",
        source,
        target,
      };
    }
    if (record.version === 2 && item.mode !== "copy") {
      throw new Error(`tables[${index}].mode is invalid.`);
    }
    if (
      record.version === 2 &&
      Object.hasOwn(item, "disableUserTriggers") &&
      typeof item.disableUserTriggers !== "boolean"
    ) {
      throw new Error(`tables[${index}].disableUserTriggers is invalid.`);
    }
    return {
      columns: columns(item.columns, `tables[${index}].columns`),
      disableUserTriggers:
        record.version === 2 && item.disableUserTriggers === true,
      id:
        record.version === 2
          ? planEntryId(item.id, `tables[${index}].id`)
          : `copy-${source.replace(".", "-")}`,
      keyColumns: [],
      mode: "copy",
      source,
      target,
    };
  });
  if (new Set(tables.map((table) => table.id)).size !== tables.length) {
    throw new Error("The database transfer plan contains duplicate entry IDs.");
  }
  const copyTargets = tables
    .filter((table) => table.mode === "copy")
    .map((table) => table.target);
  if (new Set(copyTargets).size !== copyTargets.length) {
    throw new Error("The database transfer plan contains duplicate copy targets.");
  }
  const sequences = Array.isArray(record.sequences)
    ? record.sequences.map((sequence, index) => {
        if (!sequence || typeof sequence !== "object" || Array.isArray(sequence)) {
          throw new Error(`sequences[${index}] is invalid.`);
        }
        const item = sequence as Record<string, unknown>;
        return {
          source: relation(item.source, `sequences[${index}].source`),
          target: relation(item.target, `sequences[${index}].target`),
        };
      })
    : [];
  return {
    approved: true,
    sequences,
    tables,
    version: record.version,
  };
}

export function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function quotedRelation(value: string): string {
  return value.split(".").map(quotedIdentifier).join(".");
}

export function insertBatchStatement(
  table: TransferTable,
  rowCount: number,
): string {
  if (table.mode !== "copy") {
    throw new Error("insertBatchStatement requires a copy table.");
  }
  if (!Number.isInteger(rowCount) || rowCount < 1) {
    throw new Error("rowCount must be a positive integer.");
  }
  const columnsSql = table.columns
    .map((column) => quotedIdentifier(column.target))
    .join(", ");
  const values = Array.from({ length: rowCount }, (_, rowIndex) => {
    const placeholders = table.columns.map(
      (_, columnIndex) =>
        `$${rowIndex * table.columns.length + columnIndex + 1}`,
    );
    return `(${placeholders.join(", ")})`;
  });
  return `INSERT INTO ${quotedRelation(table.target)} (${columnsSql}) VALUES ${values.join(", ")}`;
}

export function archiveInsertBatchStatement(rowCount: number): string {
  if (!Number.isInteger(rowCount) || rowCount < 1) {
    throw new Error("rowCount must be a positive integer.");
  }
  const columns = [
    "plan_entry_id",
    "source_table",
    "source_key",
    "source_row",
    "row_sha256",
  ];
  const values = Array.from({ length: rowCount }, (_, rowIndex) => {
    const placeholders = columns.map(
      (_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`,
    );
    return `(${placeholders.join(", ")})`;
  });
  return (
    `INSERT INTO "migration"."source_rows" ` +
    `(${columns.map(quotedIdentifier).join(", ")}) VALUES ${values.join(", ")}`
  );
}

export function archiveRowValues(
  table: TransferTable,
  sourceRow: Record<string, unknown>,
): [string, string, string, Record<string, unknown>, string] {
  if (table.mode !== "archive_json") {
    throw new Error("archiveRowValues requires an archive_json table.");
  }
  const keyValues = table.keyColumns.map((column) => {
    if (!Object.hasOwn(sourceRow, column)) {
      throw new Error(
        `Archive key column ${table.source}.${column} is missing from a source row.`,
      );
    }
    return sourceRow[column];
  });
  const sourceKey = JSON.stringify(keyValues);
  const sourceJson = JSON.stringify(sourceRow);
  return [
    table.id,
    table.source,
    sourceKey,
    sourceRow,
    createHash("sha256").update(sourceJson).digest("hex"),
  ];
}
import { createHash } from "node:crypto";
