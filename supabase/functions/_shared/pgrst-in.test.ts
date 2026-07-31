// Deno tests for selectIn — verifies chunking boundaries and error propagation.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchAllRows, MAX_IN_CHUNK, PAGE_SIZE, selectIn } from "./pgrst-in.ts";

interface Call {
  table: string;
  columns: string;
  inColumn: string;
  ids: (string | number)[];
}

function makeMock(opts: {
  rowFor?: (id: string | number) => Record<string, unknown>;
  failOnCall?: number; // 1-indexed; throws PostgREST-like error
}) {
  const calls: Call[] = [];
  const sb = {
    from(table: string) {
      const state: Partial<Call> = { table };
      const builder: any = {
        select(columns: string) {
          state.columns = columns;
          return builder;
        },
        in(inColumn: string, ids: (string | number)[]) {
          state.inColumn = inColumn;
          state.ids = [...ids];
          calls.push(state as Call);
          const callIndex = calls.length;
          return {
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              if (opts.failOnCall === callIndex) {
                return resolve({ data: null, error: { message: "boom", code: "PGRST123" } });
              }
              const data = (state.ids ?? []).map((id) =>
                opts.rowFor ? opts.rowFor(id) : { id },
              );
              return resolve({ data, error: null });
            },
          };
        },
      };
      return builder;
    },
  };
  return { sb, calls };
}

Deno.test("selectIn: empty list issues no query", async () => {
  const { sb, calls } = makeMock({});
  const rows = await selectIn(sb, "t", "id", "id", []);
  assertEquals(rows, []);
  assertEquals(calls.length, 0);
});

Deno.test("selectIn: 1 id → 1 chunk of 1", async () => {
  const { sb, calls } = makeMock({});
  const rows = await selectIn<{ id: string }>(sb, "t", "id", "id", ["a"]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].ids.length, 1);
  assertEquals(rows.length, 1);
});

Deno.test("selectIn: 100 ids → 1 chunk", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `k${i}`);
  const { sb, calls } = makeMock({});
  const rows = await selectIn(sb, "t", "id", "id", ids);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].ids.length, 100);
  assertEquals(rows.length, 100);
});

Deno.test("selectIn: 101 ids → 2 chunks (100, 1)", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `k${i}`);
  const { sb, calls } = makeMock({});
  const rows = await selectIn(sb, "t", "id", "id", ids);
  assertEquals(calls.length, 2);
  assertEquals(calls[0].ids.length, 100);
  assertEquals(calls[1].ids.length, 1);
  assertEquals(rows.length, 101);
});

Deno.test("selectIn: 350 ids → 4 chunks (100,100,100,50), order preserved", async () => {
  const ids = Array.from({ length: 350 }, (_, i) => `k${i}`);
  const { sb, calls } = makeMock({});
  const rows = await selectIn<{ id: string }>(sb, "t", "id", "id", ids);
  assertEquals(calls.length, 4);
  assertEquals(calls.map((c) => c.ids.length), [100, 100, 100, 50]);
  assertEquals(rows.length, 350);
  assertEquals(rows[0].id, "k0");
  assertEquals(rows[349].id, "k349");
});

Deno.test("selectIn: chunkSize override is hard-capped at MAX_IN_CHUNK", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `k${i}`);
  const { sb, calls } = makeMock({});
  await selectIn(sb, "t", "id", "id", ids, { chunkSize: 500 });
  assertEquals(calls.map((c) => c.ids.length), [MAX_IN_CHUNK, MAX_IN_CHUNK, 50]);
});

Deno.test("selectIn: first error thrown unchanged, subsequent chunks not run", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `k${i}`);
  const { sb, calls } = makeMock({ failOnCall: 2 });
  let caught: any = null;
  try {
    await selectIn(sb, "t", "id", "id", ids);
  } catch (e) {
    caught = e;
  }
  assertEquals(caught?.code, "PGRST123");
  assertEquals(caught?.message, "boom");
  // Only 2 calls executed before rejection.
  assertEquals(calls.length, 2);
});

// ---------------------------------------------------------------------------
// Pagination tests (selectIn { paginate: true } + fetchAllRows)
// ---------------------------------------------------------------------------
//
// PostgREST caps un-ranged responses at 1,000 rows. When paginate is on we
// should loop .range(offset, offset + PAGE_SIZE - 1) until a short page returns.

interface RangeCall {
  table: string;
  from: number;
  to: number;
  ids?: (string | number)[];
}

/** Mock that supports .in(...).range(from,to) OR .range(from,to) chains and
 *  serves a synthetic total of `total` rows per query. */
function makePagedMock(total: number) {
  const calls: RangeCall[] = [];
  function makeBuilder(table: string, ids?: (string | number)[]) {
    const b: any = {
      select(_c: string) { return b; },
      eq(_c: string, _v: unknown) { return b; },
      in(_c: string, arr: (string | number)[]) {
        ids = [...arr];
        return b;
      },
      range(from: number, to: number) {
        calls.push({ table, from, to, ids });
        const pageSize = to - from + 1;
        const start = from;
        const end = Math.min(to + 1, total);
        const rowsInPage = Math.max(0, end - start);
        // Enforce PostgREST's short-page-when-exhausted contract.
        const data = Array.from({ length: rowsInPage }, (_, i) => ({ id: `row-${start + i}` }));
        return {
          then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
            return resolve({ data, error: null });
          },
        };
      },
    };
    return b;
  }
  const sb = { from(table: string) { return makeBuilder(table); } };
  return { sb, calls };
}

for (const total of [999, 1000, 1001, 2500]) {
  Deno.test(`fetchAllRows: pages ${total} rows correctly`, async () => {
    const { sb, calls } = makePagedMock(total);
    const rows = await fetchAllRows<{ id: string }>(sb, "t", "id", (q) => q.eq("project_id", "p"));
    assertEquals(rows.length, total);
    // Expected page count: ceil(total/PAGE_SIZE), plus one extra call ONLY when
    // total is an exact multiple of PAGE_SIZE (short page terminates the loop).
    const expected = total % PAGE_SIZE === 0 ? total / PAGE_SIZE + 1 : Math.ceil(total / PAGE_SIZE);
    assertEquals(calls.length, expected);
    // First page always starts at 0.
    assertEquals(calls[0].from, 0);
    assertEquals(calls[0].to, PAGE_SIZE - 1);
  });

  Deno.test(`selectIn paginate: single chunk of ${total} rows pages correctly`, async () => {
    const { sb, calls } = makePagedMock(total);
    // Small id list so chunking stays at one chunk; the mock ignores the ids
    // for the row-count math but records that .in() was called.
    const rows = await selectIn<{ id: string }>(sb, "t", "id", "upload_id", ["u1"], { paginate: true });
    assertEquals(rows.length, total);
    const expected = total % PAGE_SIZE === 0 ? total / PAGE_SIZE + 1 : Math.ceil(total / PAGE_SIZE);
    assertEquals(calls.length, expected);
    assertEquals(calls[0].from, 0);
    assertEquals(calls[0].to, PAGE_SIZE - 1);
    // Each recorded call carried the ids from the chunked .in() call.
    for (const c of calls) assertEquals(c.ids, ["u1"]);
  });
}
