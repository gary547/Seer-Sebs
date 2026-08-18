import type { IncomingMessage, ServerResponse } from "node:http";

import { gzipSync } from "fflate";

export interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export class HttpError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  options: { gzip?: boolean } = {},
): void {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  const payload = Buffer.from(JSON.stringify(body));
  if (options.gzip) {
    const compressed = Buffer.from(gzipSync(new Uint8Array(payload)));
    response.setHeader("content-encoding", "gzip");
    response.setHeader("content-length", String(compressed.length));
    response.end(compressed);
    return;
  }
  response.end(payload);
}

export function sendError(
  response: ServerResponse,
  error: unknown,
): void {
  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, {
      error: {
        code: error.code,
        message: error.message,
      },
    } satisfies ErrorBody);
    return;
  }

  console.error(error);
  sendJson(response, 500, {
    error: {
      code: "internal_error",
      message: "The request could not be completed.",
    },
  } satisfies ErrorBody);
}

export async function readBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > maximumBytes) {
      throw new HttpError(413, "payload_too_large", "The request body is too large.");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

export async function readJson(
  request: IncomingMessage,
  maximumBytes = 1_048_576,
): Promise<unknown> {
  const body = await readBody(request, maximumBytes);

  if (body.length === 0) {
    return {};
  }

  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body must be valid JSON.");
  }
}

export function requireString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }

  return value.trim();
}

export function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}
