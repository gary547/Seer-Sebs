import { createHash, randomUUID } from "node:crypto";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import type { AccessTokenProvider } from "../../../packages/runtime/src/google-auth.js";
import { MetadataAccessTokenProvider } from "../../../packages/runtime/src/google-auth.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import { assertProjectAccessByRole } from "./authorization.js";
import type { ObjectStore } from "./object-store-client.js";

const MAXIMUM_EXPORT_BYTES = 15 * 1_024 * 1_024;

export interface ExportImageStore {
  delete(key: string): Promise<void>;
  put(key: string, content: Buffer): Promise<string>;
}

export interface SlidesClient {
  createDeck(input: {
    imageHeight: number;
    imageUrl: string;
    imageWidth: number;
    name: string;
  }): Promise<{ id: string; name: string; url: string }>;
}

interface WorkspaceOauthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface WorkspaceTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface ProjectExportRow {
  client_id: string;
  client_name: string;
  project_name: string;
}

function parseOauthCredentials(value: string): WorkspaceOauthCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Google Workspace OAuth credentials are invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Google Workspace OAuth credentials are invalid.");
  }
  const record = parsed as Record<string, unknown>;
  const clientId = record.client_id ?? record.clientId;
  const clientSecret = record.client_secret ?? record.clientSecret;
  const refreshToken = record.refresh_token ?? record.refreshToken;
  if (
    typeof clientId !== "string" ||
    !clientId ||
    typeof clientSecret !== "string" ||
    !clientSecret ||
    typeof refreshToken !== "string" ||
    !refreshToken
  ) {
    throw new Error("Google Workspace OAuth credentials are incomplete.");
  }
  return { clientId, clientSecret, refreshToken };
}

export class WorkspaceOauthTokenProvider implements AccessTokenProvider {
  private cached: { expiresAt: number; token: string } | null = null;
  private readonly credentials: WorkspaceOauthCredentials;

  constructor(
    credentials: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.credentials = parseOauthCredentials(credentials);
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) {
      return this.cached.token;
    }
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: this.credentials.refreshToken,
    });
    const response = await this.fetchImplementation(
      "https://oauth2.googleapis.com/token",
      {
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Google Workspace token refresh returned ${response.status}.`,
      );
    }
    const token = (await response.json()) as WorkspaceTokenResponse;
    if (
      typeof token.access_token !== "string" ||
      !token.access_token ||
      typeof token.expires_in !== "number" ||
      token.expires_in <= 0
    ) {
      throw new Error("Google Workspace token response is invalid.");
    }
    this.cached = {
      expiresAt: this.now() + token.expires_in * 1_000,
      token: token.access_token,
    };
    return token.access_token;
  }
}

async function googleJson(
  url: string,
  tokenProvider: AccessTokenProvider,
  fetchImplementation: typeof fetch,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await tokenProvider.getAccessToken()}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetchImplementation(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  if (!response.ok) {
    throw new Error(`Google Workspace API returned ${response.status}.`);
  }
  return body;
}

function emuFromPoints(points: number): number {
  return Math.round(points * 12_700);
}

export class GoogleSlidesClient implements SlidesClient {
  constructor(
    private readonly templateId: string,
    private readonly tokenProvider: AccessTokenProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async createDeck(input: {
    imageHeight: number;
    imageUrl: string;
    imageWidth: number;
    name: string;
  }): Promise<{ id: string; name: string; url: string }> {
    const copied = await googleJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(this.templateId)}/copy?supportsAllDrives=true`,
      this.tokenProvider,
      this.fetchImplementation,
      {
        body: JSON.stringify({ name: input.name }),
        method: "POST",
      },
    );
    const deckId = copied.id;
    if (typeof deckId !== "string" || !deckId) {
      throw new Error("Google Drive copy did not return a presentation ID.");
    }
    const presentation = await googleJson(
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(deckId)}`,
      this.tokenProvider,
      this.fetchImplementation,
      { method: "GET" },
    );
    const pageSize =
      presentation.pageSize &&
      typeof presentation.pageSize === "object" &&
      !Array.isArray(presentation.pageSize)
        ? (presentation.pageSize as Record<string, unknown>)
        : {};
    const dimension = (value: unknown, fallback: number): number => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fallback;
      }
      const magnitude = (value as Record<string, unknown>).magnitude;
      return typeof magnitude === "number" ? magnitude : fallback;
    };
    const slideWidth = dimension(pageSize.width, emuFromPoints(720));
    const slideHeight = dimension(pageSize.height, emuFromPoints(405));
    const slides = Array.isArray(presentation.slides)
      ? presentation.slides
      : [];
    const firstSlide =
      slides[0] && typeof slides[0] === "object" && !Array.isArray(slides[0])
        ? (slides[0] as Record<string, unknown>)
        : null;
    if (!firstSlide || typeof firstSlide.objectId !== "string") {
      throw new Error("Google Slides template has no first slide.");
    }
    let titleBottom = emuFromPoints(60);
    let titleLeft = emuFromPoints(20);
    let usableWidth = slideWidth - emuFromPoints(40);
    const pageElements = Array.isArray(firstSlide.pageElements)
      ? firstSlide.pageElements
      : [];
    for (const elementValue of pageElements) {
      if (
        !elementValue ||
        typeof elementValue !== "object" ||
        Array.isArray(elementValue)
      ) {
        continue;
      }
      const element = elementValue as Record<string, unknown>;
      const shape =
        element.shape &&
        typeof element.shape === "object" &&
        !Array.isArray(element.shape)
          ? (element.shape as Record<string, unknown>)
          : {};
      const placeholder =
        shape.placeholder &&
        typeof shape.placeholder === "object" &&
        !Array.isArray(shape.placeholder)
          ? (shape.placeholder as Record<string, unknown>)
          : {};
      if (
        placeholder.type !== "TITLE" &&
        placeholder.type !== "CENTERED_TITLE"
      ) {
        continue;
      }
      const transform =
        element.transform &&
        typeof element.transform === "object" &&
        !Array.isArray(element.transform)
          ? (element.transform as Record<string, unknown>)
          : {};
      const size =
        element.size &&
        typeof element.size === "object" &&
        !Array.isArray(element.size)
          ? (element.size as Record<string, unknown>)
          : {};
      const translateX =
        typeof transform.translateX === "number" ? transform.translateX : 0;
      const translateY =
        typeof transform.translateY === "number" ? transform.translateY : 0;
      const scaleX = typeof transform.scaleX === "number" ? transform.scaleX : 1;
      const scaleY = typeof transform.scaleY === "number" ? transform.scaleY : 1;
      titleLeft = translateX;
      titleBottom =
        translateY + dimension(size.height, 0) * scaleY;
      usableWidth = dimension(size.width, usableWidth) * scaleX;
      break;
    }
    const imageTop = titleBottom + emuFromPoints(10);
    const availableHeight = slideHeight - imageTop - emuFromPoints(20);
    const imageAspect = input.imageWidth / input.imageHeight;
    let drawWidth = usableWidth;
    let drawHeight = drawWidth / imageAspect;
    if (drawHeight > availableHeight) {
      drawHeight = availableHeight;
      drawWidth = drawHeight * imageAspect;
    }
    const drawX = titleLeft + (usableWidth - drawWidth) / 2;
    await googleJson(
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(deckId)}:batchUpdate`,
      this.tokenProvider,
      this.fetchImplementation,
      {
        body: JSON.stringify({
          requests: [
            {
              createImage: {
                elementProperties: {
                  pageObjectId: firstSlide.objectId,
                  size: {
                    height: { magnitude: drawHeight, unit: "EMU" },
                    width: { magnitude: drawWidth, unit: "EMU" },
                  },
                  transform: {
                    scaleX: 1,
                    scaleY: 1,
                    translateX: drawX,
                    translateY: imageTop,
                    unit: "EMU",
                  },
                },
                url: input.imageUrl,
              },
            },
          ],
        }),
        method: "POST",
      },
    );
    return {
      id: deckId,
      name: input.name,
      url: `https://docs.google.com/presentation/d/${deckId}/edit`,
    };
  }
}

function encodedObjectPath(bucket: string, key: string): string {
  return `/${encodeURIComponent(bucket)}/${key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(parameters: Record<string, string>): string {
  return Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `${encodeQueryValue(key)}=${encodeQueryValue(value)}`,
    )
    .join("&");
}

export class GcsExportImageStore implements ExportImageStore {
  constructor(
    private readonly bucket: string,
    private readonly serviceAccountEmail: string,
    private readonly tokenProvider: AccessTokenProvider =
      new MetadataAccessTokenProvider(),
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async authorization(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.tokenProvider.getAccessToken()}`,
    };
  }

  async put(key: string, content: Buffer): Promise<string> {
    const upload = await this.fetchImplementation(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`,
      {
        body: new Uint8Array(content),
        headers: {
          ...(await this.authorization()),
          "content-type": "image/png",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!upload.ok) {
      throw new Error(`Cloud Storage export upload returned ${upload.status}.`);
    }
    const date = this.now();
    const timestamp = date
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    const dateStamp = timestamp.slice(0, 8);
    const credential = `${this.serviceAccountEmail}/${dateStamp}/auto/storage/goog4_request`;
    const parameters = canonicalQuery({
      "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
      "X-Goog-Credential": credential,
      "X-Goog-Date": timestamp,
      "X-Goog-Expires": "3600",
      "X-Goog-SignedHeaders": "host",
    });
    const path = encodedObjectPath(this.bucket, key);
    const canonicalRequest = [
      "GET",
      path,
      parameters,
      "host:storage.googleapis.com\n",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "GOOG4-RSA-SHA256",
      timestamp,
      `${dateStamp}/auto/storage/goog4_request`,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const signatureResponse = await this.fetchImplementation(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(this.serviceAccountEmail)}:signBlob`,
      {
        body: JSON.stringify({
          payload: Buffer.from(stringToSign).toString("base64"),
        }),
        headers: {
          ...(await this.authorization()),
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!signatureResponse.ok) {
      throw new Error(
        `IAM signed-URL request returned ${signatureResponse.status}.`,
      );
    }
    const signatureBody = (await signatureResponse.json()) as {
      signedBlob?: string;
    };
    if (!signatureBody.signedBlob) {
      throw new Error("IAM signed-URL response is invalid.");
    }
    const signature = Buffer.from(
      signatureBody.signedBlob,
      "base64",
    ).toString("hex");
    return `https://storage.googleapis.com${path}?${parameters}&X-Goog-Signature=${signature}`;
  }

  async delete(key: string): Promise<void> {
    const response = await this.fetchImplementation(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
      {
        headers: await this.authorization(),
        method: "DELETE",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Cloud Storage export delete returned ${response.status}.`);
    }
  }
}

export class LocalExportImageStore implements ExportImageStore {
  constructor(
    private readonly objectStore: ObjectStore,
    private readonly publicBaseUrl: string,
  ) {}

  async put(key: string, content: Buffer): Promise<string> {
    await this.objectStore.put(key, content);
    return `${this.publicBaseUrl.replace(/\/$/, "")}/objects/${key
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`;
  }

  delete(key: string): Promise<void> {
    return this.objectStore.delete(key);
  }
}

export class LocalSlidesClient implements SlidesClient {
  async createDeck(input: {
    imageHeight: number;
    imageUrl: string;
    imageWidth: number;
    name: string;
  }): Promise<{ id: string; name: string; url: string }> {
    const id = `local-${randomUUID()}`;
    return {
      id,
      name: input.name,
      url: `https://docs.google.com/presentation/d/${id}/edit`,
    };
  }
}

function pngDimensions(content: Buffer): { height: number; width: number } {
  if (
    content.length < 24 ||
    content[0] !== 0x89 ||
    content[1] !== 0x50 ||
    content[2] !== 0x4e ||
    content[3] !== 0x47
  ) {
    throw new HttpError(400, "invalid_png", "The export image is not a PNG.");
  }
  const width = content.readUInt32BE(16);
  const height = content.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 20_000 || height > 20_000) {
    throw new HttpError(
      400,
      "invalid_png",
      "The export image dimensions are invalid.",
    );
  }
  return { height, width };
}

function exportContent(body: unknown): Buffer {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }
  const input = body as Record<string, unknown>;
  const encoded = requireString(
    input.contentBase64,
    "contentBase64",
    Math.ceil((MAXIMUM_EXPORT_BYTES * 4) / 3) + 4,
  );
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw new HttpError(400, "invalid_base64", "contentBase64 is invalid.");
  }
  const content = Buffer.from(encoded, "base64");
  if (content.length > MAXIMUM_EXPORT_BYTES) {
    throw new HttpError(413, "export_too_large", "The export image is too large.");
  }
  return content;
}

export async function exportProjectSlides(
  pool: DatabasePool,
  imageStore: ExportImageStore,
  slidesClient: SlidesClient,
  templateId: string,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const content = exportContent(body);
  const dimensions = pngDimensions(content);
  await assertProjectAccessByRole(pool, user.id, projectId, true);
  const projectResult = await pool.query<ProjectExportRow>(
    `
      SELECT
        project.client_id,
        project.project_name,
        client.company_name AS client_name
      FROM navigator_projects AS project
      JOIN clients AS client ON client.id = project.client_id
      WHERE project.id = $1
        AND project.archived_at IS NULL
        AND client.archived_at IS NULL
    `,
    [projectId],
  );
  const project = projectResult.rows[0];
  if (!project) {
    throw new HttpError(404, "project_not_found", "Project not found.");
  }
  const exportId = randomUUID();
  const objectKey = `slide-exports/${projectId}/${exportId}.png`;
  const date = new Date().toISOString().slice(0, 10);
  const name = `[seer export] ${project.client_name} ${project.project_name} ${date} · revenue_v2.1`;
  await pool.query(
    `
      INSERT INTO slide_exports (
        id,
        client_id,
        project_id,
        created_by,
        template_id,
        object_key,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'running')
    `,
    [exportId, project.client_id, projectId, user.id, templateId, objectKey],
  );
  try {
    const imageUrl = await imageStore.put(objectKey, content);
    const deck = await slidesClient.createDeck({
      imageHeight: dimensions.height,
      imageUrl,
      imageWidth: dimensions.width,
      name,
    });
    let deletedAt: Date | null = null;
    try {
      await imageStore.delete(objectKey);
      deletedAt = new Date();
    } catch {
      deletedAt = null;
    }
    await pool.query(
      `
        UPDATE slide_exports
        SET
          deck_id = $2,
          deck_url = $3,
          deck_name = $4,
          status = 'succeeded',
          object_deleted_at = $5,
          completed_at = now()
        WHERE id = $1
      `,
      [exportId, deck.id, deck.url, deck.name, deletedAt],
    );
    return {
      id: deck.id,
      name: deck.name,
      url: deck.url,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 1_000) : "Export failed.";
    await pool.query(
      `
        UPDATE slide_exports
        SET status = 'failed', error_message = $2, completed_at = now()
        WHERE id = $1
      `,
      [exportId, message],
    );
    try {
      await imageStore.delete(objectKey);
    } catch {
      // The bucket lifecycle remains the final cleanup mechanism.
    }
    throw error;
  }
}
