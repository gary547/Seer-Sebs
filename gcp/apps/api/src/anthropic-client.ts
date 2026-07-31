export interface TextGenerationInput {
  maxTokens?: number;
  messages: Array<{
    content: string;
    role: "assistant" | "user";
  }>;
  model?: string;
  system?: string;
}

export interface TextGenerationClient {
  generate(input: TextGenerationInput): Promise<unknown>;
}

export class AnthropicClient implements TextGenerationClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async generate(input: TextGenerationInput): Promise<unknown> {
    const response = await this.fetchImplementation(
      "https://api.anthropic.com/v1/messages",
      {
        body: JSON.stringify({
          max_tokens: input.maxTokens ?? 4_096,
          messages: input.messages,
          model: input.model ?? "claude-sonnet-4-6",
          ...(input.system ? { system: input.system } : {}),
        }),
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        method: "POST",
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(
        `Anthropic returned ${response.status}${details ? `: ${details}` : "."}`,
      );
    }
    return response.json();
  }
}
