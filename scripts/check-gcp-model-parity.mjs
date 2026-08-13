import { readFile } from "node:fs/promises";

const files = ["revenue-v2.ts", "calibration.ts"];
const normalise = (value) =>
  value
    .replace(
      "outside supabase/functions/_shared/ (enforced by drift guard test).",
      "outside the canonical model package (enforced by drift guard test).",
    )
    .replace(
      "return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;",
      "return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;",
    )
    .replace(
      "return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;",
      "return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;",
    )
    .replaceAll("sorted[i].month", "sorted[i]!.month")
    .replaceAll("sorted[i].volume", "sorted[i]!.volume");

for (const file of files) {
  const [source, target] = await Promise.all([
    readFile(new URL(`../supabase/functions/_shared/${file}`, import.meta.url), "utf8"),
    readFile(new URL(`../gcp/packages/models/src/${file}`, import.meta.url), "utf8"),
  ]);
  if (normalise(source) !== target) {
    throw new Error(`${file} differs from the canonical calculation module.`);
  }
}

const har = await readFile(
  new URL("../gcp/packages/models/src/har-v2.ts", import.meta.url),
  "utf8",
);
if (
  !har.includes("(b.rank_absolute ?? -1) - (a.rank_absolute ?? -1)") ||
  !har.includes("if (!beaten) break;")
) {
  throw new Error("GCP HAR ladder must walk weakest-to-strongest and stop on first failure.");
}

process.stdout.write(
  `GCP model checks passed (${files.length} parity modules plus the corrected HAR ladder).\n`,
);
