import process from "node:process";

import { createDatabasePool } from "../../../packages/runtime/src/database.js";
import { installShutdownHandlers, resolvePort } from "../../../packages/runtime/src/process.js";
import { executeStageTask, failPipelineRun } from "./processor.js";
import { createWorkerServer, WORKER_SERVICE_NAME } from "./server.js";
import {
  AhrefsClient,
  AnthropicSiteArchitectureClient,
  DataForSeoClient,
  LivePipelineProviderHydrator,
} from "./live-providers.js";

const internalToken = process.env.INTERNAL_SERVICE_TOKEN;
const environment = process.env.SEER_ENVIRONMENT ?? "local";
const dataForSeoCredentials = process.env.DATAFORSEO_CREDENTIALS;
const ahrefsApiKey = process.env.AHREFS_API_KEY;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

if (!internalToken) {
  throw new Error("INTERNAL_SERVICE_TOKEN is required.");
}
if (
  environment !== "local" &&
  (!dataForSeoCredentials || !ahrefsApiKey || !anthropicApiKey)
) {
  throw new Error("The managed provider configuration is incomplete.");
}

const pool = createDatabasePool();
const providerHydrator =
  dataForSeoCredentials && ahrefsApiKey && anthropicApiKey
    ? new LivePipelineProviderHydrator(
        new DataForSeoClient(dataForSeoCredentials),
        new AhrefsClient(ahrefsApiKey),
        new AnthropicSiteArchitectureClient(anthropicApiKey),
      )
    : undefined;
const port = resolvePort(process.env.PORT);
const server = createWorkerServer({
  internalToken,
  pool,
  failRun: (failure) => failPipelineRun(pool, failure),
  processTask: (task) =>
    executeStageTask(pool, task, {
      allowLocalFailureInjection: environment === "local",
      providerHydrator,
    }),
});

server.listen(port, "0.0.0.0", () => {
  console.log(`${WORKER_SERVICE_NAME} listening on port ${port}`);
});

installShutdownHandlers(WORKER_SERVICE_NAME, [server], async () => {
  await pool.end();
});
