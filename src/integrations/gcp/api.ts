const configuredBaseUrl = import.meta.env.VITE_SEER_API_URL?.trim();

export const SEER_API_URL =
  configuredBaseUrl ||
  (import.meta.env.DEV ? "http://127.0.0.1:18080" : "/api");

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export class SeerApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SeerApiError";
    this.status = status;
    this.code = code;
  }
}

export async function seerApiRequest<T>(
  path: string,
  options: RequestInit = {},
  accessToken?: string | null,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (accessToken) {
    headers.set("authorization", `Bearer ${accessToken}`);
  }

  const response = await fetch(`${SEER_API_URL}${path}`, {
    ...options,
    headers,
  });
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  if (!response.ok) {
    throw new SeerApiError(
      response.status,
      body.error?.code ?? "request_failed",
      body.error?.message ?? "The request could not be completed.",
    );
  }
  return body as T;
}
