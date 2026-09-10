import process from "node:process";

import { createDatabasePool } from "../../../packages/runtime/src/database.js";
import { installShutdownHandlers, resolvePort } from "../../../packages/runtime/src/process.js";
import { executeStageTask, failPipelineRun } from "./processor.js";
import { createWorkerServer, WORKER_SERVICE_NAME } from "./server.js";
import {
  DataForSeoAuthorityClient,
  DataForSeoClient,
  LivePipelineProviderHydrator,
} from "./live-providers.js";
import { OpenRouterPipelineClient, resolveOpenRouterConcurrency } from "./openrouter.js";

const internalToken = process.env.INTERNAL_SERVICE_TOKEN;
const environment = process.env.SEER_ENVIRONMENT ?? "local";
const dataForSeoCredentials = process.env.DATAFORSEO_CREDENTIALS;
const openRouterApiKey = process.env.OPENROUTER_API_KEY;

if (!internalToken) {
  throw new Error("INTERNAL_SERVICE_TOKEN is required.");
}
if (
  environment !== "local" &&
  (!dataForSeoCredentials || !openRouterApiKey)
) {
  throw new Error("The managed provider configuration is incomplete.");
}

const pool = createDatabasePool();
const providerHydrator =
  dataForSeoCredentials && openRouterApiKey
    ? new LivePipelineProviderHydrator(
        new DataForSeoClient(dataForSeoCredentials),
        new DataForSeoAuthorityClient(dataForSeoCredentials),
        new OpenRouterPipelineClient(openRouterApiKey, undefined, undefined,
          resolveOpenRouterConcurrency(process.env.OPENROUTER_BATCH_CONCURRENCY)),
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
