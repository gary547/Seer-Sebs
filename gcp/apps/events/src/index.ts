import process from "node:process";

import { createDatabasePool } from "../../../packages/runtime/src/database.js";
import { installShutdownHandlers, resolvePort } from "../../../packages/runtime/src/process.js";
import { PubSubEventPublisher } from "./publisher.js";
import { runEventRelay } from "./relay.js";
import { createEventsServer, EVENTS_SERVICE_NAME } from "./server.js";

const pool = createDatabasePool();
const controller = new AbortController();
const port = resolvePort(process.env.PORT);
const server = createEventsServer(pool);
const publisher =
  process.env.SEER_ENVIRONMENT === "local"
    ? undefined
    : new PubSubEventPublisher(
        process.env.PUBSUB_PROJECT_ID ?? "",
        process.env.PUBSUB_TOPIC_ID ?? "",
      );
const loop = runEventRelay(
  pool,
  Number(process.env.POLL_MILLISECONDS ?? "100"),
  controller.signal,
  console.error,
  publisher,
);

loop.catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

server.listen(port, "0.0.0.0", () => {
  console.log(`${EVENTS_SERVICE_NAME} listening on port ${port}`);
});

installShutdownHandlers(EVENTS_SERVICE_NAME, [server], async () => {
  controller.abort();
  await loop;
  await pool.end();
});
