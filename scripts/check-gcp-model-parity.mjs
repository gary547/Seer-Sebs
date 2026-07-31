import { readFile } from "node:fs/promises";

const files = ["har-v2.ts", "revenue-v2.ts", "calibration.ts"];
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

process.stdout.write(
  `GCP model parity check passed (${files.length} canonical modules).\n`,
);
