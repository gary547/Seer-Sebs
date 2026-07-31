import { randomUUID, timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, resolve, sep } from "node:path";

import {
  bearerToken,
  HttpError,
  readBody,
  sendError,
  sendJson,
} from "../../../packages/runtime/src/http.js";

export const OBJECT_STORE_SERVICE_NAME = "seer-object-store";

export interface ObjectStoreConfig {
  dataDirectory: string;
  internalToken: string;
}

const MAXIMUM_OBJECT_BYTES = 5 * 1_024 * 1_024;

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const receivedToken = bearerToken(request);

  if (!receivedToken) {
    return false;
  }

  const received = Buffer.from(receivedToken);
  const expected = Buffer.from(expectedToken);

  return received.length === expected.length && timingSafeEqual(received, expected);
}

function objectKey(pathname: string): string | null {
  if (!pathname.startsWith("/objects/")) {
    return null;
  }

  const key = decodeURIComponent(pathname.slice("/objects/".length));
  const segments = key.split("/");

  if (
    key.length === 0 ||
    key.length > 256 ||
    segments.some(
      (segment) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(segment) ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new HttpError(400, "invalid_object_key", "The object key is invalid.");
  }

  return key;
}

function objectPath(dataDirectory: string, key: string): string {
  const root = resolve(dataDirectory);
  const path = resolve(root, key);

  if (!path.startsWith(`${root}${sep}`)) {
    throw new HttpError(400, "invalid_object_key", "The object key is invalid.");
  }

  return path;
}

export function createObjectStoreServer(config: ObjectStoreConfig): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://object-store.local");

      if (url.pathname === "/healthz" && request.method === "GET") {
        sendJson(response, 200, {
          service: OBJECT_STORE_SERVICE_NAME,
          status: "ok",
        });
        return;
      }

      if (url.pathname === "/readyz" && request.method === "GET") {
        await mkdir(config.dataDirectory, { recursive: true });
        await access(config.dataDirectory);
        sendJson(response, 200, {
          service: OBJECT_STORE_SERVICE_NAME,
          status: "ready",
        });
        return;
      }

      const key = objectKey(url.pathname);

      if (!key) {
        throw new HttpError(404, "not_found", "Route not found.");
      }

      if (!authorized(request, config.internalToken)) {
        throw new HttpError(401, "invalid_internal_token", "The internal token is invalid.");
      }

      const path = objectPath(config.dataDirectory, key);

      if (request.method === "PUT") {
        const body = await readBody(request, MAXIMUM_OBJECT_BYTES);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporaryPath, body, { flag: "wx" });
        await rename(temporaryPath, path);
        sendJson(response, 201, {
          key,
          sizeBytes: body.length,
        });
        return;
      }

      if (request.method === "GET") {
        let body: Buffer;

        try {
          body = await readFile(path);
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            throw new HttpError(404, "object_not_found", "Object not found.");
          }

          throw error;
        }

        response.statusCode = 200;
        response.setHeader("cache-control", "private, no-store");
        response.setHeader("content-length", String(body.length));
        response.setHeader("content-type", "application/octet-stream");
        response.setHeader("x-content-type-options", "nosniff");
        response.end(body);
        return;
      }

      if (request.method === "DELETE") {
        try {
          await unlink(path);
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
        sendJson(response, 200, { key, removed: true });
        return;
      }

      response.setHeader("allow", "DELETE, GET, PUT");
      throw new HttpError(405, "method_not_allowed", "Only DELETE, GET and PUT are allowed.");
    } catch (error) {
      sendError(response, error);
    }
  });
}
