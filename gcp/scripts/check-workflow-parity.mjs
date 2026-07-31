import { readFile } from "node:fs/promises";

const definitionPath = new URL(
  "../packages/pipeline/src/definition.ts",
  import.meta.url,
);
const workflowPath = new URL(
  "../workflows/pipeline.yaml.tftpl",
  import.meta.url,
);
const [definition, workflow] = await Promise.all([
  readFile(definitionPath, "utf8"),
  readFile(workflowPath, "utf8"),
]);
const identifierBlock = definition.match(
  /export const PIPELINE_STAGE_IDS = \[([\s\S]*?)\] as const;/,
);
if (!identifierBlock) {
  throw new Error("Could not read canonical pipeline stage identifiers.");
}
const canonical = [
  ...identifierBlock[1].matchAll(/"([^"]+)"/g),
].map((match) => match[1]);
const workflowStages = [
  ...workflow.matchAll(/stageId: "([^"]+)"/g),
].map((match) => match[1]);

if (
  canonical.length !== workflowStages.length ||
  canonical.some((stageId, index) => workflowStages[index] !== stageId)
) {
  throw new Error(
    `Workflow stages differ from the canonical definition: ${JSON.stringify({
      canonical,
      workflowStages,
    })}`,
  );
}
if (new Set(workflowStages).size !== workflowStages.length) {
  throw new Error("Workflow contains duplicate stage deliveries.");
}

process.stdout.write(
  `Workflow parity check passed (${workflowStages.length} ordered stages).\n`,
);
