import process from "node:process";

import { installShutdownHandlers, resolvePort } from "../../../packages/runtime/src/process.js";
import {
  createObjectStoreServer,
  OBJECT_STORE_SERVICE_NAME,
} from "./server.js";

const internalToken = process.env.INTERNAL_SERVICE_TOKEN;

if (!internalToken) {
  throw new Error("INTERNAL_SERVICE_TOKEN is required.");
}

const port = resolvePort(process.env.PORT);
const server = createObjectStoreServer({
  dataDirectory: process.env.OBJECT_DATA_DIRECTORY ?? "/data/objects",
  internalToken,
});

server.listen(port, "0.0.0.0", () => {
  console.log(`${OBJECT_STORE_SERVICE_NAME} listening on port ${port}`);
});

installShutdownHandlers(OBJECT_STORE_SERVICE_NAME, [server], async () => {});
