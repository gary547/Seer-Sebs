// Drift guard: hard-coded har_v2.* / revenue_v2.* string literals may only
// live inside supabase/functions/_shared/ or test files. Every other file
// must import HAR_V2_MODEL_VERSION / REVENUE_V2_MODEL_VERSION from _shared.
//
// If this test fails, replace the literal with the shared constant. This
// exists because a producer/consumer version drift silently broke the
// HAR v2 → Revenue v2 handoff in prod.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["supabase/functions", "src"];
const LITERAL_RE = /["'](har|revenue)_v2\.\d/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    // Skip _shared (source of truth) and any test files.
    if (rel.includes("supabase/functions/_shared/")) continue;
    if (/(^|\/)(node_modules|dist|build|\.git)(\/|$)/.test(rel)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
    if (rel.startsWith("src/test/")) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("model version drift guard", () => {
  it("no hard-coded har_v2.* / revenue_v2.* literals outside _shared or tests", () => {
    const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (LITERAL_RE.test(line)) {
          offenders.push({
            file: relative(ROOT, f).replace(/\\/g, "/"),
            line: i + 1,
            text: line.trim(),
          });
        }
      });
    }
    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} hard-coded model-version literal(s) outside _shared:\n${msg}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
