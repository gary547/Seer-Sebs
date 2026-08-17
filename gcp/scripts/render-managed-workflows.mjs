import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertHttpsUrl(name, value) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS.`);
  }
}

function render(template, replacements) {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`\${${key}}`, value);
  }
  output = output.replaceAll("$${", "${");

  for (const key of Object.keys(replacements)) {
    if (output.includes(`\${${key}}`)) {
      throw new Error(`Workflow placeholder ${key} was not resolved.`);
    }
  }
  return output;
}

const projectId = required("SEER_WORKFLOW_PROJECT_ID");
const apiUrl = required("SEER_WORKFLOW_API_URL");
const workerUrl = required("SEER_WORKFLOW_WORKER_URL");
const internalSecretId = required("SEER_WORKFLOW_INTERNAL_SECRET_ID");
const outputDirectory = required("SEER_WORKFLOW_OUTPUT_DIRECTORY");

if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
  throw new Error("SEER_WORKFLOW_PROJECT_ID is invalid.");
}
assertHttpsUrl("SEER_WORKFLOW_API_URL", apiUrl);
assertHttpsUrl("SEER_WORKFLOW_WORKER_URL", workerUrl);

const [pipelineTemplate, maintenanceTemplate] = await Promise.all([
  readFile("gcp/workflows/pipeline.yaml.tftpl", "utf8"),
  readFile("gcp/workflows/maintenance.yaml.tftpl", "utf8"),
]);

const pipeline = render(pipelineTemplate, {
  internal_secret_id: internalSecretId,
  project_id: projectId,
  worker_url: workerUrl,
});
const maintenance = render(maintenanceTemplate, {
  api_url: apiUrl,
  internal_secret_id: internalSecretId,
  project_id: projectId,
});

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(`${outputDirectory}/pipeline.yaml`, pipeline, { mode: 0o600 }),
  writeFile(`${outputDirectory}/maintenance.yaml`, maintenance, { mode: 0o600 }),
]);

console.log(
  JSON.stringify({
    maintenance: `${outputDirectory}/maintenance.yaml`,
    pipeline: `${outputDirectory}/pipeline.yaml`,
  }),
);
