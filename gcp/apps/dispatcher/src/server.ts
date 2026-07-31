import { createServer, type Server } from "node:http";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { assertDatabaseReady } from "../../../packages/runtime/src/database.js";
import { HttpError, sendError, sendJson } from "../../../packages/runtime/src/http.js";

export const DISPATCHER_SERVICE_NAME = "seer-dispatcher";

export function createDispatcherServer(pool: DatabasePool): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://dispatcher.local");

      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        throw new HttpError(405, "method_not_allowed", "Only GET is allowed.");
      }
      if (url.pathname === "/healthz") {
        sendJson(response, 200, {
          service: DISPATCHER_SERVICE_NAME,
          status: "ok",
        });
        return;
      }
      if (url.pathname === "/readyz") {
        await assertDatabaseReady(pool);
        sendJson(response, 200, {
          service: DISPATCHER_SERVICE_NAME,
          status: "ready",
        });
        return;
      }

      throw new HttpError(404, "not_found", "Route not found.");
    } catch (error) {
      sendError(response, error);
    }
  });
}
