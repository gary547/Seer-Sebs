// Shared safeguard for PostgREST `.in(col, ids)` queries.
//
// A single `.in(...)` call encodes every id into the request URL. With UUIDs
// (~38 bytes each after url-encoding), a list of ~500 ids produces a ~19 KB
// URL which exceeds the edge-runtime / gateway URL length cap and manifests
// as `TypeError: error sending request from <ip>:<port>` with no HTTP status
// and no PostgREST error code (see docs/incident-har-v2-tvs-ongoing-2026-07-16-part2.md).
//
// `selectIn` internally chunks any id list to MAX_IN_CHUNK (100), runs the
// chunked queries sequentially, throws the first PostgREST error unchanged,
// and returns the concatenated rows.
//
// PostgREST also caps un-ranged responses at ~1,000 rows by default. When a
// single chunk (or a filtered whole-table select) can plausibly return more
// than that, callers must page via `.range()`. `selectIn({ paginate:true })`
// pages each IN-chunk in 1,000-row windows until a short page returns;
// `fetchAllRows` does the same for arbitrary filtered selects.

export const MAX_IN_CHUNK = 100;
export const PAGE_SIZE = 1000;

export interface SelectInOptions {
  /** Override chunk size. Hard-capped at MAX_IN_CHUNK. */
  chunkSize?: number;
  /** Apply extra filters (e.g. .eq, .gte) to each chunked query builder. */
  extraFilter?: (q: any) => any;
  /**
   * When true, each IN-chunk is paged via .range() in PAGE_SIZE windows and
   * concatenated. Use for chunks whose result set can plausibly exceed
   * PostgREST's default 1,000-row cap.
   */
  paginate?: boolean;
}

async function pageThrough<T>(
  buildQuery: () => any,
): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  // Hard safety cap: 1,000 pages == 1M rows. Anything beyond this indicates a
  // pathological query and should surface loudly instead of looping forever.
  for (let page = 0; page < 1000; page++) {
    const q = buildQuery().range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data as T[] | null) ?? [];
    for (const row of rows) out.push(row);
    if (rows.length < PAGE_SIZE) return out;
    offset += rows.length;
  }
  throw new Error("pageThrough: exceeded 1,000 pages (>1M rows) — refusing to loop further");
}

export async function selectIn<T = any>(
  sb: any,
  table: string,
  columns: string,
  inColumn: string,
  ids: ReadonlyArray<string | number>,
  opts: SelectInOptions = {},
): Promise<T[]> {
  const requested = opts.chunkSize ?? MAX_IN_CHUNK;
  const size = Math.max(1, Math.min(requested, MAX_IN_CHUNK));
  if (!ids || ids.length === 0) return [];

  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) {
    const slice = ids.slice(i, i + size);
    const build = () => {
      let q: any = sb.from(table).select(columns).in(inColumn, slice);
      if (opts.extraFilter) q = opts.extraFilter(q);
      return q;
    };

    if (opts.paginate) {
      const rows = await pageThrough<T>(build);
      for (const row of rows) out.push(row);
    } else {
      const { data, error } = await build();
      if (error) throw error;
      if (data && data.length) {
        for (const row of data as T[]) out.push(row);
      }
    }
  }
  return out;
}

/**
 * Page an arbitrary filtered select across the PostgREST 1,000-row cap.
 *
 *   const rows = await fetchAllRows(sb, "keywords", "id, keyword",
 *     (q) => q.eq("project_id", pid));
 *
 * `filterFn` receives the raw query builder after `.select()` so callers can
 * chain any combination of .eq/.in/.is/.gte/... exactly as they would inline.
 */
export async function fetchAllRows<T = any>(
  sb: any,
  table: string,
  columns: string,
  filterFn?: (q: any) => any,
): Promise<T[]> {
  return await pageThrough<T>(() => {
    let q: any = sb.from(table).select(columns);
    if (filterFn) q = filterFn(q);
    return q;
  });
}
