import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { assertDatabaseReady } from "../../../packages/runtime/src/database.js";
import {
  authenticateLocalRequest,
  loginLocalUser,
  registerLocalUser,
} from "../../../packages/runtime/src/local-auth.js";
import { HttpError, readJson, sendError, sendJson } from "../../../packages/runtime/src/http.js";
import { createAsset, getAsset } from "./assets.js";
import {
  consolidateCategories,
  createSerpFeatures,
  deleteConversionOverride,
  getLastCategoryBatch,
  getReferenceData,
  listConversionOverrides,
  updateSerpFeature,
  upsertConversionOverride,
} from "./admin-reference.js";
import {
  addProjectKeywords,
  assertProjectAccess,
  getProjectCalculationInspector,
  getProjectCtrCurves,
  getProject,
  getProjectCalculations,
  getProjectForecastRows,
  getProjectKeywords,
  getProjectLinkPowerInspector,
  getProjectSerpResults,
  getProjectSiteArchitecture,
  importProjectGscRows,
  mutateProjectKeywords,
  replaceLocalProviderInputs,
  replaceProjectRules,
} from "./core-domain.js";
import {
  registerIdentityUser,
  type IdentityAccountAdmin,
} from "./identity-provisioning.js";
import { parseGscWorkbookImport } from "./gsc-workbook.js";
import type { ObjectStore } from "./object-store-client.js";
import {
  createPipelineRun,
  getLatestProjectPipelineRun,
  getPipelineRun,
} from "./pipeline-runs.js";
import {
  assertApprovedUser,
  getCurrentProfile,
  updateCurrentProfile,
} from "./profile.js";
import {
  archiveClient,
  archiveProject,
  createClient,
  createProject,
  deleteClient,
  deleteProject,
  duplicateProject,
  getClient,
  getClientLogo,
  getArchivedProjectDetail,
  getProjectSummary,
  grantClientUser,
  listEligibleClientOwners,
  listClients,
  listClientUsers,
  listProjects,
  markProjectDirty,
  putClientLogo,
  revokeClientUser,
  restoreClient,
  restoreProject,
  updateClientBrandTerms,
  updateClient,
  updateProject,
} from "./tenancy.js";
import {
  decideUserApproval,
  deleteUser,
  inviteUser,
  listUsers,
  replaceUserClientAccess,
  setUserRole,
} from "./user-administration.js";
import type { PipelineOrchestrator } from "./workflows-orchestrator.js";
import {
  generateProjectRoadmap,
  listProjectRoadmaps,
} from "./roadmaps.js";
import {
  importProjectSerpCsv,
  listProjectSerpFeatures,
} from "./serp-import.js";
import {
  getPortfolioDashboard,
  listCaptureWindowRows,
} from "./portfolio.js";
import {
  generateContentPlan,
  getContentPlan,
  listContentPlans,
  promoteContentPlanItemToHero,
  updateContentPlanItem,
} from "./content-plans.js";
import type { TextGenerationClient } from "./anthropic-client.js";
import {
  exportProjectSlides,
  type ExportImageStore,
  type SlidesClient,
} from "./slide-exports.js";
import {
  addMonitoredUrls,
  createMonitorCampaign,
  deleteMonitoredUrl,
  getMonitoredUrlHistory,
  getMonitorCampaign,
  getMonitorCampaignHistory,
  getUrlMonitorOverview,
  resolveMonitorIssue,
  pruneUrlMonitorSnapshots,
  runMonitorCampaign,
  runDueUrlMonitorChecks,
  updateMonitorAlerts,
  updateMonitorCampaign,
} from "./url-monitor.js";

export const API_SERVICE_NAME = "seer-api";

export interface ApiServerConfig {
  allowedOrigins?: readonly string[];
  authenticateRequest?: typeof authenticateLocalRequest;
  environment?: string;
  identityAdmin?: IdentityAccountAdmin;
  internalToken?: string;
  objectStore?: ObjectStore;
  orchestrator?: PipelineOrchestrator;
  pool?: DatabasePool;
  registrationContinueUrl?: string;
  revision?: string;
  exportImageStore?: ExportImageStore;
  slidesClient?: SlidesClient;
  slidesTemplateId?: string;
  textGenerationClient?: TextGenerationClient;
  urlMonitorPrune?: typeof pruneUrlMonitorSnapshots;
  urlMonitorTick?: typeof runDueUrlMonitorChecks;
}

function configuredOrigins(config: ApiServerConfig): Set<string> {
  if (config.allowedOrigins) return new Set(config.allowedOrigins);
  if ((config.environment ?? "local") === "local") {
    return new Set([
      "http://127.0.0.1:4173",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:8080",
      "http://localhost:4173",
      "http://localhost:5173",
      "http://localhost:8080",
    ]);
  }
  return new Set();
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  config: ApiServerConfig,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (!configuredOrigins(config).has(origin)) {
    throw new HttpError(403, "origin_not_allowed", "The request origin is not allowed.");
  }
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader("access-control-max-age", "3600");
  response.setHeader("vary", "Origin");
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.setHeader("cache-control", "no-store");
    response.end();
    return true;
  }
  return false;
}

function methodNotAllowed(
  response: ServerResponse,
  allowedMethods: readonly string[],
): never {
  response.setHeader("allow", allowedMethods.join(", "));
  throw new HttpError(
    405,
    "method_not_allowed",
    `Only ${allowedMethods.join(" and ")} ${allowedMethods.length === 1 ? "is" : "are"} allowed for this endpoint.`,
  );
}

function internalAuthorized(
  request: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  const header = request.headers["x-seer-internal-token"];
  if (!expectedToken || typeof header !== "string") return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireRuntime(config: ApiServerConfig): {
  objectStore: ObjectStore;
  pool: DatabasePool;
} {
  if (!config.pool || !config.objectStore) {
    throw new HttpError(
      503,
      "runtime_not_configured",
      "The API runtime is not configured.",
    );
  }

  return {
    objectStore: config.objectStore,
    pool: config.pool,
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const value = pathname.slice(prefix.length);

  if (!UUID_PATTERN.test(value)) {
    return null;
  }

  return value;
}

function uuidSubresourcePath(
  pathname: string,
  prefix: string,
  suffix: string,
): string | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const value = pathname.slice(prefix.length, -suffix.length);
  if (
    !UUID_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function clientUserPath(
  pathname: string,
): { clientId: string; userId: string } | null {
  const match = pathname.match(
    /^\/v1\/clients\/([0-9a-f-]{36})\/users\/([0-9a-f-]{36})$/i,
  );
  if (!match?.[1] || !match[2]) return null;
  return UUID_PATTERN.test(match[1]) && UUID_PATTERN.test(match[2])
    ? { clientId: match[1], userId: match[2] }
    : null;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ApiServerConfig,
): Promise<void> {
  if (applyCors(request, response, config)) return;

  const url = new URL(request.url ?? "/", "http://api.local");
  const method = request.method ?? "GET";
  const environment = config.environment ?? "local";

  if (url.pathname === "/healthz") {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }

    sendJson(response, 200, {
      environment,
      revision: config.revision ?? "local",
      service: API_SERVICE_NAME,
      status: "ok",
    });
    return;
  }

  if (url.pathname === "/readyz") {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }

    const runtime = requireRuntime(config);
    await Promise.all([
      assertDatabaseReady(runtime.pool),
      runtime.objectStore.assertReady(),
    ]);
    sendJson(response, 200, {
      service: API_SERVICE_NAME,
      status: "ready",
    });
    return;
  }

  if (url.pathname === "/internal/maintenance/url-monitor") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    if (!internalAuthorized(request, config.internalToken)) {
      throw new HttpError(
        401,
        "invalid_internal_token",
        "The internal token is invalid.",
      );
    }
    if (!config.pool) {
      throw new HttpError(
        503,
        "database_not_configured",
        "Database is not configured.",
      );
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "invalid_request", "The request body is invalid.");
    }
    const operation = (body as Record<string, unknown>).operation;
    if (operation === "tick") {
      sendJson(
        response,
        200,
        await (config.urlMonitorTick ?? runDueUrlMonitorChecks)(config.pool),
      );
      return;
    }
    if (operation === "prune") {
      sendJson(
        response,
        200,
        await (config.urlMonitorPrune ?? pruneUrlMonitorSnapshots)(config.pool),
      );
      return;
    }
    throw new HttpError(
      400,
      "invalid_request",
      "operation must be tick or prune.",
    );
  }

  const assetId = uuidPath(url.pathname, "/v1/assets/");
  const runId = uuidPath(url.pathname, "/v1/pipeline-runs/");
  const projectId = uuidPath(url.pathname, "/v1/projects/");
  const clientProjectClientId = uuidSubresourcePath(
    url.pathname,
    "/v1/clients/",
    "/projects",
  );
  const clientLogoClientId = uuidSubresourcePath(
    url.pathname,
    "/v1/clients/",
    "/logo",
  );
  const clientUsersClientId = uuidSubresourcePath(
    url.pathname,
    "/v1/clients/",
    "/users",
  );
  const clientBrandTermsClientId = uuidSubresourcePath(
    url.pathname,
    "/v1/clients/",
    "/brand-terms",
  );
  const clientEligibleOwnersClientId = uuidSubresourcePath(
    url.pathname,
    "/v1/clients/",
    "/eligible-owners",
  );
  const archiveClientId = uuidSubresourcePath(
    url.pathname,
    "/v1/clients/",
    "/archive",
  );
  const restoreClientId = uuidSubresourcePath(
    url.pathname,
    "/v1/clients/",
    "/restore",
  );
  const clientUser = clientUserPath(url.pathname);
  const clientId = uuidPath(url.pathname, "/v1/clients/");
  const keywordProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/keywords",
  );
  const gscProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/gsc-imports",
  );
  const gscWorkbookProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/gsc-workbook",
  );
  const ruleProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/rules",
  );
  const pipelineProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/pipeline-runs",
  );
  const slideExportProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/slide-export",
  );
  const providerProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/local-provider-inputs",
  );
  const serpProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/serp-results",
  );
  const serpImportProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/serp-import",
  );
  const serpFeaturesProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/serp-features",
  );
  const calculationsProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/calculations",
  );
  const calculationInspectorProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/calculation-inspector",
  );
  const linkPowerInspectorProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/link-power-inspector",
  );
  const forecastRowsProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/forecast-rows",
  );
  const siteArchitectureProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/site-architecture",
  );
  const ctrCurvesProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/ctr-curves",
  );
  const roadmapsProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/roadmaps",
  );
  const summaryProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/summary",
  );
  const duplicateProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/duplicate",
  );
  const dirtyProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/dirty",
  );
  const archiveProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/archive",
  );
  const restoreProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/restore",
  );
  const archiveDetailProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/archive-detail",
  );
  const monitorCampaignId = uuidPath(
    url.pathname,
    "/v1/url-monitor/campaigns/",
  );
  const monitorCampaignUrlsId = uuidSubresourcePath(
    url.pathname,
    "/v1/url-monitor/campaigns/",
    "/urls",
  );
  const monitorCampaignHistoryId = uuidSubresourcePath(
    url.pathname,
    "/v1/url-monitor/campaigns/",
    "/history",
  );
  const monitorCampaignAlertsId = uuidSubresourcePath(
    url.pathname,
    "/v1/url-monitor/campaigns/",
    "/alerts",
  );
  const monitorCampaignRunId = uuidSubresourcePath(
    url.pathname,
    "/v1/url-monitor/campaigns/",
    "/run",
  );
  const monitoredUrlId = uuidPath(
    url.pathname,
    "/v1/url-monitor/urls/",
  );
  const monitoredUrlHistoryId = uuidSubresourcePath(
    url.pathname,
    "/v1/url-monitor/urls/",
    "/history",
  );
  const monitorIssueResolveId = uuidSubresourcePath(
    url.pathname,
    "/v1/url-monitor/issues/",
    "/resolve",
  );
  const referenceSerpFeatureId = uuidPath(
    url.pathname,
    "/v1/reference-data/serp-features/",
  );
  const conversionOverridesProjectId = uuidSubresourcePath(
    url.pathname,
    "/v1/projects/",
    "/conversion-overrides",
  );
  const conversionOverrideId = uuidPath(
    url.pathname,
    "/v1/conversion-overrides/",
  );
  const contentPlanId = uuidPath(url.pathname, "/v1/content-plans/");
  const contentPlanItemId = uuidPath(
    url.pathname,
    "/v1/content-plan-items/",
  );
  const promoteContentPlanItemId = uuidSubresourcePath(
    url.pathname,
    "/v1/content-plan-items/",
    "/promote-hero",
  );
  const categoryConsolidationClientId = uuidSubresourcePath(
    url.pathname,
    "/v1/clients/",
    "/category-consolidation",
  );
  const categoryConsolidationLatestClientId = uuidSubresourcePath(
    url.pathname,
    "/v1/clients/",
    "/category-consolidation/latest",
  );
  const adminUserId = uuidPath(url.pathname, "/v1/admin/users/");
  const adminRoleUserId = uuidSubresourcePath(
    url.pathname,
    "/v1/admin/users/",
    "/role",
  );
  const adminApprovalUserId = uuidSubresourcePath(
    url.pathname,
    "/v1/admin/users/",
    "/approval",
  );
  const adminClientAccessUserId = uuidSubresourcePath(
    url.pathname,
    "/v1/admin/users/",
    "/client-access",
  );
  const isRuntimeRoute =
    url.pathname === "/v1/auth/register" ||
    url.pathname === "/v1/me" ||
    url.pathname === "/v1/admin/users" ||
    url.pathname === "/v1/admin/users/invitations" ||
    url.pathname === "/v1/local-auth/register" ||
    url.pathname === "/v1/local-auth/login" ||
    url.pathname === "/v1/assets" ||
    url.pathname === "/v1/clients" ||
    url.pathname === "/v1/projects" ||
    url.pathname === "/v1/pipeline-runs" ||
    url.pathname === "/v1/portfolio" ||
    url.pathname === "/v1/capture-window" ||
    url.pathname === "/v1/content-plans" ||
    url.pathname === "/v1/content-plans/generate" ||
    url.pathname === "/v1/url-monitor/overview" ||
    url.pathname === "/v1/url-monitor/campaigns" ||
    url.pathname === "/v1/reference-data" ||
    url.pathname === "/v1/reference-data/serp-features" ||
    url.pathname === "/v1/conversion-overrides" ||
    assetId !== null ||
    runId !== null ||
    projectId !== null ||
    clientId !== null ||
    clientProjectClientId !== null ||
    clientLogoClientId !== null ||
    clientUsersClientId !== null ||
    clientBrandTermsClientId !== null ||
    clientEligibleOwnersClientId !== null ||
    archiveClientId !== null ||
    restoreClientId !== null ||
    clientUser !== null ||
    keywordProjectId !== null ||
    gscProjectId !== null ||
    gscWorkbookProjectId !== null ||
    ruleProjectId !== null ||
    pipelineProjectId !== null ||
    slideExportProjectId !== null ||
    providerProjectId !== null ||
    serpProjectId !== null ||
    serpImportProjectId !== null ||
    serpFeaturesProjectId !== null ||
    calculationsProjectId !== null ||
    calculationInspectorProjectId !== null ||
    linkPowerInspectorProjectId !== null ||
    forecastRowsProjectId !== null ||
    siteArchitectureProjectId !== null ||
    ctrCurvesProjectId !== null ||
    roadmapsProjectId !== null ||
    summaryProjectId !== null ||
    duplicateProjectId !== null ||
    dirtyProjectId !== null ||
    archiveProjectId !== null ||
    restoreProjectId !== null ||
    archiveDetailProjectId !== null ||
    monitorCampaignId !== null ||
    monitorCampaignUrlsId !== null ||
    monitorCampaignHistoryId !== null ||
    monitorCampaignAlertsId !== null ||
    monitorCampaignRunId !== null ||
    monitoredUrlId !== null ||
    monitoredUrlHistoryId !== null ||
    monitorIssueResolveId !== null ||
    referenceSerpFeatureId !== null ||
    conversionOverridesProjectId !== null ||
    conversionOverrideId !== null ||
    contentPlanId !== null ||
    contentPlanItemId !== null ||
    promoteContentPlanItemId !== null ||
    categoryConsolidationClientId !== null ||
    categoryConsolidationLatestClientId !== null ||
    adminUserId !== null ||
    adminRoleUserId !== null ||
    adminApprovalUserId !== null ||
    adminClientAccessUserId !== null;

  if (!isRuntimeRoute) {
    throw new HttpError(404, "not_found", "Route not found.");
  }

  const isLocalOnlyRoute =
    url.pathname === "/v1/local-auth/register" ||
    url.pathname === "/v1/local-auth/login" ||
    providerProjectId !== null;
  if (isLocalOnlyRoute && environment !== "local") {
    throw new HttpError(404, "not_found", "Route not found.");
  }

  const runtime = requireRuntime(config);

  if (url.pathname === "/v1/auth/register") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    const body = await readJson(request);
    if (environment === "local") {
      sendJson(response, 201, await registerLocalUser(runtime.pool, body));
      return;
    }
    if (!config.identityAdmin || !config.registrationContinueUrl) {
      throw new HttpError(
        503,
        "registration_unavailable",
        "Account registration is not configured.",
      );
    }
    sendJson(
      response,
      201,
      await registerIdentityUser(
        runtime.pool,
        config.identityAdmin,
        body,
        config.registrationContinueUrl,
      ),
    );
    return;
  }

  if (url.pathname === "/v1/local-auth/register") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }

    const result = await registerLocalUser(runtime.pool, await readJson(request));
    sendJson(response, 201, result);
    return;
  }

  if (url.pathname === "/v1/local-auth/login") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }

    const result = await loginLocalUser(runtime.pool, await readJson(request));
    sendJson(response, 200, result);
    return;
  }

  const user = await (config.authenticateRequest ?? authenticateLocalRequest)(
    runtime.pool,
    request,
  );

  if (url.pathname === "/v1/me") {
    if (method === "GET") {
      sendJson(response, 200, await getCurrentProfile(runtime.pool, user));
      return;
    }
    if (method === "PATCH") {
      sendJson(
        response,
        200,
        await updateCurrentProfile(
          runtime.pool,
          user,
          await readJson(request, 100 * 1_024),
        ),
      );
      return;
    }
    methodNotAllowed(response, ["GET", "PATCH"]);
  }

  await assertApprovedUser(runtime.pool, user);

  if (slideExportProjectId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    if (
      !config.exportImageStore ||
      !config.slidesClient ||
      !config.slidesTemplateId
    ) {
      throw new HttpError(
        503,
        "slide_export_unavailable",
        "Google Slides export is not configured.",
      );
    }
    sendJson(
      response,
      201,
      await exportProjectSlides(
        runtime.pool,
        config.exportImageStore,
        config.slidesClient,
        config.slidesTemplateId,
        user,
        slideExportProjectId,
        await readJson(request, 21 * 1_024 * 1_024),
      ),
    );
    return;
  }

  if (url.pathname === "/v1/portfolio") {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(response, 200, await getPortfolioDashboard(runtime.pool, user));
    return;
  }

  if (url.pathname === "/v1/capture-window") {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await listCaptureWindowRows(
        runtime.pool,
        user,
        url.searchParams.get("inWindowOnly") !== "false",
      ),
    );
    return;
  }

  if (url.pathname === "/v1/content-plans") {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    const projectId = url.searchParams.get("projectId");
    if (projectId && !UUID_PATTERN.test(projectId)) {
      throw new HttpError(400, "invalid_request", "projectId is invalid.");
    }
    sendJson(
      response,
      200,
      await listContentPlans(runtime.pool, user, projectId),
    );
    return;
  }

  if (url.pathname === "/v1/content-plans/generate") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      201,
      await generateContentPlan(
        runtime.pool,
        user,
        await readJson(request, 2 * 1_024 * 1_024),
        config.textGenerationClient,
      ),
    );
    return;
  }

  if (contentPlanId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await getContentPlan(runtime.pool, user, contentPlanId),
    );
    return;
  }

  if (promoteContentPlanItemId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await promoteContentPlanItemToHero(
        runtime.pool,
        user,
        promoteContentPlanItemId,
      ),
    );
    return;
  }

  if (contentPlanItemId) {
    if (method !== "PATCH") {
      methodNotAllowed(response, ["PATCH"]);
    }
    sendJson(
      response,
      200,
      await updateContentPlanItem(
        runtime.pool,
        user,
        contentPlanItemId,
        await readJson(request, 256 * 1_024),
      ),
    );
    return;
  }

  if (url.pathname === "/v1/admin/users") {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(response, 200, await listUsers(runtime.pool, user));
    return;
  }

  if (url.pathname === "/v1/admin/users/invitations") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    if (!config.identityAdmin || !config.registrationContinueUrl) {
      throw new HttpError(
        503,
        "identity_administration_unavailable",
        "Identity administration is not configured.",
      );
    }
    sendJson(
      response,
      201,
      await inviteUser(
        runtime.pool,
        config.identityAdmin,
        user,
        await readJson(request),
        config.registrationContinueUrl,
      ),
    );
    return;
  }

  if (adminRoleUserId) {
    if (method !== "PATCH") {
      methodNotAllowed(response, ["PATCH"]);
    }
    sendJson(
      response,
      200,
      await setUserRole(
        runtime.pool,
        user,
        adminRoleUserId,
        await readJson(request),
      ),
    );
    return;
  }

  if (adminApprovalUserId) {
    if (method !== "PATCH") {
      methodNotAllowed(response, ["PATCH"]);
    }
    sendJson(
      response,
      200,
      await decideUserApproval(
        runtime.pool,
        user,
        adminApprovalUserId,
        await readJson(request),
      ),
    );
    return;
  }

  if (adminClientAccessUserId) {
    if (method !== "PUT") {
      methodNotAllowed(response, ["PUT"]);
    }
    sendJson(
      response,
      200,
      await replaceUserClientAccess(
        runtime.pool,
        user,
        adminClientAccessUserId,
        await readJson(request),
      ),
    );
    return;
  }

  if (adminUserId) {
    if (method !== "DELETE") {
      methodNotAllowed(response, ["DELETE"]);
    }
    if (!config.identityAdmin) {
      throw new HttpError(
        503,
        "identity_administration_unavailable",
        "Identity administration is not configured.",
      );
    }
    sendJson(
      response,
      200,
      await deleteUser(
        runtime.pool,
        config.identityAdmin,
        user,
        adminUserId,
      ),
    );
    return;
  }

  if (url.pathname === "/v1/url-monitor/overview") {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await getUrlMonitorOverview(runtime.pool, user),
    );
    return;
  }

  if (url.pathname === "/v1/url-monitor/campaigns") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      201,
      await createMonitorCampaign(
        runtime.pool,
        user,
        await readJson(request),
      ),
    );
    return;
  }

  if (monitorCampaignUrlsId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await addMonitoredUrls(
        runtime.pool,
        user,
        monitorCampaignUrlsId,
        await readJson(request, 5 * 1_024 * 1_024),
      ),
    );
    return;
  }

  if (monitorCampaignHistoryId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await getMonitorCampaignHistory(
        runtime.pool,
        user,
        monitorCampaignHistoryId,
        url.searchParams.get("days"),
      ),
    );
    return;
  }

  if (monitorCampaignAlertsId) {
    if (method !== "PATCH") {
      methodNotAllowed(response, ["PATCH"]);
    }
    sendJson(
      response,
      200,
      await updateMonitorAlerts(
        runtime.pool,
        user,
        monitorCampaignAlertsId,
        await readJson(request),
      ),
    );
    return;
  }

  if (monitorCampaignRunId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await runMonitorCampaign(runtime.pool, user, monitorCampaignRunId),
    );
    return;
  }

  if (monitorCampaignId) {
    if (method === "GET") {
      sendJson(
        response,
        200,
        await getMonitorCampaign(runtime.pool, user, monitorCampaignId),
      );
      return;
    }
    if (method === "PATCH") {
      sendJson(
        response,
        200,
        await updateMonitorCampaign(
          runtime.pool,
          user,
          monitorCampaignId,
          await readJson(request),
        ),
      );
      return;
    }
    methodNotAllowed(response, ["GET", "PATCH"]);
  }

  if (monitoredUrlHistoryId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await getMonitoredUrlHistory(
        runtime.pool,
        user,
        monitoredUrlHistoryId,
      ),
    );
    return;
  }

  if (monitoredUrlId) {
    if (method !== "DELETE") {
      methodNotAllowed(response, ["DELETE"]);
    }
    sendJson(
      response,
      200,
      await deleteMonitoredUrl(runtime.pool, user, monitoredUrlId),
    );
    return;
  }

  if (monitorIssueResolveId) {
    if (method !== "PATCH") {
      methodNotAllowed(response, ["PATCH"]);
    }
    sendJson(
      response,
      200,
      await resolveMonitorIssue(runtime.pool, user, monitorIssueResolveId),
    );
    return;
  }

  if (url.pathname === "/v1/reference-data") {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(response, 200, await getReferenceData(runtime.pool));
    return;
  }

  if (url.pathname === "/v1/reference-data/serp-features") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await createSerpFeatures(
        runtime.pool,
        user,
        await readJson(request, 5 * 1_024 * 1_024),
      ),
    );
    return;
  }

  if (referenceSerpFeatureId) {
    if (method !== "PATCH") {
      methodNotAllowed(response, ["PATCH"]);
    }
    sendJson(
      response,
      200,
      await updateSerpFeature(
        runtime.pool,
        user,
        referenceSerpFeatureId,
        await readJson(request),
      ),
    );
    return;
  }

  if (conversionOverridesProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await listConversionOverrides(
        runtime.pool,
        user,
        conversionOverridesProjectId,
      ),
    );
    return;
  }

  if (url.pathname === "/v1/conversion-overrides") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await upsertConversionOverride(
        runtime.pool,
        user,
        await readJson(request),
      ),
    );
    return;
  }

  if (conversionOverrideId) {
    if (method !== "DELETE") {
      methodNotAllowed(response, ["DELETE"]);
    }
    sendJson(
      response,
      200,
      await deleteConversionOverride(
        runtime.pool,
        user,
        conversionOverrideId,
      ),
    );
    return;
  }

  if (categoryConsolidationLatestClientId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await getLastCategoryBatch(
        runtime.pool,
        user,
        categoryConsolidationLatestClientId,
      ),
    );
    return;
  }

  if (categoryConsolidationClientId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await consolidateCategories(
        runtime.pool,
        user,
        categoryConsolidationClientId,
        await readJson(request),
      ),
    );
    return;
  }

  if (url.pathname === "/v1/clients") {
    if (method === "GET") {
      sendJson(
        response,
        200,
        await listClients(
          runtime.pool,
          user,
          url.searchParams.get("includeArchived") === "true",
        ),
      );
      return;
    }
    if (method === "POST") {
      sendJson(
        response,
        201,
        await createClient(runtime.pool, user, await readJson(request)),
      );
      return;
    }
    methodNotAllowed(response, ["GET", "POST"]);
  }

  if (clientProjectClientId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }

    sendJson(
      response,
      201,
      await createProject(
        runtime.pool,
        user,
        clientProjectClientId,
        await readJson(request),
      ),
    );
    return;
  }

  if (clientLogoClientId) {
    if (method === "GET") {
      sendJson(
        response,
        200,
        await getClientLogo(
          runtime.pool,
          runtime.objectStore,
          user,
          clientLogoClientId,
        ),
      );
      return;
    }
    if (method === "PUT") {
      sendJson(
        response,
        200,
        await putClientLogo(
          runtime.pool,
          runtime.objectStore,
          user,
          clientLogoClientId,
          await readJson(request, 7 * 1_024 * 1_024),
        ),
      );
      return;
    }
    methodNotAllowed(response, ["GET", "PUT"]);
  }

  if (clientUsersClientId) {
    if (method === "GET") {
      sendJson(
        response,
        200,
        await listClientUsers(runtime.pool, user, clientUsersClientId),
      );
      return;
    }
    if (method === "POST") {
      sendJson(
        response,
        201,
        await grantClientUser(
          runtime.pool,
          user,
          clientUsersClientId,
          await readJson(request),
        ),
      );
      return;
    }
    methodNotAllowed(response, ["GET", "POST"]);
  }

  if (clientBrandTermsClientId) {
    if (method !== "PATCH") {
      methodNotAllowed(response, ["PATCH"]);
    }
    sendJson(
      response,
      200,
      await updateClientBrandTerms(
        runtime.pool,
        user,
        clientBrandTermsClientId,
        await readJson(request),
      ),
    );
    return;
  }

  if (clientEligibleOwnersClientId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await listEligibleClientOwners(
        runtime.pool,
        user,
        clientEligibleOwnersClientId,
      ),
    );
    return;
  }

  if (clientUser) {
    if (method !== "DELETE") {
      methodNotAllowed(response, ["DELETE"]);
    }
    sendJson(
      response,
      200,
      await revokeClientUser(
        runtime.pool,
        user,
        clientUser.clientId,
        clientUser.userId,
      ),
    );
    return;
  }

  if (archiveClientId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await archiveClient(
        runtime.pool,
        user,
        archiveClientId,
        await readJson(request),
      ),
    );
    return;
  }

  if (restoreClientId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await restoreClient(runtime.pool, user, restoreClientId),
    );
    return;
  }

  if (clientId) {
    if (method === "GET") {
      sendJson(response, 200, await getClient(runtime.pool, user, clientId));
      return;
    }
    if (method === "PATCH") {
      sendJson(
        response,
        200,
        await updateClient(
          runtime.pool,
          user,
          clientId,
          await readJson(request, 2 * 1_024 * 1_024),
        ),
      );
      return;
    }
    if (method === "DELETE") {
      sendJson(
        response,
        200,
        await deleteClient(runtime.pool, runtime.objectStore, user, clientId),
      );
      return;
    }
    methodNotAllowed(response, ["DELETE", "GET", "PATCH"]);
  }

  if (url.pathname === "/v1/projects") {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await listProjects(
        runtime.pool,
        user,
        url.searchParams.get("clientId"),
        url.searchParams.get("includeArchived") === "true",
      ),
    );
    return;
  }

  if (keywordProjectId) {
    if (method === "GET") {
      sendJson(
        response,
        200,
        await getProjectKeywords(runtime.pool, user, keywordProjectId, {
          categorisedOnly:
            url.searchParams.get("categorisedOnly") === "true",
          detoxStatus: url.searchParams.get("detoxStatus"),
          direction: url.searchParams.get("direction"),
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
          rankingUrlOnly:
            url.searchParams.get("rankingUrlOnly") === "true",
          search: url.searchParams.get("search"),
          sort: url.searchParams.get("sort"),
        }),
      );
      return;
    }
    if (method === "POST") {
      sendJson(
        response,
        200,
        await addProjectKeywords(
          runtime.pool,
          user,
          keywordProjectId,
          await readJson(request, 20 * 1_024 * 1_024),
        ),
      );
      return;
    }
    if (method === "PATCH") {
      sendJson(
        response,
        200,
        await mutateProjectKeywords(
          runtime.pool,
          user,
          keywordProjectId,
          await readJson(request, 5 * 1_024 * 1_024),
        ),
      );
      return;
    }
    methodNotAllowed(response, ["GET", "POST", "PATCH"]);
  }

  if (gscProjectId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }

    sendJson(
      response,
      201,
      await importProjectGscRows(
        runtime.pool,
        user,
        gscProjectId,
        await readJson(request, 20 * 1_024 * 1_024),
      ),
    );
    return;
  }

  if (gscWorkbookProjectId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    const parsed = parseGscWorkbookImport(
      await readJson(request, 30 * 1_024 * 1_024),
    );
    sendJson(
      response,
      201,
      await importProjectGscRows(
        runtime.pool,
        user,
        gscWorkbookProjectId,
        parsed,
      ),
    );
    return;
  }

  if (ruleProjectId) {
    if (method !== "PUT") {
      methodNotAllowed(response, ["PUT"]);
    }

    sendJson(
      response,
      200,
      await replaceProjectRules(
        runtime.pool,
        user,
        ruleProjectId,
        await readJson(request),
      ),
    );
    return;
  }

  if (providerProjectId) {
    if (method !== "PUT") {
      methodNotAllowed(response, ["PUT"]);
    }

    sendJson(
      response,
      200,
      await replaceLocalProviderInputs(
        runtime.pool,
        user,
        providerProjectId,
        await readJson(request, 20 * 1_024 * 1_024),
      ),
    );
    return;
  }

  if (pipelineProjectId) {
    if (method === "GET") {
      sendJson(
        response,
        200,
        await getLatestProjectPipelineRun(
          runtime.pool,
          user,
          pipelineProjectId,
          url.searchParams.get("includeOutput") === "true",
        ),
      );
      return;
    }
    if (method !== "POST") {
      methodNotAllowed(response, ["GET", "POST"]);
    }
    await assertProjectAccess(runtime.pool, user.id, pipelineProjectId, true);
    const run = await createPipelineRun(runtime.pool, user, {
      inputVersion: "project-v1",
      projectId: pipelineProjectId,
    });
    const orchestration =
      config.orchestrator &&
      typeof run.id === "string" &&
      run.resumed !== true
        ? await config.orchestrator.start(run.id)
        : null;
    sendJson(response, 202, {
      ...run,
      ...(orchestration ?? {}),
    });
    return;
  }

  if (serpProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? "100");
    const rawOffset = Number(url.searchParams.get("offset") ?? "0");
    if (
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > 1_000 ||
      !Number.isInteger(rawOffset) ||
      rawOffset < 0
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "Pagination parameters are invalid.",
      );
    }
    sendJson(
      response,
      200,
      await getProjectSerpResults(
        runtime.pool,
        user,
        serpProjectId,
        rawLimit,
        rawOffset,
        url.searchParams.get("keywordId"),
      ),
    );
    return;
  }

  if (serpImportProjectId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      201,
      await importProjectSerpCsv(
        runtime.pool,
        user,
        serpImportProjectId,
        await readJson(request, 20 * 1_024 * 1_024),
      ),
    );
    return;
  }

  if (serpFeaturesProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? "200");
    const rawOffset = Number(url.searchParams.get("offset") ?? "0");
    if (
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > 1_000 ||
      !Number.isInteger(rawOffset) ||
      rawOffset < 0
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "Pagination parameters are invalid.",
      );
    }
    sendJson(
      response,
      200,
      await listProjectSerpFeatures(
        runtime.pool,
        user,
        serpFeaturesProjectId,
        rawLimit,
        rawOffset,
      ),
    );
    return;
  }

  if (calculationsProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await getProjectCalculations(
        runtime.pool,
        user,
        calculationsProjectId,
      ),
    );
    return;
  }

  if (calculationInspectorProjectId || linkPowerInspectorProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const rawOffset = Number(url.searchParams.get("offset") ?? "0");
    const search = (url.searchParams.get("search") ?? "").trim();
    if (
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > 200 ||
      !Number.isInteger(rawOffset) ||
      rawOffset < 0 ||
      search.length > 200
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "Inspector parameters are invalid.",
      );
    }
    sendJson(
      response,
      200,
      calculationInspectorProjectId
        ? await getProjectCalculationInspector(
            runtime.pool,
            user,
            calculationInspectorProjectId,
            rawLimit,
            rawOffset,
            search,
          )
        : await getProjectLinkPowerInspector(
            runtime.pool,
            user,
            linkPowerInspectorProjectId as string,
            rawLimit,
            rawOffset,
            search,
          ),
    );
    return;
  }

  if (forecastRowsProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? "200");
    const rawOffset = Number(url.searchParams.get("offset") ?? "0");
    if (
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > 1_000 ||
      !Number.isInteger(rawOffset) ||
      rawOffset < 0
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "Pagination parameters are invalid.",
      );
    }
    sendJson(
      response,
      200,
      await getProjectForecastRows(
        runtime.pool,
        user,
        forecastRowsProjectId,
        url.searchParams.get("scenario") ?? "realistic",
        rawLimit,
        rawOffset,
      ),
    );
    return;
  }

  if (siteArchitectureProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? "200");
    const rawOffset = Number(url.searchParams.get("offset") ?? "0");
    if (
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > 1_000 ||
      !Number.isInteger(rawOffset) ||
      rawOffset < 0
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "Pagination parameters are invalid.",
      );
    }
    sendJson(
      response,
      200,
      await getProjectSiteArchitecture(
        runtime.pool,
        user,
        siteArchitectureProjectId,
        rawLimit,
        rawOffset,
      ),
    );
    return;
  }

  if (ctrCurvesProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await getProjectCtrCurves(runtime.pool, user, ctrCurvesProjectId),
    );
    return;
  }

  if (roadmapsProjectId) {
    if (method === "GET") {
      sendJson(
        response,
        200,
        await listProjectRoadmaps(runtime.pool, user, roadmapsProjectId),
      );
      return;
    }
    if (method === "POST") {
      sendJson(
        response,
        201,
        await generateProjectRoadmap(runtime.pool, user, roadmapsProjectId),
      );
      return;
    }
    methodNotAllowed(response, ["GET", "POST"]);
  }

  if (summaryProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await getProjectSummary(runtime.pool, user, summaryProjectId),
    );
    return;
  }

  if (duplicateProjectId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      201,
      await duplicateProject(runtime.pool, user, duplicateProjectId),
    );
    return;
  }

  if (dirtyProjectId) {
    if (method !== "PATCH") {
      methodNotAllowed(response, ["PATCH"]);
    }
    sendJson(
      response,
      200,
      await markProjectDirty(
        runtime.pool,
        user,
        dirtyProjectId,
        await readJson(request),
      ),
    );
    return;
  }

  if (archiveProjectId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await archiveProject(
        runtime.pool,
        user,
        archiveProjectId,
        await readJson(request),
      ),
    );
    return;
  }

  if (archiveDetailProjectId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }
    sendJson(
      response,
      200,
      await getArchivedProjectDetail(
        runtime.pool,
        user,
        archiveDetailProjectId,
      ),
    );
    return;
  }

  if (restoreProjectId) {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }
    sendJson(
      response,
      200,
      await restoreProject(runtime.pool, user, restoreProjectId),
    );
    return;
  }

  if (projectId) {
    if (method === "GET") {
      sendJson(response, 200, await getProject(runtime.pool, user, projectId));
      return;
    }
    if (method === "PATCH") {
      sendJson(
        response,
        200,
        await updateProject(
          runtime.pool,
          user,
          projectId,
          await readJson(request),
        ),
      );
      return;
    }
    if (method === "DELETE") {
      sendJson(
        response,
        200,
        await deleteProject(runtime.pool, runtime.objectStore, user, projectId),
      );
      return;
    }
    methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
  }

  if (url.pathname === "/v1/assets") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }

    const result = await createAsset(
      runtime.pool,
      runtime.objectStore,
      user,
      await readJson(request, 7 * 1_024 * 1_024),
    );
    sendJson(response, 201, result);
    return;
  }

  if (assetId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }

    sendJson(
      response,
      200,
      await getAsset(runtime.pool, runtime.objectStore, user, assetId),
    );
    return;
  }

  if (url.pathname === "/v1/pipeline-runs") {
    if (method !== "POST") {
      methodNotAllowed(response, ["POST"]);
    }

    const result = await createPipelineRun(
      runtime.pool,
      user,
      await readJson(request, 100 * 1_024),
    );
    const orchestration =
      config.orchestrator &&
      typeof result.id === "string" &&
      result.resumed !== true
        ? await config.orchestrator.start(result.id)
        : null;
    sendJson(response, 202, {
      ...result,
      ...(orchestration ?? {}),
    });
    return;
  }

  if (runId) {
    if (method !== "GET") {
      methodNotAllowed(response, ["GET"]);
    }

    sendJson(
      response,
      200,
      await getPipelineRun(
        runtime.pool,
        user,
        runId,
        url.searchParams.get("includeOutput") !== "false",
      ),
    );
    return;
  }

  throw new HttpError(404, "not_found", "Route not found.");
}

export function createApiServer(config: ApiServerConfig = {}): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, config).catch((error: unknown) => {
      sendError(response, error);
    });
  });
}
