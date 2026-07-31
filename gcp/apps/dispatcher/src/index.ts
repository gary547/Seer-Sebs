import process from "node:process";

import { createDatabasePool } from "../../../packages/runtime/src/database.js";
import { installShutdownHandlers, resolvePort } from "../../../packages/runtime/src/process.js";
import { runDispatcher } from "./dispatcher.js";
import { createDispatcherServer, DISPATCHER_SERVICE_NAME } from "./server.js";

const internalToken = process.env.INTERNAL_SERVICE_TOKEN;
const workerUrl = process.env.WORKER_URL;

if (!internalToken) {
  throw new Error("INTERNAL_SERVICE_TOKEN is required.");
}
if (!workerUrl) {
  throw new Error("WORKER_URL is required.");
}

const pool = createDatabasePool();
const controller = new AbortController();
const port = resolvePort(process.env.PORT);
const server = createDispatcherServer(pool);
const loop = runDispatcher(
  {
    internalToken,
    pollMilliseconds: Number(process.env.POLL_MILLISECONDS ?? "100"),
    pool,
    workerAudience: process.env.WORKER_AUDIENCE,
    workerUrl,
  },
  controller.signal,
);

loop.catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

server.listen(port, "0.0.0.0", () => {
  console.log(`${DISPATCHER_SERVICE_NAME} listening on port ${port}`);
});

installShutdownHandlers(DISPATCHER_SERVICE_NAME, [server], async () => {
  controller.abort();
  await loop;
  await pool.end();
});
