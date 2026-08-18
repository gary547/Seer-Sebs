import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import {
  normaliseKeyword,
  parseRepresentativeProjectFixture,
} from "../../dist/gcp/packages/fixtures/src/representative-project.js";
import { attachPipelineRunOutputs } from "./pipeline-run-outputs.mjs";

const apiBaseUrl = process.env.SEER_LOCAL_API_URL ?? "http://127.0.0.1:18080";
const statePath =
  process.env.SEER_PROJECT_VALIDATION_STATE ??
  "/private/tmp/seer-gcp-project-validation-state.json";
const fixtureUrl = new URL("../fixtures/representative-project.json", import.meta.url);

async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  return { body, response };
}

async function jsonRequest(url, init = {}) {
  const result = await request(url, init);
  if (!result.response.ok) {
    throw new Error(
      `${url} returned ${result.response.status}: ${JSON.stringify(result.body)}`,
    );
  }
  return result.body;
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

async function register(email, role = "user") {
  return jsonRequest(`${apiBaseUrl}/v1/local-auth/register`, {
    body: JSON.stringify({ email, password: "Local-project-data-2026", role }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function waitForRun(token, runId) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const run = await jsonRequest(
      `${apiBaseUrl}/v1/pipeline-runs/${runId}`,
      authenticated(token),
    );
    if (run.status === "succeeded" && run.deliveredEventCount === 24) {
      return attachPipelineRunOutputs({
        apiBaseUrl,
        jsonRequest,
        requestInit: authenticated(token),
        run,
      });
    }
    if (run.status === "failed") {
      throw new Error(`Project-backed pipeline failed: ${JSON.stringify(run)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Project-backed pipeline ${runId} did not complete.`);
}

function stage(run, stageId) {
  const output = run.stages.find((candidate) => candidate.id === stageId)?.output;
  if (!output) throw new Error(`Project-backed run is missing ${stageId} output.`);
  return output;
}

function assertProjectState(project, fixture) {
  if (
    project.keywordCount !== 14 ||
    project.gscRowCount !== 9 ||
    project.serpResultCount !== 12 ||
    project.calculationCounts?.siteArchitecture !== 12 ||
    project.calculationCounts?.linkPowerScores !== 12 ||
    project.calculationCounts?.demandSignals !== 12 ||
    project.calculationCounts?.ctrCurves !== 5 ||
    project.calculationCounts?.clusters !== 12 ||
    project.calculationCounts?.harForecasts !== 36 ||
    project.calculationCounts?.revenueForecasts !== 36 ||
    project.calculationCounts?.calibrationSnapshots !== 1 ||
    project.authorityMetrics?.domainRating !== fixture.authority.domainRating ||
    project.authorityMetrics?.referringDomains !==
      fixture.authority.referringDomains ||
    project.authorityMetrics?.backlinks !== fixture.authority.backlinks
  ) {
    throw new Error(`Project counts are incorrect: ${JSON.stringify(project)}`);
  }
  const actual = project.keywords
    .map((keyword) => ({
      category: keyword.categorisation?.category ?? null,
      detoxDecision: keyword.detox.status,
      intent: keyword.categorisation?.intent ?? null,
      text: normaliseKeyword(keyword.text),
      tier: keyword.categorisation?.tier ?? null,
    }))
    .sort((left, right) => left.text.localeCompare(right.text));
  const expected = fixture.expected.keywordOutcomes
    .map((outcome) => ({
      ...outcome,
      text: normaliseKeyword(outcome.text),
    }))
    .sort((left, right) => left.text.localeCompare(right.text));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Persisted project keyword outcomes differ from expectations.");
  }
  const branded = project.keywords.filter(
    (keyword) => keyword.brand?.isBranded === true,
  );
  if (
    branded.length !== 1 ||
    normaliseKeyword(branded[0].text) !== "northstar tv deals"
  ) {
    throw new Error("Persisted brand classifications differ from expectations.");
  }
}

async function validatePersistence() {
  const fixture = parseRepresentativeProjectFixture(
    JSON.parse(await readFile(fixtureUrl, "utf8")),
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const project = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${state.projectId}`,
    authenticated(state.token),
  );
  assertProjectState(project, fixture);
  console.log(
    JSON.stringify({
      keywordCount: project.keywordCount,
      mode: "project-data-persistence",
      projectPersisted: true,
    }),
  );
}

async function validateEndToEnd() {
  const fixture = parseRepresentativeProjectFixture(
    JSON.parse(await readFile(fixtureUrl, "utf8")),
  );
  const timestamp = Date.now();
  const liveDomain = `northstar-${timestamp}.test`;
  const replaceFixtureDomain = (value) =>
    value?.replace(
      `https://${fixture.client.domain}`,
      `https://${liveDomain}`,
    ) ?? null;
  const identity = await register(`project-data-${timestamp}@example.dev`);
  const client = await jsonRequest(
    `${apiBaseUrl}/v1/clients`,
    authenticated(identity.token, {
      body: JSON.stringify({
        companyName: fixture.client.companyName,
        domain: liveDomain,
        industry: fixture.client.industry,
        brandTerms: fixture.client.brandTerms,
      }),
      method: "POST",
    }),
  );
  const updatedClient = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${client.id}`,
    authenticated(identity.token, {
      body: JSON.stringify({
        analyticsConnected: true,
        campaignType: "project",
        companyName: fixture.client.companyName,
        competitors: [
          {
            competitorDomain: "competitor.example",
            competitorName: "Competitor",
            verified: true,
          },
        ],
        domain: liveDomain,
        gscConnected: true,
        industry: fixture.client.industry,
        keywordRules: [
          {
            keywordCategorisation: "protected phrase",
            ruleType: "whitelist",
          },
        ],
        teamMembers: [
          { email: "owner@example.dev", name: "Project Owner" },
        ],
      }),
      method: "PATCH",
    }),
  );
  if (
    updatedClient.analytics_connected !== true ||
    updatedClient.gsc_connected !== true ||
    updatedClient.competitors?.length !== 1 ||
    updatedClient.keyword_rules?.length !== 1 ||
    updatedClient.domain_normalized !== liveDomain
  ) {
    throw new Error("Client detail mutation did not preserve tenancy relations.");
  }
  const logoBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const logo = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${client.id}/logo`,
    authenticated(identity.token, {
      body: JSON.stringify({
        contentBase64: logoBytes.toString("base64"),
        contentType: "image/png",
      }),
      method: "PUT",
    }),
  );
  const retrievedLogo = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${client.id}/logo`,
    authenticated(identity.token),
  );
  if (
    !logo.path?.startsWith(`${client.id}/`) ||
    Buffer.from(retrievedLogo.contentBase64, "base64").compare(logoBytes) !== 0
  ) {
    throw new Error("Client logo did not round-trip through the target object store.");
  }
  const visibleClients = await jsonRequest(
    `${apiBaseUrl}/v1/clients`,
    authenticated(identity.token),
  );
  if (!visibleClients.clients?.some((candidate) => candidate.id === client.id)) {
    throw new Error("Created client was not returned by the tenancy API.");
  }
  const invalidProjectFilter = await request(
    `${apiBaseUrl}/v1/projects?clientId=invalid`,
    authenticated(identity.token),
  );
  if (
    invalidProjectFilter.response.status !== 400 ||
    invalidProjectFilter.body?.error?.code !== "invalid_request"
  ) {
    throw new Error("Invalid project client filters did not fail closed.");
  }
  const duplicateDomain = await request(
    `${apiBaseUrl}/v1/clients`,
    authenticated(identity.token, {
      body: JSON.stringify({
        companyName: "Duplicate client",
        domain: `https://www.${liveDomain}/path`,
      }),
      method: "POST",
    }),
  );
  if (
    duplicateDomain.response.status !== 409 ||
    duplicateDomain.body?.error?.code !== "client_domain_conflict"
  ) {
    throw new Error("Canonical live client domains were not enforced.");
  }
  const invalidSeasonality = await request(
    `${apiBaseUrl}/v1/clients/${client.id}/projects`,
    authenticated(identity.token, {
      body: JSON.stringify({
        projectName: "Invalid seasonality",
        seasonalityEnd: "2026-02-01",
        seasonalityStart: "2026-03-01",
      }),
      method: "POST",
    }),
  );
  if (
    invalidSeasonality.response.status !== 400 ||
    invalidSeasonality.body?.error?.code !== "invalid_request"
  ) {
    throw new Error("Invalid project seasonality did not fail closed.");
  }
  const project = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${client.id}/projects`,
    authenticated(identity.token, {
      body: JSON.stringify({
        authority: fixture.authority,
        categoryFocus: fixture.project.categoryFocus,
        country: fixture.project.country,
        currency: fixture.project.currency,
        economics: fixture.economics,
        language: fixture.project.language,
        name: fixture.project.name,
        rules: fixture.rules,
      }),
      method: "POST",
    }),
  );
  const projectList = await jsonRequest(
    `${apiBaseUrl}/v1/projects?clientId=${client.id}`,
    authenticated(identity.token),
  );
  const projectSummary = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/summary`,
    authenticated(identity.token),
  );
  if (
    projectList.projects?.length !== 1 ||
    projectList.projects[0]?.id !== project.id ||
    projectSummary.client_id !== client.id ||
    projectSummary.client_name !== fixture.client.companyName ||
    projectSummary.project_name !== fixture.project.name
  ) {
    throw new Error("Project list and summary tenancy contracts are inconsistent.");
  }
  await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}`,
    authenticated(identity.token, {
      body: JSON.stringify({
        aov: fixture.economics.averageOrderValue,
        categoryFocus: fixture.project.categoryFocus,
        conversionRate: fixture.economics.conversionRate,
        projectName: fixture.project.name,
        seasonalityEnd: null,
        seasonalityStart: null,
      }),
      method: "PATCH",
    }),
  );
  const dirtyProject = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/dirty`,
    authenticated(identity.token, {
      body: JSON.stringify({ domains: ["keywords", "inputs"] }),
      method: "PATCH",
    }),
  );
  if (!dirtyProject.keywords_dirty || !dirtyProject.inputs_dirty) {
    throw new Error("Project dirty-state mutation was not persisted.");
  }
  const keywordBody = JSON.stringify({
    keywords: fixture.keywords.map(({ id: _sourceId, ...keyword }) => ({
      ...keyword,
      rankingUrl: replaceFixtureDomain(keyword.rankingUrl),
    })),
  });
  await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/keywords`,
    authenticated(identity.token, {
      body: keywordBody,
      method: "POST",
    }),
  );
  await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/keywords`,
    authenticated(identity.token, {
      body: keywordBody,
      method: "POST",
    }),
  );

  const duplicateKeywordResponse = await request(
    `${apiBaseUrl}/v1/projects/${project.id}/keywords`,
    authenticated(identity.token, {
      body: JSON.stringify({
        keywords: [
          { text: "duplicate tv" },
          { text: "  DUPLICATE   TV " },
        ],
      }),
      method: "POST",
    }),
  );
  if (
    duplicateKeywordResponse.response.status !== 400 ||
    duplicateKeywordResponse.body?.error?.code !== "duplicate_value"
  ) {
    throw new Error("Duplicate keyword validation did not fail closed.");
  }

  await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/gsc-imports`,
    authenticated(identity.token, {
      body: JSON.stringify({
        rows: fixture.gscRows.map((row) => ({
          ...row,
          page: replaceFixtureDomain(row.page),
        })),
        sourceName: "representative-project.csv",
      }),
      method: "POST",
    }),
  );
  await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/local-provider-inputs`,
    authenticated(identity.token, {
      body: JSON.stringify({
        keywords: fixture.providerInputs.keywords.map((keyword) => ({
          ...keyword,
          rankingUrl: replaceFixtureDomain(keyword.rankingUrl),
        })),
        serpKeywords: fixture.providerInputs.serpKeywords.map((keyword) => ({
          ...keyword,
          results: keyword.results.map((result) =>
            result.domain === fixture.client.domain
              ? {
                  ...result,
                  domain: liveDomain,
                  url: replaceFixtureDomain(result.url),
                }
              : result,
            ),
        })),
        siteArchitectureKeywords:
          fixture.providerInputs.siteArchitectureKeywords.map((keyword) => ({
            ...keyword,
            matchedUrl: replaceFixtureDomain(keyword.matchedUrl),
          })),
      }),
      method: "PUT",
    }),
  );

  const [firstCreatedRun, concurrentCreatedRun] = await Promise.all([
    jsonRequest(
      `${apiBaseUrl}/v1/projects/${project.id}/pipeline-runs`,
      authenticated(identity.token, { method: "POST" }),
    ),
    jsonRequest(
      `${apiBaseUrl}/v1/projects/${project.id}/pipeline-runs`,
      authenticated(identity.token, { method: "POST" }),
    ),
  ]);
  if (
    firstCreatedRun.id !== concurrentCreatedRun.id ||
    [firstCreatedRun.resumed, concurrentCreatedRun.resumed].filter(Boolean)
      .length !== 1
  ) {
    throw new Error("Concurrent project pipeline starts were not deduplicated.");
  }
  const firstRun = await waitForRun(identity.token, firstCreatedRun.id);
  if (
    stage(firstRun, "intake").handlerVersion !== "intake-v1" ||
    stage(firstRun, "intake").sourceKeywordCount !== 12 ||
    stage(firstRun, "gsc-promotion").promotionCount !== 2 ||
    stage(firstRun, "detox").keptKeywordCount !== 12 ||
    stage(firstRun, "categorisation").summary.liveKeywordCount !== 10 ||
    stage(firstRun, "keyword-enrichment").enrichedKeywordCount !== 12 ||
    stage(firstRun, "keyword-enrichment").missingProviderCount !== 0 ||
    stage(firstRun, "ranking-url").matchedCount !== 1 ||
    stage(firstRun, "ranking-url").noMatchCount !== 0 ||
    stage(firstRun, "gsc-intent").resolvedCount !== 8 ||
    stage(firstRun, "gsc-intent").genericCount !== 0 ||
    stage(firstRun, "brand-classification").brandedCount !== 1 ||
    stage(firstRun, "serp-collection").matchedKeywordCount !== 4 ||
    stage(firstRun, "serp-collection").missingProviderCount !== 8 ||
    stage(firstRun, "serp-collection").resultCount !== 12 ||
    stage(firstRun, "authority").clientResultCount !== 4 ||
    stage(firstRun, "backlinks").enrichedResultCount !== 12 ||
    stage(firstRun, "backlinks").missingResultCount !== 0 ||
    stage(firstRun, "site-architecture").matchedCount !== 5 ||
    stage(firstRun, "site-architecture").missingProviderCount !== 7 ||
    stage(firstRun, "link-power-score").scoredResultCount !== 12 ||
    stage(firstRun, "demand-signals").sufficientHistoryCount !== 2 ||
    stage(firstRun, "ctr-curves").curves.length !== 5 ||
    stage(firstRun, "clustering").clusterCount !== 12 ||
    stage(firstRun, "har-v2").scenarioCount !== 36 ||
    stage(firstRun, "revenue-v2").forecastCount !== 36 ||
    stage(firstRun, "calibration").matched < 1 ||
    stage(firstRun, "calibration").status === "unavailable" ||
    !firstRun.stages.every(
      (item) => item.output?.validationMode === "local-project-data",
    )
  ) {
    throw new Error("First project-backed run did not compute the expected stage outputs.");
  }
  const latestPipeline = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/pipeline-runs?includeOutput=false`,
    authenticated(identity.token),
  );
  if (
    latestPipeline.projectId !== project.id ||
    latestPipeline.run?.id !== firstRun.id ||
    latestPipeline.run?.stages?.some((item) => "output" in item)
  ) {
    throw new Error("Latest project pipeline status contract is incomplete.");
  }

  const persistedProject = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}`,
    authenticated(identity.token),
  );
  assertProjectState(persistedProject, fixture);
  const calculations = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/calculations`,
    authenticated(identity.token),
  );
  if (
    calculations.runId !== firstRun.id ||
    calculations.har.length !== 3 ||
    !calculations.har.every(
      (summary) =>
        summary.forecastCount === 12 &&
        summary.modelVersion === "har_v2.1.0",
    ) ||
    calculations.revenue.length !== 3 ||
    !calculations.revenue.every(
      (summary) =>
        summary.bandMethod === "conf_interp_band_v1" &&
        summary.forecastCount === 12 &&
        summary.modelVersion === "revenue_v2.1.0" &&
        summary.monthlyForecastCount === 12,
    ) ||
    calculations.calibration?.matched < 1 ||
    calculations.calibration?.modelVersion !== "calibration_v1.0.0" ||
    typeof calculations.calibration?.promotionEligible !== "boolean" ||
    calculations.calibration?.sumActualMonthly <= 0 ||
    calculations.calibration?.sumModelledMonthly <= 0 ||
    calculations.opportunities.length !== 12
  ) {
    throw new Error("Calculation API did not expose the completed run.");
  }
  const forecastPage = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/forecast-rows?scenario=realistic&limit=5&offset=0`,
    authenticated(identity.token),
  );
  if (
    forecastPage.runId !== firstRun.id ||
    forecastPage.total !== 12 ||
    forecastPage.items.length !== 5 ||
    forecastPage.items.some(
      (row) =>
        row.scenario !== "realistic" ||
        typeof row.keywordId !== "string" ||
        row.monthlyRevenue?.months?.length !== 12,
    )
  ) {
    throw new Error("Detailed forecast API did not expose canonical rows.");
  }
  const architecturePage = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/site-architecture?limit=100&offset=0`,
    authenticated(identity.token),
  );
  if (
    architecturePage.runId !== firstRun.id ||
    architecturePage.total !== 12 ||
    architecturePage.items.length !== 12
  ) {
    throw new Error("Site architecture API did not expose the completed run.");
  }
  const ctrCurvePage = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/ctr-curves`,
    authenticated(identity.token),
  );
  if (
    ctrCurvePage.runId !== firstRun.id ||
    ctrCurvePage.curves.length !== 5 ||
    ctrCurvePage.curves.some((curve) => curve.points.length !== 20)
  ) {
    throw new Error("CTR curve API did not expose the completed run.");
  }
  const generatedRoadmap = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/roadmaps`,
    authenticated(identity.token, { method: "POST" }),
  );
  const roadmapHistory = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/roadmaps`,
    authenticated(identity.token),
  );
  if (
    generatedRoadmap.roadmap?.pipelineRunId !== firstRun.id ||
    generatedRoadmap.roadmap?.generationSource !== "deterministic" ||
    !generatedRoadmap.roadmap?.roadmapMarkdown?.includes("roadmap") ||
    roadmapHistory.roadmaps?.[0]?.id !== generatedRoadmap.roadmap?.id
  ) {
    throw new Error("Roadmap generation did not persist canonical evidence.");
  }
  const smartTv = persistedProject.keywords.find(
    (keyword) => normaliseKeyword(keyword.text) === "55 inch smart tv",
  );
  const competitor = persistedProject.keywords.find(
    (keyword) => normaliseKeyword(keyword.text) === "currys tv deals",
  );
  if (
    smartTv?.avgMonthlyVolume !== 5400 ||
    smartTv?.keywordDifficulty !== 43 ||
    competitor?.ranking.rank !== 14 ||
    competitor?.ranking.source !== "serp_results"
  ) {
    throw new Error("Provider-backed enrichment and ranking results were not persisted.");
  }
  const keywordPage = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/keywords?limit=5&offset=0&detoxStatus=keep&sort=volume&direction=desc`,
    authenticated(identity.token),
  );
  if (
    keywordPage.total !== 12 ||
    keywordPage.items.length !== 5 ||
    keywordPage.filterCounts.all !== 14 ||
    keywordPage.filterCounts.keep !== 12 ||
    keywordPage.filterCounts.remove !== 2 ||
    keywordPage.items.some((keyword) => keyword.detoxStatus !== "keep")
  ) {
    throw new Error("Keyword management pagination and aggregates are incorrect.");
  }

  const keywordApiProject = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${client.id}/projects`,
    authenticated(identity.token, {
      body: JSON.stringify({
        projectName: `Keyword API ${timestamp}`,
      }),
      method: "POST",
    }),
  );
  await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/keywords`,
    authenticated(identity.token, {
      body: JSON.stringify({
        keywords: [
          { text: "keyword api one" },
          { text: "keyword api two" },
        ],
      }),
      method: "POST",
    }),
  );
  const workbookImport = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/gsc-workbook`,
    authenticated(identity.token, {
      body: JSON.stringify({
        csvText:
          "Query,Clicks,Impressions,CTR,Position\nkeyword api one,25,1000,2.5%,8.2",
        dateRangeEnd: "2026-04-01",
        dateRangeStart: "2026-01-01",
        device: "mobile",
        filename: "queries.csv",
        format: "csv_text",
      }),
      method: "POST",
    }),
  );
  if (
    workbookImport.row_count !== 1 ||
    workbookImport.upload_device !== "mobile" ||
    workbookImport.source !== "gsc_csv_v2"
  ) {
    throw new Error("GSC workbook API did not persist a validated CSV import.");
  }
  const pendingKeywordPage = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/keywords?detoxStatus=pending`,
    authenticated(identity.token),
  );
  const firstKeywordId = pendingKeywordPage.items[0]?.id;
  if (pendingKeywordPage.total !== 2 || !firstKeywordId) {
    throw new Error("Keyword management fixture was not returned.");
  }
  const patchedKeywords = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/keywords`,
    authenticated(identity.token, {
      body: JSON.stringify({
        action: "updateDetox",
        detoxStatus: "keep",
        ids: [firstKeywordId],
      }),
      method: "PATCH",
    }),
  );
  if (patchedKeywords.affectedKeywordCount !== 1) {
    throw new Error("Keyword review mutation did not update the selected row.");
  }
  const prioritisedKeywords = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/keywords`,
    authenticated(identity.token, {
      body: JSON.stringify({
        action: "updatePriority",
        ids: [firstKeywordId],
        priority: 2,
      }),
      method: "PATCH",
    }),
  );
  if (prioritisedKeywords.affectedKeywordCount !== 1) {
    throw new Error("Keyword priority mutation did not update the selected row.");
  }
  const deletedKeywords = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/keywords`,
    authenticated(identity.token, {
      body: JSON.stringify({
        action: "delete",
        predicate: {
          detoxStatus: "pending",
          search: "keyword api",
        },
      }),
      method: "PATCH",
    }),
  );
  if (deletedKeywords.affectedKeywordCount !== 1) {
    throw new Error("Keyword predicate deletion did not remove the matching row.");
  }
  const reviewedKeywordPage = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/keywords`,
    authenticated(identity.token),
  );
  if (
    reviewedKeywordPage.total !== 1 ||
    reviewedKeywordPage.items[0]?.detoxStatus !== "keep" ||
    reviewedKeywordPage.items[0]?.humanReviewed !== true ||
    reviewedKeywordPage.items[0]?.keywordPriority !== 2 ||
    reviewedKeywordPage.items[0]?.device !== "mobile"
  ) {
    throw new Error("Keyword review state did not persist through the target API.");
  }
  const manualRankingUrl = "https://manual.example/keyword-api-one";
  const rankingImport = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/serp-import`,
    authenticated(identity.token, {
      body: JSON.stringify({
        csvText:
          `keyword,rank_position,ranking_url,ranking_domain\nkeyword api one,4,${manualRankingUrl},manual.example`,
        kind: "rankings",
      }),
      method: "POST",
    }),
  );
  const backlinkImport = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/serp-import`,
    authenticated(identity.token, {
      body: JSON.stringify({
        csvText:
          `ranking_url,url_rating,domain_rating,referring_domains,backlinks_total\n${manualRankingUrl},31,48,120,800`,
        kind: "backlinks",
      }),
      method: "POST",
    }),
  );
  const featureImport = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/serp-import`,
    authenticated(identity.token, {
      body: JSON.stringify({
        csvText:
          `keyword,device,serp_feature_raw,result_type,feature_url\nkeyword api one,mobile,AI Overview,ai_overview,https://${liveDomain}/answer`,
        kind: "features",
      }),
      method: "POST",
    }),
  );
  const importedSerp = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/serp-results`,
    authenticated(identity.token),
  );
  const importedFeatures = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${keywordApiProject.id}/serp-features`,
    authenticated(identity.token),
  );
  if (
    rankingImport.importedRowCount !== 1 ||
    backlinkImport.importedRowCount !== 1 ||
    featureImport.importedRowCount !== 1 ||
    importedSerp.items[0]?.urlRating !== 31 ||
    importedSerp.items[0]?.referringDomains !== 120 ||
    importedFeatures.items[0]?.resultType !== "ai_overview" ||
    importedFeatures.items[0]?.owned !== true
  ) {
    throw new Error("Manual SERP imports did not converge on canonical data.");
  }

  const archiveAdmin = await register(
    `archive-admin-${timestamp}@example.dev`,
    "admin",
  );
  const appliedConversionOverride = await jsonRequest(
    `${apiBaseUrl}/v1/conversion-overrides`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({
        average_order_value: 125,
        confidence: "high",
        conversion_rate: 0.025,
        project_id: project.id,
        scope_type: "project",
        scope_value: null,
      }),
      method: "POST",
    }),
  );
  const secondCreatedRun = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/pipeline-runs`,
    authenticated(identity.token, { method: "POST" }),
  );
  const secondRun = await waitForRun(identity.token, secondCreatedRun.id);
  if (
    stage(secondRun, "intake").sourceKeywordCount !== 14 ||
    stage(secondRun, "gsc-promotion").promotionCount !== 0 ||
    stage(secondRun, "categorisation").summary.processingKeywordCount !== 14 ||
    stage(secondRun, "ranking-url").matchedCount !== 0 ||
    stage(secondRun, "ranking-url").existingCount !== 12 ||
    stage(secondRun, "serp-collection").resultCount !== 12 ||
    stage(secondRun, "backlinks").enrichedResultCount !== 12 ||
    stage(secondRun, "site-architecture").matchedCount !== 5 ||
    stage(secondRun, "link-power-score").scoredResultCount !== 12 ||
    stage(secondRun, "demand-signals").sufficientHistoryCount !== 2 ||
    stage(secondRun, "ctr-curves").curves.length !== 5 ||
    stage(secondRun, "clustering").clusterCount !== 12 ||
    stage(secondRun, "har-v2").scenarioCount !== 36 ||
    stage(secondRun, "revenue-v2").forecastCount !== 36 ||
    stage(secondRun, "calibration").matched < 1
  ) {
    throw new Error("Project-backed rerun was not idempotent.");
  }
  const secondRevenueScenarios = stage(secondRun, "revenue-v2").keywords.flatMap(
    (keyword) => keyword.scenarios,
  );
  if (
    secondRevenueScenarios.length !== 36 ||
    secondRevenueScenarios.some(
      (scenario) =>
        scenario.conversionRateUsed !== 0.025 ||
        scenario.averageOrderValueUsed !== 125 ||
        scenario.conversionRateOverrideId !== appliedConversionOverride.id ||
        scenario.averageOrderValueOverrideId !== appliedConversionOverride.id,
    )
  ) {
    throw new Error("Revenue output did not apply the project conversion override.");
  }
  const forecastRows = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/forecast-rows?scenario=realistic&limit=100`,
    authenticated(identity.token),
  );
  if (
    forecastRows.total !== 12 ||
    forecastRows.items.some(
      (item) =>
        item.conversionRateUsed !== 0.025 ||
        item.averageOrderValueUsed !== 125 ||
        item.conversionRateOverrideId !== appliedConversionOverride.id ||
        item.averageOrderValueOverrideId !== appliedConversionOverride.id,
    )
  ) {
    throw new Error("Persisted revenue forecasts lost conversion override provenance.");
  }
  const portfolio = await jsonRequest(
    `${apiBaseUrl}/v1/portfolio`,
    authenticated(identity.token),
  );
  const projectForecast = portfolio.projectForecasts.find(
    (item) => item.projectId === project.id,
  );
  const realisticScenarios = stage(secondRun, "revenue-v2").keywords
    .flatMap((keyword) => keyword.scenarios)
    .filter((scenario) => scenario.scenario === "realistic");
  const expectedTpRevenue = realisticScenarios.reduce(
    (total, scenario) => total + (scenario.expectedIncrementalAnnual ?? 0),
    0,
  );
  const expectedRankOneRevenue = realisticScenarios.reduce(
    (total, scenario) => total + (scenario.targetIncrementalRevenueAnnual ?? 0),
    0,
  );
  if (
    !projectForecast ||
    projectForecast.keywordCount !== 12 ||
    Math.abs(projectForecast.tpRevenueUplift - expectedTpRevenue) > 0.01 ||
    Math.abs(projectForecast.revenueUpliftRank1 - expectedRankOneRevenue) > 0.01
  ) {
    throw new Error("Portfolio forecast aggregates differ from the canonical run.");
  }
  const allCaptureRows = await jsonRequest(
    `${apiBaseUrl}/v1/capture-window?inWindowOnly=false`,
    authenticated(identity.token),
  );
  const expectedSeasonalKeywordCount = stage(
    secondRun,
    "demand-signals",
  ).keywords.filter((keyword) => keyword.peakMonths.length > 0).length;
  const projectCaptureRows = allCaptureRows.items.filter(
    (item) => item.projectId === project.id,
  );
  if (
    projectCaptureRows.length !== expectedSeasonalKeywordCount ||
    !Array.isArray(portfolio.captureWindow?.items) ||
    !Array.isArray(portfolio.seasonality)
  ) {
    throw new Error("Portfolio seasonality and capture-window data are inconsistent.");
  }
  const contentPlanGeneration = await jsonRequest(
    `${apiBaseUrl}/v1/content-plans/generate`,
    authenticated(identity.token, {
      body: JSON.stringify({
        clientId: client.id,
        defaultLeadWeeks: 12,
        heroLeadWeeks: 16,
        keywordIds: stage(secondRun, "demand-signals").keywords.map(
          (keyword) => keyword.id,
        ),
        mix: {
          blog: 6,
          category: 1,
          hero: 2,
          page: 2,
          product: 1,
        },
        name: "Local content plan validation",
        projectId: project.id,
      }),
      method: "POST",
    }),
  );
  const contentPlanDetail = await jsonRequest(
    `${apiBaseUrl}/v1/content-plans/${contentPlanGeneration.planId}`,
    authenticated(identity.token),
  );
  const contentPlans = await jsonRequest(
    `${apiBaseUrl}/v1/content-plans?projectId=${project.id}`,
    authenticated(identity.token),
  );
  if (
    contentPlanGeneration.items < 1 ||
    contentPlanDetail.items.length !== contentPlanGeneration.items ||
    contentPlanDetail.plan.client_id !== client.id ||
    contentPlans.plans[0]?.id !== contentPlanGeneration.planId ||
    contentPlans.plans[0]?.item_count !== contentPlanGeneration.items
  ) {
    throw new Error("Content plan generation and listing were inconsistent.");
  }
  const editablePlanItem = contentPlanDetail.items[0];
  const updatedPlanItem = await jsonRequest(
    `${apiBaseUrl}/v1/content-plan-items/${editablePlanItem.id}`,
    authenticated(identity.token, {
      body: JSON.stringify({
        status: "in_progress",
        synopsis: "Updated by local content plan validation.",
      }),
      method: "PATCH",
    }),
  );
  if (
    updatedPlanItem.status !== "in_progress" ||
    updatedPlanItem.synopsis !== "Updated by local content plan validation."
  ) {
    throw new Error("Content plan item updates did not persist.");
  }
  const promotablePlanItem = contentPlanDetail.items.find(
    (item) => item.content_format !== "hero",
  );
  if (promotablePlanItem) {
    await jsonRequest(
      `${apiBaseUrl}/v1/content-plan-items/${promotablePlanItem.id}/promote-hero`,
      authenticated(identity.token, { method: "POST" }),
    );
    const promotedPlan = await jsonRequest(
      `${apiBaseUrl}/v1/content-plans/${contentPlanGeneration.planId}`,
      authenticated(identity.token),
    );
    if (
      promotedPlan.items.find((item) => item.id === promotablePlanItem.id)
        ?.content_format !== "hero"
    ) {
      throw new Error("Content plan hero promotion did not persist.");
    }
  }
  const slideExport = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/slide-export`,
    authenticated(identity.token, {
      body: JSON.stringify({
        contentBase64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9Z8AAAAASUVORK5CYII=",
      }),
      method: "POST",
    }),
  );
  if (
    typeof slideExport.id !== "string" ||
    !slideExport.id.startsWith("local-") ||
    typeof slideExport.name !== "string" ||
    !slideExport.name.includes(project.project_name) ||
    slideExport.url !==
      `https://docs.google.com/presentation/d/${slideExport.id}/edit`
  ) {
    throw new Error("Google Slides export did not return the expected deck.");
  }
  await jsonRequest(
    `${apiBaseUrl}/v1/conversion-overrides/${appliedConversionOverride.id}`,
    authenticated(archiveAdmin.token, { method: "DELETE" }),
  );

  const otherIdentity = await register(
    `project-isolation-${timestamp}@example.dev`,
    "view_only",
  );
  const isolatedResponse = await request(
    `${apiBaseUrl}/v1/projects/${project.id}`,
    authenticated(otherIdentity.token),
  );
  if (
    isolatedResponse.response.status !== 404 ||
    isolatedResponse.body?.error?.code !== "project_not_found"
  ) {
    throw new Error("Project access was not isolated from another user.");
  }
  const forbiddenClientCreate = await request(
    `${apiBaseUrl}/v1/clients`,
    authenticated(otherIdentity.token, {
      body: JSON.stringify({
        companyName: "Forbidden client",
        domain: `forbidden-${timestamp}.test`,
      }),
      method: "POST",
    }),
  );
  if (
    forbiddenClientCreate.response.status !== 403 ||
    forbiddenClientCreate.body?.error?.code !== "write_access_required"
  ) {
    throw new Error("View-only client creation did not fail closed.");
  }
  const duplicateProjectResult = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/duplicate`,
    authenticated(identity.token, { method: "POST" }),
  );
  if (
    duplicateProjectResult.duplicated_from !== project.id ||
    duplicateProjectResult.client_id !== client.id ||
    duplicateProjectResult.project_name !== `${fixture.project.name} (copy)`
  ) {
    throw new Error("Project duplication did not preserve tenancy metadata.");
  }
  const serpPage = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/serp-results?limit=100&offset=0`,
    authenticated(identity.token),
  );
  if (
    serpPage.total !== 12 ||
    serpPage.items.length !== 12 ||
    !serpPage.items.every(
      (result) =>
        result.metricSource === "local-provider" &&
        result.urlRating !== null &&
        result.domainRating !== null &&
        result.referringDomains !== null &&
        result.backlinks !== null,
    )
  ) {
    throw new Error("Persisted SERP and backlink metrics are incomplete.");
  }
  const filteredSerpPage = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${project.id}/serp-results?limit=100&offset=0&keywordId=${serpPage.items[0].keywordId}`,
    authenticated(identity.token),
  );
  if (
    filteredSerpPage.total !== 3 ||
    filteredSerpPage.items.some(
      (result) => result.keywordId !== serpPage.items[0].keywordId,
    )
  ) {
    throw new Error("SERP keyword filtering returned cross-keyword rows.");
  }

  const referenceBefore = await jsonRequest(
    `${apiBaseUrl}/v1/reference-data`,
    authenticated(archiveAdmin.token),
  );
  await jsonRequest(
    `${apiBaseUrl}/v1/reference-data/serp-features`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({
        records: [
          {
            result_type: "Validation Result",
            serp_feature_raw: `validation feature ${timestamp}`,
            serp_intent: "Validation",
          },
        ],
      }),
      method: "POST",
    }),
  );
  const referenceAfter = await jsonRequest(
    `${apiBaseUrl}/v1/reference-data`,
    authenticated(archiveAdmin.token),
  );
  const validationFeature = referenceAfter.serpFeatures.find(
    (feature) => feature.serp_feature_raw === `validation feature ${timestamp}`,
  );
  if (
    referenceBefore.harScoringConfig?.version !== "har_v2.1.0" ||
    referenceBefore.serpFeatures.length < 10 ||
    !validationFeature
  ) {
    throw new Error("Admin reference data contract was incomplete.");
  }
  const updatedFeature = await jsonRequest(
    `${apiBaseUrl}/v1/reference-data/serp-features/${validationFeature.id}`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({
        result_type: "Updated Validation Result",
        serp_feature_raw: validationFeature.serp_feature_raw,
        serp_intent: validationFeature.serp_intent,
      }),
      method: "PATCH",
    }),
  );
  if (updatedFeature.result_type !== "Updated Validation Result") {
    throw new Error("SERP feature reference updates were not persisted.");
  }
  const firstCategory = persistedProject.keywords.find(
    (keyword) => keyword.categorisation?.category,
  )?.categorisation?.category;
  if (!firstCategory) {
    throw new Error("Category consolidation fixture has no category.");
  }
  await jsonRequest(
    `${apiBaseUrl}/v1/clients/${client.id}/category-consolidation`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({
        mapping: { [firstCategory]: `${firstCategory} Validation` },
        mode: "apply",
      }),
      method: "POST",
    }),
  );
  const categoryBatch = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${client.id}/category-consolidation/latest`,
    authenticated(archiveAdmin.token),
  );
  const categoryUndo = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${client.id}/category-consolidation`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({ mode: "undo" }),
      method: "POST",
    }),
  );
  if (!categoryBatch.batch?.batch_id || categoryUndo.restored < 1) {
    throw new Error("Category consolidation audit and undo were incomplete.");
  }
  const archivedClient = await jsonRequest(
    `${apiBaseUrl}/v1/clients`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({
        companyName: "Archive contract fixture",
        domain: `archive-${timestamp}.test`,
      }),
      method: "POST",
    }),
  );
  const firstArchivedProject = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${archivedClient.id}/projects`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({ projectName: "Archive fixture one" }),
      method: "POST",
    }),
  );
  const secondArchivedProject = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${archivedClient.id}/projects`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({ projectName: "Archive fixture two" }),
      method: "POST",
    }),
  );
  const conversionOverride = await jsonRequest(
    `${apiBaseUrl}/v1/conversion-overrides`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({
        average_order_value: 125,
        confidence: "high",
        conversion_rate: 0.025,
        note: "Integration validation",
        project_id: firstArchivedProject.id,
        scope_type: "project",
        scope_value: null,
      }),
      method: "POST",
    }),
  );
  const conversionOverrides = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${firstArchivedProject.id}/conversion-overrides`,
    authenticated(archiveAdmin.token),
  );
  if (
    conversionOverrides.overrides.length !== 1 ||
    conversionOverrides.overrides[0].id !== conversionOverride.id ||
    Number(conversionOverrides.overrides[0].conversion_rate) !== 0.025
  ) {
    throw new Error("Conversion override CRUD contract was incomplete.");
  }
  const monitorCampaign = await jsonRequest(
    `${apiBaseUrl}/v1/url-monitor/campaigns`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({
        checkFrequency: "6h",
        clientId: archivedClient.id,
        dailyCheckTime: "08:30",
        description: "Local URL monitor contract",
        name: "Archive monitor fixture",
        owner: "Local Admin",
        projectId: firstArchivedProject.id,
      }),
      method: "POST",
    }),
  );
  const monitorImport = await jsonRequest(
    `${apiBaseUrl}/v1/url-monitor/campaigns/${monitorCampaign.campaign.id}/urls`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({
        urls: [
          { label: "Homepage", url: "https://example.com" },
          { url: "https://example.com/" },
          { url: "not-a-url" },
        ],
      }),
      method: "POST",
    }),
  );
  const monitorAlerts = await jsonRequest(
    `${apiBaseUrl}/v1/url-monitor/campaigns/${monitorCampaign.campaign.id}/alerts`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({
        alertOnWarning: false,
        weeklySummary: false,
      }),
      method: "PATCH",
    }),
  );
  const monitorHistory = await jsonRequest(
    `${apiBaseUrl}/v1/url-monitor/campaigns/${monitorCampaign.campaign.id}/history?days=30`,
    authenticated(archiveAdmin.token),
  );
  const monitorOverview = await jsonRequest(
    `${apiBaseUrl}/v1/url-monitor/overview`,
    authenticated(archiveAdmin.token),
  );
  if (
    monitorImport.added !== 1 ||
    monitorImport.duplicates !== 1 ||
    monitorImport.invalid !== 1 ||
    monitorAlerts.alert_on_warning !== false ||
    monitorAlerts.weekly_summary !== false ||
    monitorHistory.urls.length !== 1 ||
    monitorHistory.snapshots.length !== 0 ||
    !monitorOverview.campaigns.some(
      (candidate) => candidate.id === monitorCampaign.campaign.id,
    )
  ) {
    throw new Error("URL monitor CRUD contract did not preserve canonical state.");
  }
  const liveDelete = await request(
    `${apiBaseUrl}/v1/projects/${secondArchivedProject.id}`,
    authenticated(archiveAdmin.token, { method: "DELETE" }),
  );
  if (
    liveDelete.response.status !== 409 ||
    liveDelete.body?.error?.code !== "project_not_archived"
  ) {
    throw new Error("Permanent delete did not require project archival.");
  }
  const archivedProject = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${firstArchivedProject.id}/archive`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({ reason: "Integration validation" }),
      method: "POST",
    }),
  );
  const archivedDetail = await jsonRequest(
    `${apiBaseUrl}/v1/projects/${firstArchivedProject.id}/archive-detail`,
    authenticated(archiveAdmin.token),
  );
  if (
    !archivedProject.archived_at ||
    archivedProject.archive_reason !== "Integration validation" ||
    archivedDetail.project.id !== firstArchivedProject.id
  ) {
    throw new Error("Project archive detail did not preserve archive metadata.");
  }
  await jsonRequest(
    `${apiBaseUrl}/v1/projects/${firstArchivedProject.id}/restore`,
    authenticated(archiveAdmin.token, { method: "POST" }),
  );
  const cascadedClient = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${archivedClient.id}/archive`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({ reason: "Cascade validation" }),
      method: "POST",
    }),
  );
  const cascadedProjects = await jsonRequest(
    `${apiBaseUrl}/v1/projects?clientId=${archivedClient.id}&includeArchived=true`,
    authenticated(archiveAdmin.token),
  );
  const blockedChildRestore = await request(
    `${apiBaseUrl}/v1/projects/${firstArchivedProject.id}/restore`,
    authenticated(archiveAdmin.token, { method: "POST" }),
  );
  if (
    !cascadedClient.archived_at ||
    cascadedProjects.projects.length !== 2 ||
    cascadedProjects.projects.some((candidate) => !candidate.archived_at) ||
    blockedChildRestore.response.status !== 409 ||
    blockedChildRestore.body?.error?.code !== "parent_client_archived"
  ) {
    throw new Error("Client archive did not cascade or guard child restoration.");
  }
  const nonAdminArchiveList = await request(
    `${apiBaseUrl}/v1/clients?includeArchived=true`,
    authenticated(identity.token),
  );
  if (
    nonAdminArchiveList.response.status !== 403 ||
    nonAdminArchiveList.body?.error?.code !== "administrator_required"
  ) {
    throw new Error("Archived client listing was not restricted to administrators.");
  }
  await jsonRequest(
    `${apiBaseUrl}/v1/clients/${archivedClient.id}/restore`,
    authenticated(archiveAdmin.token, { method: "POST" }),
  );
  const restoredProjects = await jsonRequest(
    `${apiBaseUrl}/v1/projects?clientId=${archivedClient.id}`,
    authenticated(archiveAdmin.token),
  );
  if (
    restoredProjects.projects.length !== 2 ||
    restoredProjects.projects.some((candidate) => candidate.archived_at)
  ) {
    throw new Error("Client restore did not restore only cascade-matched projects.");
  }
  await jsonRequest(
    `${apiBaseUrl}/v1/clients/${archivedClient.id}/archive`,
    authenticated(archiveAdmin.token, {
      body: JSON.stringify({ reason: "Hard delete validation" }),
      method: "POST",
    }),
  );
  const hardDelete = await jsonRequest(
    `${apiBaseUrl}/v1/clients/${archivedClient.id}`,
    authenticated(archiveAdmin.token, { method: "DELETE" }),
  );
  const deletedClient = await request(
    `${apiBaseUrl}/v1/clients/${archivedClient.id}`,
    authenticated(archiveAdmin.token),
  );
  if (
    hardDelete.ok !== true ||
    hardDelete.entity_type !== "client" ||
    hardDelete.counts.navigator_projects !== 2 ||
    deletedClient.response.status !== 404
  ) {
    throw new Error("Archived client hard delete did not remove the full fixture.");
  }
  const overviewAfterClientDelete = await jsonRequest(
    `${apiBaseUrl}/v1/url-monitor/overview`,
    authenticated(archiveAdmin.token),
  );
  if (
    overviewAfterClientDelete.campaigns.some(
      (candidate) => candidate.id === monitorCampaign.campaign.id,
    )
  ) {
    throw new Error("Client hard delete did not cascade to URL monitoring data.");
  }

  await writeFile(
    statePath,
    JSON.stringify(
      {
        projectId: project.id,
        token: identity.token,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(
    JSON.stringify({
      accessIsolation: true,
      clientLogoRoundTrip: true,
      clientRelations: true,
      duplicateInputRejected: true,
      duplicateProject: true,
      firstRunPromotions: stage(firstRun, "gsc-promotion").promotionCount,
      firstRunRankingMatches: stage(firstRun, "ranking-url").matchedCount,
      gscIntentsResolved: stage(firstRun, "gsc-intent").resolvedCount,
      keywordCount: persistedProject.keywordCount,
      calculationCounts: persistedProject.calculationCounts,
      calculationApi: true,
      archiveApi: true,
      adminReferenceApi: true,
      categoryConsolidationApi: true,
      conversionOverrideApi: true,
      urlMonitorApi: true,
      detailedCalculationApis: true,
      concurrentPipelineStartDeduplicated: true,
      gscWorkbookApi: true,
      keywordManagementApi: true,
      roadmapApi: true,
      serpImportApi: true,
      mode: "project-data-end-to-end",
      rerunPromotions: stage(secondRun, "gsc-promotion").promotionCount,
      serpResults: serpPage.total,
    }),
  );
}

if (process.argv.includes("--persistence")) {
  await validatePersistence();
} else {
  await validateEndToEnd();
}
