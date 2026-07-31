import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const scanRoots = ["src", "e2e", "gcp"].map((path) => resolve(repositoryRoot, path));
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const ignoredDirectories = new Set(["build", "dist", "node_modules"]);
const forbiddenImports = [
  {
    label: "legacy react-router-dom package",
    pattern: /(?:from\s*|import\s*\()\s*["']react-router-dom(?:\/[^"']*)?["']/g,
  },
  {
    label: "React Router internal RSC entry point",
    pattern:
      /(?:from\s*|import\s*\()\s*["']react-router\/internal\/react-server-client(?:\/[^"']*)?["']/g,
  },
  {
    label: "React Server Components runtime",
    pattern: /(?:from\s*|import\s*\()\s*["']react-server-dom-[^"']+["']/g,
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
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
}

for (const root of scanRoots) {
  await walk(root);
}

const violations = [];

for (const file of files) {
  const contents = await readFile(file, "utf8");
  const lines = contents.split(/\r?\n/);

  for (const { label, pattern } of forbiddenImports) {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      pattern.lastIndex = 0;

      if (pattern.test(lines[lineIndex] ?? "")) {
        violations.push({
          file: relative(repositoryRoot, file),
          label,
          line: lineIndex + 1,
        });
      }
    }
  }
}

const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const routerVersion = packageJson.dependencies?.["react-router"];
const routerDomVersion =
  packageJson.dependencies?.["react-router-dom"] ??
  packageJson.devDependencies?.["react-router-dom"];

if (routerDomVersion) {
  violations.push({
    file: "package.json",
    label: "legacy react-router-dom dependency",
  });
}

const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(routerVersion ?? "");
const routerIsPatched =
  versionMatch !== null &&
  (Number(versionMatch[1]) > 8 ||
    (Number(versionMatch[1]) === 8 && Number(versionMatch[2]) >= 3));

if (!routerIsPatched) {
  violations.push({
    file: "package.json",
    label: "react-router must be pinned to 8.3.0 or newer",
  });
}

if (violations.length > 0) {
  const details = violations
    .map(({ file, label, line }) => `- ${file}${line ? `:${line}` : ""} — ${label}`)
    .join("\n");
  throw new Error(`Router boundary violation:\n${details}`);
}

console.log(`Router boundary check passed (${files.length} source files scanned).`);
