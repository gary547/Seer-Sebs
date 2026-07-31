import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const requestedRoots = process.argv.slice(2);
const scanRoots = (
  requestedRoots.length > 0 ? requestedRoots : ["gcp", "src"]
).map((path) => resolve(repositoryRoot, path));

const deployableExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".sh",
  ".tf",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const deployableNames = new Set(["Dockerfile"]);
const ignoredDirectories = new Set([".git", "build", "dist", "node_modules"]);
const forbiddenPatterns = [
  {
    label: "Supabase JavaScript SDK",
    pattern: /@supabase\/supabase-js/gi,
  },
  {
    label: "Supabase environment variable",
    pattern: /\bSUPABASE_[A-Z0-9_]+\b/g,
  },
  {
    label: "Supabase hosted endpoint",
    pattern: /\b(?:https?:\/\/)?[a-z0-9-]+\.supabase\.co\b/gi,
  },
];

const files = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }

    if (
      entry.isFile() &&
      (deployableNames.has(entry.name) || deployableExtensions.has(extname(entry.name)))
    ) {
      files.push(path);
    }
  }
}

for (const root of scanRoots) {
  const rootStats = await stat(root).catch(() => null);

  if (!rootStats?.isDirectory()) {
    throw new Error(`GCP boundary root does not exist: ${relative(repositoryRoot, root)}`);
  }

  await walk(root);
}

const violations = [];

for (const file of files) {
  const contents = await readFile(file, "utf8");
  const lines = contents.split(/\r?\n/);

  for (const { label, pattern } of forbiddenPatterns) {
    pattern.lastIndex = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      pattern.lastIndex = 0;

      if (pattern.test(line)) {
        violations.push({
          file: relative(repositoryRoot, file),
          label,
          line: lineIndex + 1,
        });
      }
    }
  }
}

if (violations.length > 0) {
  const details = violations
    .map(({ file, label, line }) => `- ${file}:${line} — ${label}`)
    .join("\n");
  throw new Error(`GCP boundary violation:\n${details}`);
}

console.log(`GCP boundary check passed (${files.length} deployable files scanned).`);
