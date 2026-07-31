import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import process from "node:process";

const forbidden = ["supa", "base"].join("");
const scanExtensions = new Set([".js", ".json", ".map"]);
const files: string[] = ["/app/package.json", "/app/package-lock.json"];

async function walk(directory: string): Promise<void> {
  const metadata = await stat(directory).catch(() => null);

  if (!metadata?.isDirectory()) {
    return;
  }

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      await walk(path);
    } else if (entry.isFile() && scanExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
}

await walk("/app/dist");

for (const file of files) {
  const contents = await readFile(file, "utf8");

  if (contents.toLowerCase().includes(forbidden)) {
    throw new Error(`Forbidden runtime dependency marker found in ${file}.`);
  }
}

for (const [name, value] of Object.entries(process.env)) {
  if (`${name}=${value ?? ""}`.toLowerCase().includes(forbidden)) {
    throw new Error(`Forbidden runtime environment marker found in ${name}.`);
  }
}

console.log(`Runtime boundary check passed (${files.length} image files scanned).`);
