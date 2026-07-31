interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export class MetadataAccessTokenProvider implements AccessTokenProvider {
  private cached: { expiresAt: number; token: string } | null = null;

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) {
      return this.cached.token;
    }

    const response = await this.fetchImplementation(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: {
          "metadata-flavor": "Google",
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Metadata access-token endpoint returned ${response.status}.`);
    }

    const body = (await response.json()) as Partial<AccessTokenResponse>;
    if (
      typeof body.access_token !== "string" ||
      !body.access_token ||
      typeof body.expires_in !== "number" ||
      body.expires_in <= 0
    ) {
      throw new Error("Metadata access-token endpoint returned an invalid response.");
    }

    this.cached = {
      expiresAt: this.now() + body.expires_in * 1_000,
      token: body.access_token,
    };
    return body.access_token;
  }
}
