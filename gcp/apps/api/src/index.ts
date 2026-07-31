import process from "node:process";

import { createDatabasePool } from "../../../packages/runtime/src/database.js";
import { MetadataAccessTokenProvider } from "../../../packages/runtime/src/google-auth.js";
import { installShutdownHandlers, resolvePort } from "../../../packages/runtime/src/process.js";
import { GcsObjectStore } from "./gcs-object-store.js";
import {
  authenticateIdentityPlatformRequest,
  IdentityPlatformVerifier,
} from "./identity-platform.js";
import { IdentityPlatformAdminClient } from "./identity-provisioning.js";
import { ObjectStoreClient } from "./object-store-client.js";
import { API_SERVICE_NAME, createApiServer } from "./server.js";
import { WorkflowsOrchestrator } from "./workflows-orchestrator.js";
import { AnthropicClient } from "./anthropic-client.js";
import {
  GcsExportImageStore,
  GoogleSlidesClient,
  LocalExportImageStore,
  LocalSlidesClient,
  WorkspaceOauthTokenProvider,
} from "./slide-exports.js";

const objectStoreUrl = process.env.OBJECT_STORE_URL;
const internalToken = process.env.INTERNAL_SERVICE_TOKEN;
const environment = process.env.SEER_ENVIRONMENT ?? "local";
const gcsAssetsBucket = process.env.GCS_ASSETS_BUCKET;
const identityProjectId = process.env.IDENTITY_PLATFORM_PROJECT_ID;
const identityApiKey = process.env.IDENTITY_PLATFORM_API_KEY;
const registrationContinueUrl = process.env.REGISTRATION_CONTINUE_URL;
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const workflowName = process.env.PIPELINE_WORKFLOW_NAME;
const workflowRegion = process.env.PIPELINE_WORKFLOW_REGION;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const gcsExportsBucket = process.env.GCS_EXPORTS_BUCKET;
const apiServiceAccountEmail = process.env.API_SERVICE_ACCOUNT_EMAIL;
const workspaceOauth = process.env.GOOGLE_WORKSPACE_OAUTH;
const slidesTemplateId = process.env.GOOGLE_SLIDES_TEMPLATE_ID;
const slidesMockEnabled = process.env.SLIDES_MOCK_ENABLED === "true";

if (environment === "local" && (!objectStoreUrl || !internalToken)) {
  throw new Error("OBJECT_STORE_URL and INTERNAL_SERVICE_TOKEN are required locally.");
}
if (
  environment !== "local" &&
  (
    !gcsAssetsBucket ||
    !identityProjectId ||
    !identityApiKey ||
    !registrationContinueUrl ||
    !workflowName ||
    !workflowRegion ||
    !gcsExportsBucket ||
    !apiServiceAccountEmail ||
    !workspaceOauth ||
    !slidesTemplateId
  )
) {
  throw new Error(
    "The managed API runtime configuration is incomplete.",
  );
}

const pool = createDatabasePool();
const objectStore =
  environment === "local"
    ? new ObjectStoreClient(objectStoreUrl!, internalToken!)
    : new GcsObjectStore(gcsAssetsBucket!);
const verifier =
  environment === "local" ? null : new IdentityPlatformVerifier(identityProjectId!);
const identityAdmin =
  environment === "local"
    ? null
    : new IdentityPlatformAdminClient(
        identityProjectId!,
        identityApiKey!,
        new MetadataAccessTokenProvider(),
      );
const orchestrator =
  environment === "local"
    ? null
    : new WorkflowsOrchestrator(
        identityProjectId!,
        workflowRegion!,
        workflowName!,
      );
const exportImageStore =
  environment === "local"
    ? new LocalExportImageStore(objectStore, objectStoreUrl!)
    : new GcsExportImageStore(gcsExportsBucket!, apiServiceAccountEmail!);
const slidesClient =
  environment === "local" && slidesMockEnabled
    ? new LocalSlidesClient()
    : workspaceOauth && slidesTemplateId
      ? new GoogleSlidesClient(
          slidesTemplateId,
          new WorkspaceOauthTokenProvider(workspaceOauth),
        )
      : undefined;
const port = resolvePort(process.env.PORT);
const server = createApiServer({
  allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
  authenticateRequest: verifier
    ? (database, request) =>
        authenticateIdentityPlatformRequest(database, request, verifier)
    : undefined,
  environment,
  exportImageStore,
  identityAdmin: identityAdmin ?? undefined,
  internalToken: internalToken!,
  objectStore,
  orchestrator: orchestrator ?? undefined,
  pool,
  registrationContinueUrl,
  revision: process.env.K_REVISION ?? "local",
  slidesClient,
  slidesTemplateId,
  textGenerationClient: anthropicApiKey
    ? new AnthropicClient(anthropicApiKey)
    : undefined,
});

server.listen(port, "0.0.0.0", () => {
  console.log(`${API_SERVICE_NAME} listening on port ${port}`);
});

installShutdownHandlers(API_SERVICE_NAME, [server], async () => {
  await pool.end();
});
