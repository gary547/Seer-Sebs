import process from "node:process";

const apiBaseUrl = process.env.SEER_LOCAL_API_URL ?? "http://127.0.0.1:18080";
const keywordCount = Number(process.env.SEER_SCALE_KEYWORD_COUNT ?? "18000");
if (!Number.isInteger(keywordCount) || keywordCount < 1 || keywordCount > 50_000) {
  throw new Error("SEER_SCALE_KEYWORD_COUNT must be an integer from 1 to 50000.");
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function authenticated(token, init = {}) {
  return {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  };
}

async function waitForRun(token, runId) {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const run = await jsonRequest(
      `${apiBaseUrl}/v1/pipeline-runs/${runId}?includeOutput=false`,
      authenticated(token),
    );
    if (run.status === "succeeded" && run.deliveredEventCount === 19) return run;
    if (run.status === "failed") {
      throw new Error(`Scale pipeline failed: ${JSON.stringify(run)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Scale pipeline ${runId} did not complete.`);
}

const startedAt = Date.now();
const suffix = `${Date.now()}-${keywordCount}`;
const email = `scale-${suffix}@example.dev`;
const password = "Local-scale-2026";
const identity = await jsonRequest(`${apiBaseUrl}/v1/local-auth/register`, {
  body: JSON.stringify({ email, password }),
  headers: { "content-type": "application/json" },
  method: "POST",
});
const domain = `scale-${suffix}.test`;
const client = await jsonRequest(
  `${apiBaseUrl}/v1/clients`,
  authenticated(identity.token, {
    body: JSON.stringify({
      brandTerms: ["scale"],
      companyName: "Scale Validation",
      domain,
      industry: "Test",
    }),
    method: "POST",
  }),
);
const project = await jsonRequest(
  `${apiBaseUrl}/v1/clients/${client.id}/projects`,
  authenticated(identity.token, {
    body: JSON.stringify({
      authority: {
        backlinks: 0,
        domainRating: 0,
        referringDomains: 0,
      },
      categoryFocus: "television",
      country: "GB",
      currency: "GBP",
      economics: {
        averageOrderValue: 500,
        conversionRate: 0.02,
        gscWindowDays: 30,
      },
      language: "en",
      name: `Scale ${keywordCount}`,
      rules: {
        blacklist: [],
        competitorBrands: [],
        ownBrands: ["scale"],
        relevantTerms: ["tv", "television"],
        whitelist: [],
      },
    }),
    method: "POST",
  }),
);
const keywords = Array.from({ length: keywordCount }, (_, index) => ({
  avgMonthlyVolume: 100 + (index % 900),
  keywordDifficulty: 10 + (index % 80),
  rankingUrl: `https://${domain}/products/tv-model-${index + 1}`,
  text: `tv model s${index + 1}`,
}));
await jsonRequest(
  `${apiBaseUrl}/v1/projects/${project.id}/keywords`,
  authenticated(identity.token, {
    body: JSON.stringify({ keywords }),
    method: "POST",
  }),
);
await jsonRequest(
  `${apiBaseUrl}/v1/projects/${project.id}/gsc-imports`,
  authenticated(identity.token, {
    body: JSON.stringify({
      rows: [
        {
          clicks: 20,
          ctr: 0.02,
          device: "mobile",
          impressions: 1_000,
          page: `https://${domain}/products/tv-model-1`,
          position: 10,
          query: "tv model s1",
        },
      ],
      sourceName: "scale-validation.csv",
    }),
    method: "POST",
  }),
);
await jsonRequest(
  `${apiBaseUrl}/v1/projects/${project.id}/local-provider-inputs`,
  authenticated(identity.token, {
    body: JSON.stringify({
      keywords: [],
      serpKeywords: [],
      siteArchitectureKeywords: [],
    }),
    method: "PUT",
  }),
);
const createdRun = await jsonRequest(
  `${apiBaseUrl}/v1/projects/${project.id}/pipeline-runs`,
  authenticated(identity.token, { method: "POST" }),
);
const run = await waitForRun(identity.token, createdRun.id);
if (
  run.stages.length !== 19 ||
  !run.stages.every((stage) => stage.state === "succeeded")
) {
  throw new Error("Scale run did not close every stage successfully.");
}
const persisted = await jsonRequest(
  `${apiBaseUrl}/v1/projects/${project.id}`,
  authenticated(identity.token),
);
const expectedScenarioCount = keywordCount * 3;
if (
  persisted.keywordCount !== keywordCount ||
  persisted.calculationCounts?.siteArchitecture !== keywordCount ||
  persisted.calculationCounts?.demandSignals !== keywordCount ||
  persisted.calculationCounts?.clusters !== keywordCount ||
  persisted.calculationCounts?.harForecasts !== expectedScenarioCount ||
  persisted.calculationCounts?.revenueForecasts !== expectedScenarioCount ||
  persisted.calculationCounts?.calibrationSnapshots !== 1
) {
  throw new Error(
    `Scale persistence counts are incorrect: ${JSON.stringify(persisted.calculationCounts)}`,
  );
}
process.stdout.write(
  `${JSON.stringify({
    calculationCounts: persisted.calculationCounts,
    elapsedMs: Date.now() - startedAt,
    keywordCount,
    runId: run.id,
    scaleValidation: true,
  })}\n`,
);
