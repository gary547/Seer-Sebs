import { readFile } from "node:fs/promises";

import {
  normaliseKeyword,
  parseRepresentativeProjectFixture,
  summariseRepresentativeFixture,
} from "../../dist/gcp/packages/fixtures/src/representative-project.js";

const apiBaseUrl = process.env.SEER_LOCAL_API_URL ?? "http://127.0.0.1:18080";
const fixtureUrl = new URL("../fixtures/representative-project.json", import.meta.url);

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
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

async function createRun(token, input) {
  return jsonRequest(
    `${apiBaseUrl}/v1/pipeline-runs`,
    authenticated(token, {
      body: JSON.stringify(input),
      method: "POST",
    }),
  );
}

async function waitForTerminalRun(token, runId) {
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    const run = await jsonRequest(
      `${apiBaseUrl}/v1/pipeline-runs/${runId}`,
      authenticated(token),
    );
    if (
      run.status === "failed" ||
      (run.status === "succeeded" && run.deliveredEventCount === 19)
    ) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Synthetic run ${runId} did not reach a terminal state.`);
}

function stage(run, stageId) {
  const result = run.stages.find((candidate) => candidate.id === stageId);
  if (!result) throw new Error(`Synthetic run is missing stage ${stageId}.`);
  return result;
}

function sortedJson(value) {
  return JSON.stringify(
    [...value].sort((left, right) => left.text.localeCompare(right.text)),
  );
}

function assertDataDrivenOutputs(run, expected) {
  const intake = stage(run, "intake").output;
  const promotion = stage(run, "gsc-promotion").output;
  const detox = stage(run, "detox").output;
  const categorisation = stage(run, "categorisation").output;
  const enrichment = stage(run, "keyword-enrichment").output;
  const ranking = stage(run, "ranking-url").output;
  const gscIntent = stage(run, "gsc-intent").output;
  const brand = stage(run, "brand-classification").output;
  const serp = stage(run, "serp-collection").output;
  const authority = stage(run, "authority").output;
  const backlinks = stage(run, "backlinks").output;
  const siteArchitecture = stage(run, "site-architecture").output;
  const linkPowerScore = stage(run, "link-power-score").output;
  const demandSignals = stage(run, "demand-signals").output;
  const ctrCurves = stage(run, "ctr-curves").output;
  const clustering = stage(run, "clustering").output;
  const har = stage(run, "har-v2").output;
  const revenue = stage(run, "revenue-v2").output;
  const calibration = stage(run, "calibration").output;
  if (
    intake?.handlerVersion !== "intake-v1" ||
    intake.sourceKeywordCount !== 12 ||
    promotion?.handlerVersion !== "gsc-promotion-v1" ||
    promotion.processingKeywordCount !== expected.summary.processingKeywordCount ||
    JSON.stringify(promotion.promotedQueries) !==
      JSON.stringify([...expected.promotedQueries].sort()) ||
    detox?.handlerVersion !== "detox-v1" ||
    detox.keptKeywordCount !== expected.summary.keptKeywordCount ||
    detox.removedKeywordCount !== expected.summary.removedKeywordCount ||
    detox.reviewKeywordCount !== expected.summary.reviewKeywordCount ||
    categorisation?.handlerVersion !== "categorisation-v1" ||
    enrichment?.handlerVersion !== "keyword-enrichment-v1" ||
    enrichment.enrichedKeywordCount !== 12 ||
    enrichment.missingProviderCount !== 0 ||
    ranking?.handlerVersion !== "ranking-url-v1" ||
    ranking.matchedCount !== 1 ||
    ranking.noMatchCount !== 0 ||
    gscIntent?.handlerVersion !== "gsc-intent-v1" ||
    gscIntent.resolvedCount !== 8 ||
    gscIntent.genericCount !== 0 ||
    brand?.handlerVersion !== "brand-classification-v1" ||
    brand.brandedCount !== 1 ||
    brand.nonBrandedCount !== 13 ||
    serp?.handlerVersion !== "serp-collection-v1" ||
    serp.matchedKeywordCount !== 4 ||
    serp.missingProviderCount !== 8 ||
    serp.resultCount !== 12 ||
    authority?.handlerVersion !== "authority-v1" ||
    authority.clientResultCount !== 4 ||
    backlinks?.handlerVersion !== "backlinks-v1" ||
    backlinks.enrichedResultCount !== 12 ||
    backlinks.missingResultCount !== 0 ||
    siteArchitecture?.handlerVersion !== "site-architecture-v1" ||
    siteArchitecture.matchedCount !== 5 ||
    siteArchitecture.missingProviderCount !== 7 ||
    linkPowerScore?.handlerVersion !== "link-power-score-v1" ||
    linkPowerScore.scoredResultCount !== 12 ||
    demandSignals?.handlerVersion !== "demand-signals-v1" ||
    demandSignals.sufficientHistoryCount !== 2 ||
    ctrCurves?.handlerVersion !== "ctr-curves-v1" ||
    ctrCurves.curves.length !== 7 ||
    clustering?.handlerVersion !== "clustering-v1" ||
    clustering.clusterCount !== 12 ||
    har?.handlerVersion !== "har-v2.1" ||
    har.scenarioCount !== 36 ||
    revenue?.handlerVersion !== "revenue-v2.1" ||
    revenue.forecastCount !== 36 ||
    calibration?.handlerVersion !== "calibration-v1" ||
    calibration.matched < 1 ||
    calibration.status === "unavailable" ||
    !Object.entries(expected.summary).every(
      ([key, value]) => categorisation.summary?.[key] === value,
    )
  ) {
    throw new Error("Data-driven stage summaries do not match the expected outcomes.");
  }

  const classifications = new Map(
    categorisation.keywords.map((keyword) => [
      keyword.normalisedText,
      keyword.categorisation,
    ]),
  );
  const actualOutcomes = detox.keywords.map((keyword) => {
    const classification = classifications.get(keyword.normalisedText);
    return {
      category: classification?.category ?? null,
      detoxDecision: keyword.detox.decision,
      intent: classification?.intent ?? null,
      text: keyword.normalisedText,
      tier: classification?.tier ?? null,
    };
  });
  const expectedOutcomes = expected.keywordOutcomes.map((outcome) => ({
    ...outcome,
    text: normaliseKeyword(outcome.text),
  }));
  if (sortedJson(actualOutcomes) !== sortedJson(expectedOutcomes)) {
    throw new Error("Data-driven keyword outcomes differ from the fixture expectations.");
  }
}

function assertSuccessfulSyntheticRun(
  run,
  sourceSummary,
  expected,
  expectedCategorisationAttempts = 1,
) {
  if (run.status !== "succeeded") {
    throw new Error(`Synthetic run failed: ${JSON.stringify(run)}`);
  }
  if (run.stages.length !== 19 || run.deliveredEventCount !== 19) {
    throw new Error("Synthetic run did not complete all 19 stages and events.");
  }
  if (
    !run.stages.every(
      (item) =>
        item.state === "succeeded" &&
        item.output?.validationMode === "local-synthetic-contract" &&
        Object.entries(sourceSummary).every(
          ([key, value]) => item.output?.fixtureSummary?.[key] === value,
        ),
    )
  ) {
    throw new Error("Synthetic fixture summary was not preserved through every stage.");
  }
  if (stage(run, "categorisation").attempts !== expectedCategorisationAttempts) {
    throw new Error(
      `Categorisation used ${stage(run, "categorisation").attempts} attempt(s), expected ${expectedCategorisationAttempts}.`,
    );
  }
  assertDataDrivenOutputs(run, expected);
}

const fixture = parseRepresentativeProjectFixture(
  JSON.parse(await readFile(fixtureUrl, "utf8")),
);
const sourceSummary = summariseRepresentativeFixture(fixture);
const email = `synthetic-${Date.now()}@example.dev`;
const password = "Local-synthetic-2026";
const registration = await jsonRequest(`${apiBaseUrl}/v1/local-auth/register`, {
  body: JSON.stringify({ email, password }),
  headers: { "content-type": "application/json" },
  method: "POST",
});
const login = await jsonRequest(`${apiBaseUrl}/v1/local-auth/login`, {
  body: JSON.stringify({ email, password }),
  headers: { "content-type": "application/json" },
  method: "POST",
});
if (registration.user.id !== login.user.id) {
  throw new Error("Synthetic acceptance identity is inconsistent.");
}

const success = await createRun(login.token, {
  fixture,
  purpose: "synthetic-representative-success",
});
const successfulRun = await waitForTerminalRun(login.token, success.id);
assertSuccessfulSyntheticRun(successfulRun, sourceSummary, fixture.expected);

const transient = await createRun(login.token, {
  fixture,
  localValidation: {
    failAttempts: 2,
    failStage: "categorisation",
  },
  purpose: "synthetic-transient-retry",
});
const transientRun = await waitForTerminalRun(login.token, transient.id);
assertSuccessfulSyntheticRun(transientRun, sourceSummary, fixture.expected, 3);

const permanent = await createRun(login.token, {
  fixture,
  localValidation: {
    failAttempts: 5,
    failStage: "keyword-enrichment",
  },
  purpose: "synthetic-permanent-failure",
});
const permanentRun = await waitForTerminalRun(login.token, permanent.id);
const failedStage = stage(permanentRun, "keyword-enrichment");
if (permanentRun.status !== "failed" || failedStage.state !== "failed" || failedStage.attempts !== 5) {
  throw new Error("Permanent failure did not exhaust exactly five deliveries.");
}
if (!permanentRun.stages.every((item) => item.state === "succeeded" || item.state === "failed")) {
  throw new Error("Permanent failure left non-terminal pipeline stages behind.");
}
if (stage(permanentRun, "calibration").state !== "failed") {
  throw new Error("Permanent failure did not propagate to downstream stages.");
}

console.log(
  JSON.stringify({
    fixture: fixture.project.name,
    pipelineSummary: fixture.expected.summary,
    sourceSummary,
    permanentFailureAttempts: failedStage.attempts,
    permanentFailurePropagated: true,
    stagesSucceeded: successfulRun.stages.length,
    syntheticSuccess: true,
    transientCategorisationAttempts: stage(transientRun, "categorisation").attempts,
    transientRetryRecovered: true,
  }),
);
