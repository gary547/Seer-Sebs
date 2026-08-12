import process from "node:process";

const apiBaseUrl = process.env.SEER_LOCAL_API_URL ?? "http://127.0.0.1:18080";

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const registration = await jsonRequest("/v1/local-auth/register", {
  body: JSON.stringify({
    email: `calculation-control-${Date.now()}@example.dev`,
    password: "Local-calculation-control-2026",
    role: "admin",
  }),
  headers: { "content-type": "application/json" },
  method: "POST",
});
const headers = { authorization: `Bearer ${registration.token}` };
const projectList = await jsonRequest("/v1/projects", { headers });
const project = projectList.projects.find((candidate) => !candidate.archived_at);
if (!project) throw new Error("No active local project is available.");

const controlStartedAt = performance.now();
const control = await jsonRequest(
  `/v1/projects/${project.id}/calculation-control`,
  { headers },
);
const controlMilliseconds = Math.round(performance.now() - controlStartedAt);
const requiredSections = [
  "baseRank",
  "brandClassification",
  "clustering",
  "comparisons",
  "contentFit",
  "demand",
  "gscReadiness",
  "recentRuns",
  "serpVisibility",
  "volumeHistory",
];
for (const section of requiredSections) {
  if (!control[section] || typeof control[section] !== "object") {
    throw new Error(`Calculation control is missing ${section}.`);
  }
}
if (!Array.isArray(control.gscReadiness.uploads) || control.gscReadiness.uploads.length > 20) {
  throw new Error("GSC uploads are missing or unbounded.");
}
if (!Array.isArray(control.recentRuns) || control.recentRuns.length > 20) {
  throw new Error("Recent runs are missing or unbounded.");
}
if (!Array.isArray(control.comparisons.items) || control.comparisons.items.length > 50) {
  throw new Error("Comparison rows are missing or unbounded.");
}

console.log(JSON.stringify({
  comparisonRows: control.comparisons.items.length,
  controlMilliseconds,
  projectId: project.id,
  recentRuns: control.recentRuns.length,
  sections: requiredSections.length,
  uploads: control.gscReadiness.uploads.length,
}));
