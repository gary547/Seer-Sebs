import { spawnSync } from "node:child_process";

const marker = ["supa", "base"].join("");
const compose = ["compose", "-f", "gcp/docker-compose.local.yml"];

function run(argumentsList) {
  const result = spawnSync("docker", argumentsList, {
    encoding: "utf8",
    maxBuffer: 10 * 1_024 * 1_024,
  });

  if (result.status !== 0) {
    throw new Error(
      `docker ${argumentsList.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }

  return result.stdout;
}

const renderedConfig = run([...compose, "config", "--format", "json"]);

if (renderedConfig.toLowerCase().includes(marker)) {
  throw new Error("Forbidden provider marker found in rendered Compose configuration.");
}

const containerIds = run([...compose, "ps", "-q"])
  .split(/\r?\n/)
  .filter(Boolean);

for (const containerId of containerIds) {
  const inspection = run(["inspect", containerId]);

  if (inspection.toLowerCase().includes(marker)) {
    throw new Error(`Forbidden provider marker found in container ${containerId}.`);
  }
}

const imageCheck = run([
  "run",
  "--rm",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--entrypoint",
  "node",
  "seer-gcp-runtime:local",
  "dist/gcp/tools/runtime-boundary.js",
]);

process.stdout.write(imageCheck);
console.log(
  `Local boundary check passed (${containerIds.length} containers inspected).`,
);
