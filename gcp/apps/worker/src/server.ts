import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { assertDatabaseReady } from "../../../packages/runtime/src/database.js";
import {
  bearerToken,
  HttpError,
  readJson,
  sendError,
  sendJson,
} from "../../../packages/runtime/src/http.js";
import {
  parsePipelineFailure,
  parseStageTask,
  type PipelineFailure,
  type StageTask,
} from "./processor.js";

export const WORKER_SERVICE_NAME = "seer-worker";

export interface WorkerServerConfig {
  internalToken: string;
  failRun?: (failure: PipelineFailure) => Promise<Record<string, unknown>>;
  pool?: DatabasePool;
  processTask: (task: StageTask) => Promise<Record<string, unknown>>;
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const internalHeader = request.headers["x-seer-internal-token"];
  const token =
    typeof internalHeader === "string" ? internalHeader : bearerToken(request);

  if (!token) {
    return false;
  }

  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createWorkerServer(config: WorkerServerConfig): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://worker.local");

      if (url.pathname === "/healthz" && request.method === "GET") {
        sendJson(response, 200, {
          service: WORKER_SERVICE_NAME,
          status: "ok",
        });
        return;
      }

      if (url.pathname === "/readyz" && request.method === "GET") {
        if (!config.pool) {
          throw new HttpError(503, "database_not_configured", "Database is not configured.");
        }

        await assertDatabaseReady(config.pool);
        sendJson(response, 200, {
          service: WORKER_SERVICE_NAME,
          status: "ready",
        });
        return;
      }

      if (
        url.pathname !== "/internal/tasks" &&
        url.pathname !== "/internal/failures"
      ) {
        throw new HttpError(404, "not_found", "Route not found.");
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        throw new HttpError(405, "method_not_allowed", "Only POST is allowed.");
      }
      if (!authorized(request, config.internalToken)) {
        throw new HttpError(401, "invalid_internal_token", "The internal token is invalid.");
      }

      const body = await readJson(request);
      if (url.pathname === "/internal/failures") {
        if (!config.failRun) {
          throw new HttpError(
            503,
            "failure_recorder_not_configured",
            "Pipeline failure recording is not configured.",
          );
        }
        sendJson(response, 200, await config.failRun(parsePipelineFailure(body)));
        return;
      }

      const task = parseStageTask(body);
      const result = await config.processTask(task);
      sendJson(response, 200, {
        ...(typeof result.idempotent === "boolean"
          ? { idempotent: result.idempotent }
          : {}),
        runId: task.runId,
        stageId: task.stageId,
        status:
          typeof result.status === "string" ? result.status : "succeeded",
      });
    } catch (error) {
      sendError(response, error);
    }
  });
}
