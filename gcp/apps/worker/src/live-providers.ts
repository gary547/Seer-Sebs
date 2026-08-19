import { createHash } from "node:crypto";

import { normaliseKeyword } from "../../../packages/fixtures/src/representative-project.js";
import type { PipelineStageId } from "../../../packages/pipeline/src/definition.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";

interface ProjectProviderRow {
  country: string | null;
  domain: string;
  language: string | null;
}

interface KeywordProviderRow {
  avg_monthly_volume: number | null;
  id: string;
  keyword: string;
  normalised_keyword: string;
  provider_fetched_at: Date | null;
  ranking_lookup_checked_at: Date | null;
  ranking_url: string | null;
}

interface EnrichedKeyword {
  avgMonthlyVolume: number | null;
  coreKeyword: string | null;
  intent: string | null;
  keyword: string;
  keywordDifficulty: number | null;
  monthlyVolumes: Array<{ month: string; volume: number }>;
}

interface RankingMatch {
  keyword: string;
  rank: number;
  url: string;
}

interface SerpTask {
  itemKey: string;
  keyword: string;
  providerTaskId: string;
}

interface SerpResult {
  domain: string;
  rankAbsolute: number;
  url: string;
}

interface SerpSnapshot {
  features: string[];
  results: SerpResult[];
}

interface AuthorityMetrics {
  ahrefsRank: number | null;
  backlinks: number | null;
  domainRating: number | null;
  referringDomains: number | null;
  urlRating: number | null;
}

interface SiteArchitectureResult {
  contentStatus: "amber" | "green" | "red";
  keyword: string;
  matchedUrl: string | null;
  relevancyScore: number;
  tacticalStatus:
    | "create_content"
    | "green"
    | "new_content"
    | "no_action_needed"
    | "optimise_content";
}

interface ProviderWorkItemRow {
  item_key: string;
  provider_task_id: string | null;
  state: "failed" | "pending" | "submitted" | "succeeded";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item) => item && typeof item === "object" && !Array.isArray(item),
        )
        .map((item) => item as Record<string, unknown>)
    : [];
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(parsed) &&
    parsed >= 0
    ? parsed
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const GOOGLE_ADS_KEYWORD_MAX_CHARS = 80;
export const GOOGLE_ADS_KEYWORD_MAX_WORDS = 10;

export function isGoogleAdsKeywordEligible(keyword: string): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) return false;
  if ([...trimmed].length > GOOGLE_ADS_KEYWORD_MAX_CHARS) return false;
  if (trimmed.split(/\s+/).filter(Boolean).length > GOOGLE_ADS_KEYWORD_MAX_WORDS) {
    return false;
  }
  return !/[^\x09\x0a\x0d\x20-\x7e]/.test(trimmed);
}

function emptyEnrichment(keyword: string): EnrichedKeyword {
  return {
    avgMonthlyVolume: null,
    coreKeyword: null,
    intent: null,
    keyword,
    keywordDifficulty: null,
    monthlyVolumes: [],
  };
}

function rejectedKeywordFromError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(
    /Keyword text exceeds the allowed limit:\s*'([^']+)'/i,
  );
  return match?.[1]?.trim() || null;
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

async function concurrently<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let index = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(values.length, 1)) },
      async () => {
        while (index < values.length) {
          const current = index;
          index += 1;
          results[current] = await operation(values[current]!);
        }
      },
    ),
  );
  return results;
}

function countryName(country: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "region" }).of(
        country.toUpperCase(),
      ) ?? country
    );
  } catch {
    return country;
  }
}

function locationTarget(
  country: string | null,
): { location_code: number } | { location_name: string } {
  const normalised = country?.trim().toUpperCase() ?? "";
  if (!normalised || normalised === "GB" || normalised === "UK") {
    return { location_code: 2826 };
  }
  return { location_name: countryName(normalised) };
}

function languageCode(language: string | null): string {
  const normalised = language?.trim().toLowerCase() ?? "";
  return /^[a-z]{2}$/.test(normalised) ? normalised : "en";
}

function cleanDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!;
}

function providerTag(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class ProviderHttpClient {
  constructor(
    private readonly authorization: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async json(
    url: string,
    init: Omit<RequestInit, "headers"> & {
      headers?: Record<string, string>;
    } = {},
  ): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const response = await this.fetchImplementation(url, {
          ...init,
          headers: {
            authorization: this.authorization,
            ...(init.body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...init.headers,
          },
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) {
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt < 5
          ) {
            const retryAfter = Number(response.headers.get("retry-after"));
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Number.isFinite(retryAfter) && retryAfter > 0
                  ? retryAfter * 1_000
                  : 250 * 2 ** (attempt - 1),
              ),
            );
            continue;
          }
          throw new Error(`Provider API returned ${response.status}.`);
        }
        return record(await response.json());
      } catch (error) {
        lastError = error;
        if (attempt < 5) {
          await new Promise((resolve) =>
            setTimeout(resolve, 250 * 2 ** (attempt - 1)),
          );
        }
      }
    }
    throw new Error("Provider API failed after five attempts.", {
      cause: lastError,
    });
  }
}

function dataForSeoItems(value: unknown): Record<string, unknown>[] {
  const root = record(value);
  const task = records(root.tasks)[0];
  if (!task || task.status_code !== 20000) {
    const code = task ? numberOrNull(task.status_code) : null;
    const message = task ? stringOrNull(task.status_message) : null;
    throw new Error(
      `DataForSEO task failed (${code ?? "unknown"}): ${message ?? "unknown task failure"}.`,
    );
  }
  const result = records(task.result);
  const nested = records(result[0]?.items);
  return nested.length > 0 ? nested : result;
}

function searchIntent(item: Record<string, unknown>): string | null {
  const raw = item.keyword_intent ?? item.intent;
  const label = Array.isArray(raw)
    ? stringOrNull(record(raw[0]).label)
    : typeof raw === "object"
      ? stringOrNull(record(raw).label)
      : stringOrNull(raw);
  const normalised = label?.toLowerCase() ?? null;
  return normalised &&
    ["commercial", "informational", "navigational", "transactional"].includes(
      normalised,
    )
    ? normalised
    : null;
}

export class DataForSeoClient {
  private readonly http: ProviderHttpClient;

  constructor(
    credentials: string,
    fetchImplementation: typeof fetch = fetch,
  ) {
    const encoded = credentials.includes(":")
      ? Buffer.from(credentials).toString("base64")
      : credentials;
    if (!encoded.trim()) throw new Error("DataForSEO credentials are required.");
    this.http = new ProviderHttpClient(`Basic ${encoded}`, fetchImplementation);
  }

  private async liveItems(
    path: string,
    task: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    return dataForSeoItems(
      await this.http.json(`https://api.dataforseo.com${path}`, {
        body: JSON.stringify([task]),
        method: "POST",
      }),
    );
  }

  private async optionalLiveItems(
    path: string,
    task: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    try {
      return await this.liveItems(path, task);
    } catch (error) {
      console.warn("Optional DataForSEO enrichment is unavailable.", {
        endpoint: path,
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async enrichKeywords(
    keywords: readonly string[],
    country: string | null,
    language: string | null,
  ): Promise<EnrichedKeyword[]> {
    const result = new Map<string, EnrichedKeyword>();
    const eligible: string[] = [];
    for (const keyword of keywords) {
      if (isGoogleAdsKeywordEligible(keyword)) {
        eligible.push(keyword);
        continue;
      }
      result.set(normaliseKeyword(keyword), emptyEnrichment(keyword));
    }
    for (const group of batches(eligible, 200)) {
      let remaining = group;
      while (remaining.length > 0) {
        try {
          await this.enrichEligibleGroup(remaining, country, language, result);
          break;
        } catch (error) {
          const rejected = rejectedKeywordFromError(error);
          const rejectedKey = rejected ? normaliseKeyword(rejected) : "";
          const next = rejectedKey
            ? remaining.filter((keyword) => normaliseKeyword(keyword) !== rejectedKey)
            : remaining;
          if (!rejected || next.length === remaining.length) throw error;
          result.set(rejectedKey, emptyEnrichment(rejected));
          remaining = next;
        }
      }
    }
    return [...result.values()];
  }

  private async enrichEligibleGroup(
    group: readonly string[],
    country: string | null,
    language: string | null,
    result: Map<string, EnrichedKeyword>,
  ): Promise<void> {
    const request = {
      keywords: group,
      language_code: languageCode(language),
      ...locationTarget(country),
    };
    const [volumeItems, historicalItems, difficultyItems, intentItems] = await Promise.all([
      this.liveItems(
        "/v3/keywords_data/google_ads/search_volume/live",
        request,
      ),
      this.optionalLiveItems(
        "/v3/dataforseo_labs/google/historical_search_volume/live",
        request,
      ),
      this.optionalLiveItems(
        "/v3/dataforseo_labs/google/bulk_keyword_difficulty/live",
        request,
      ),
      this.optionalLiveItems("/v3/dataforseo_labs/google/search_intent/live", {
        keywords: group,
        language_code: languageCode(language),
      }),
    ]);
    for (const keyword of group) {
      if (!result.has(normaliseKeyword(keyword))) {
        result.set(normaliseKeyword(keyword), emptyEnrichment(keyword));
      }
    }
    for (const item of volumeItems) {
      const key = normaliseKeyword(stringOrNull(item.keyword) ?? "");
      const value = result.get(key);
      if (!value) continue;
      const properties = record(item.keyword_properties);
      value.avgMonthlyVolume = numberOrNull(item.search_volume);
      value.coreKeyword = stringOrNull(properties.core_keyword);
      value.monthlyVolumes = records(item.monthly_searches)
        .map((point) => {
          const year = numberOrNull(point.year);
          const month = numberOrNull(point.month);
          const volume = numberOrNull(point.search_volume);
          return year &&
            month &&
            month <= 12 &&
            volume !== null
            ? {
                month: `${year}-${String(month).padStart(2, "0")}-01`,
                volume,
              }
            : null;
        })
        .filter(
          (
            point,
          ): point is {
            month: string;
            volume: number;
          } => point !== null,
        );
    }
    for (const item of historicalItems) {
      const key = normaliseKeyword(stringOrNull(item.keyword) ?? "");
      const value = result.get(key);
      if (!value) continue;
      const keywordInfo = record(item.keyword_info);
      const properties = record(item.keyword_properties);
      value.coreKeyword =
        stringOrNull(properties.core_keyword) ?? value.coreKeyword;
      value.avgMonthlyVolume =
        value.avgMonthlyVolume ?? numberOrNull(keywordInfo.search_volume);
      const history = records(keywordInfo.monthly_searches)
        .map((point) => {
          const year = numberOrNull(point.year);
          const month = numberOrNull(point.month);
          const volume = numberOrNull(point.search_volume);
          return year && month && month <= 12 && volume !== null
            ? {
                month: `${year}-${String(month).padStart(2, "0")}-01`,
                volume,
              }
            : null;
        })
        .filter(
          (point): point is { month: string; volume: number } =>
            point !== null,
        );
      if (history.length > value.monthlyVolumes.length) {
        value.monthlyVolumes = history;
      }
    }
    for (const item of difficultyItems) {
      const key = normaliseKeyword(stringOrNull(item.keyword) ?? "");
      const value = result.get(key);
      if (value) {
        value.keywordDifficulty = numberOrNull(item.keyword_difficulty);
      }
    }
    for (const item of intentItems) {
      const key = normaliseKeyword(stringOrNull(item.keyword) ?? "");
      const value = result.get(key);
      if (value) value.intent = searchIntent(item);
    }
  }

  async rankingUrls(
    domain: string,
    keywords: readonly string[],
    country: string | null,
    language: string | null,
  ): Promise<RankingMatch[]> {
    const matches: RankingMatch[] = [];
    for (const group of batches(keywords, 700)) {
      let offset = 0;
      while (true) {
        const items = await this.liveItems(
          "/v3/dataforseo_labs/google/ranked_keywords/live",
          {
            filters: ["keyword_data.keyword", "in", group],
            historical_serp_mode: "live",
            ignore_synonyms: true,
            item_types: ["organic"],
            language_code: languageCode(language),
            limit: 1_000,
            load_rank_absolute: false,
            ...locationTarget(country),
            offset,
            target: cleanDomain(domain),
          },
        );
        for (const item of items) {
          const keyword = stringOrNull(record(item.keyword_data).keyword);
          const serp = record(record(item.ranked_serp_element).serp_item);
          const url =
            stringOrNull(serp.relative_url) ?? stringOrNull(serp.url);
          const rank =
            numberOrNull(serp.rank_group) ??
            numberOrNull(serp.rank_absolute);
          if (keyword && url && rank !== null) {
            matches.push({ keyword, rank: Math.round(rank), url });
          }
        }
        if (items.length < 1_000) break;
        offset += items.length;
      }
    }
    return matches;
  }

  async submitSerpTasks(
    items: readonly { itemKey: string; keyword: string }[],
    country: string | null,
    language: string | null,
  ): Promise<SerpTask[]> {
    const submitted: SerpTask[] = [];
    for (const group of batches(items, 100)) {
      const byTag = new Map(
        group.map((item) => [providerTag(item.itemKey), item]),
      );
      const response = await this.http.json(
        "https://api.dataforseo.com/v3/serp/google/organic/task_post",
        {
          body: JSON.stringify(
            group.map((item) => ({
              depth: 10,
              keyword: item.keyword,
              language_code: languageCode(language),
              ...locationTarget(country),
              tag: providerTag(item.itemKey),
            })),
          ),
          method: "POST",
        },
      );
      for (const task of records(response.tasks)) {
        const status = numberOrNull(task.status_code);
        const statusMessage = stringOrNull(task.status_message);
        const id = stringOrNull(task.id);
        const tag = stringOrNull(record(task.data).tag);
        if (!status || status < 20000 || status >= 30000) {
          throw new Error(
            `DataForSEO SERP task submission failed (${status ?? "unknown"}): ${statusMessage ?? "unknown task failure"}.`,
          );
        }
        if (!id) throw new Error("DataForSEO SERP response omitted the task ID.");
        if (!tag) throw new Error("DataForSEO SERP response omitted the task tag.");
        const item = byTag.get(tag);
        if (!item) throw new Error("DataForSEO SERP response returned an unknown task tag.");
        submitted.push({
          itemKey: item.itemKey,
          keyword: item.keyword,
          providerTaskId: id,
        });
      }
      if (submitted.length < items.indexOf(group[0]!) + group.length) {
        throw new Error("DataForSEO did not acknowledge every SERP task.");
      }
    }
    return submitted;
  }

  async readySerpTaskIds(): Promise<Set<string>> {
    const response = await this.http.json(
      "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready",
    );
    const ready = new Set<string>();
    for (const task of records(response.tasks)) {
      for (const item of records(task.result)) {
        const id = stringOrNull(item.id);
        if (id) ready.add(id);
      }
    }
    return ready;
  }

  async serpTaskResult(providerTaskId: string): Promise<SerpSnapshot> {
    const items = dataForSeoItems(
      await this.http.json(
        `https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(providerTaskId)}`,
      ),
    );
    const results = items
      .filter((item) => item.type === "organic")
      .map((item) => {
        const rank = numberOrNull(item.rank_absolute);
        const url = stringOrNull(item.url);
        const domain =
          stringOrNull(item.domain) ?? (url ? cleanDomain(url) : null);
        return rank && rank <= 100 && url && domain
          ? {
              domain,
              rankAbsolute: Math.round(rank),
              url,
            }
          : null;
      })
      .filter((item): item is SerpResult => item !== null);
    const features = [
      ...new Set(
        items
          .map((item) => stringOrNull(item.type))
          .filter(
            (type): type is string =>
              type !== null && type !== "organic",
          )
          .map((type) => type.toLowerCase().replace(/[\s-]+/g, "_")),
      ),
    ];
    return { features, results };
  }
}

export class AhrefsClient {
  private readonly http: ProviderHttpClient;

  constructor(apiKey: string, fetchImplementation: typeof fetch = fetch) {
    if (!apiKey.trim()) throw new Error("Ahrefs API key is required.");
    this.http = new ProviderHttpClient(`Bearer ${apiKey}`, fetchImplementation);
  }

  async metrics(
    targets: readonly { mode: "domain" | "exact"; url: string }[],
  ): Promise<Map<string, AuthorityMetrics>> {
    const output = new Map<string, AuthorityMetrics>();
    for (const group of batches(targets, 100)) {
      const response = await this.http.json(
        "https://api.ahrefs.com/v3/batch-analysis/batch-analysis",
        {
          body: JSON.stringify({
            output: "json",
            select: [
              "url",
              "url_rating",
              "domain_rating",
              "ahrefs_rank",
              "refdomains",
              "backlinks",
            ],
            targets: group.map((target) => ({
              mode: target.mode,
              protocol: "both",
              url: target.url,
            })),
          }),
          method: "POST",
        },
      );
      const rows = records(response.targets);
      group.forEach((target, index) => {
        const row =
          rows.find((candidate) => candidate.url === target.url) ??
          rows[index] ??
          {};
        output.set(target.url, {
          ahrefsRank: numberOrNull(row.ahrefs_rank),
          backlinks: numberOrNull(row.backlinks),
          domainRating: numberOrNull(row.domain_rating),
          referringDomains: numberOrNull(
            row.refdomains ?? row.referring_domains,
          ),
          urlRating: numberOrNull(row.url_rating),
        });
      });
    }
    return output;
  }
}

export class AnthropicSiteArchitectureClient {
  private readonly http: ProviderHttpClient;

  constructor(apiKey: string, fetchImplementation: typeof fetch = fetch) {
    if (!apiKey.trim()) throw new Error("Anthropic API key is required.");
    this.http = new ProviderHttpClient(apiKey, async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      headers.set("x-api-key", apiKey);
      headers.set("anthropic-version", "2023-06-01");
      return fetchImplementation(input, { ...init, headers });
    });
  }

  async score(
    rows: readonly { keyword: string; rankingUrl: string }[],
  ): Promise<Map<string, Omit<SiteArchitectureResult, "keyword" | "matchedUrl">>> {
    const output = new Map<
      string,
      Omit<SiteArchitectureResult, "keyword" | "matchedUrl">
    >();
    for (const group of batches(rows, 40)) {
      const response = await this.http.json(
        "https://api.anthropic.com/v1/messages",
        {
          body: JSON.stringify({
            max_tokens: 4_000,
            messages: [
              {
                content: JSON.stringify(
                  group.map((row, index) => ({ index, ...row })),
                ),
                role: "user",
              },
            ],
            model: "claude-sonnet-4-6",
            system:
              "Return only a JSON array. For each input index return index, relevancyScore from 0 to 100, contentStatus as green/amber/red, and tacticalStatus as no_action_needed/optimise_content/create_content/new_content.",
          }),
          method: "POST",
        },
      );
      const text = records(response.content)
        .map((content) => stringOrNull(content.text))
        .filter((value): value is string => value !== null)
        .join("\n")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      const parsed: unknown = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return [];
        }
      })();
      for (const value of records(parsed)) {
        const index = numberOrNull(value.index);
        const score = numberOrNull(value.relevancyScore);
        const contentStatus = stringOrNull(value.contentStatus);
        const tacticalStatus = stringOrNull(value.tacticalStatus);
        const row = index === null ? null : group[Math.round(index)];
        if (
          !row ||
          score === null ||
          score > 100 ||
          !["amber", "green", "red"].includes(contentStatus ?? "") ||
          ![
            "create_content",
            "green",
            "new_content",
            "no_action_needed",
            "optimise_content",
          ].includes(tacticalStatus ?? "")
        ) {
          continue;
        }
        output.set(normaliseKeyword(row.keyword), {
          contentStatus: contentStatus as "amber" | "green" | "red",
          relevancyScore: score,
          tacticalStatus: tacticalStatus as SiteArchitectureResult["tacticalStatus"],
        });
      }
    }
    return output;
  }
}

export interface PipelineProviderHydrator {
  hydrate(
    pool: DatabasePool,
    projectId: string,
    runId: string,
    stageId: PipelineStageId,
  ): Promise<void>;
}

export const KEYWORD_ENRICHMENT_BATCH_SIZE = 200;
export const KEYWORD_HYDRATION_BUDGET_MS = 720_000;

export class LivePipelineProviderHydrator implements PipelineProviderHydrator {
  constructor(
    private readonly dataForSeo: DataForSeoClient,
    private readonly ahrefs: AhrefsClient,
    private readonly siteArchitecture: AnthropicSiteArchitectureClient,
    private readonly wait: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => number = Date.now,
    private readonly serpWaitMilliseconds = 780_000,
    private readonly keywordHydrationBudgetMs = KEYWORD_HYDRATION_BUDGET_MS,
    private readonly keywordEnrichmentBatchSize = KEYWORD_ENRICHMENT_BATCH_SIZE,
  ) {}

  async hydrate(
    pool: DatabasePool,
    projectId: string,
    runId: string,
    stageId: PipelineStageId,
  ): Promise<void> {
    const runResult = await pool.query<{ mode: string | null }>(
      `SELECT input->>'mode' AS mode FROM pipeline_runs WHERE id = $1`,
      [runId],
    );
    if (runResult.rows[0]?.mode === "recalculate") return;
    switch (stageId) {
      case "preflight":
        await this.hydrateAuthority(pool, projectId);
        return;
      case "keyword-enrichment":
        await this.hydrateKeywordMetrics(pool, projectId);
        return;
      case "ranking-url":
        await this.hydrateRankingUrls(pool, projectId);
        return;
      case "serp-collection":
        await this.hydrateSerps(pool, projectId, runId);
        return;
      case "authority":
        await this.hydrateAuthority(pool, projectId);
        return;
      case "backlinks":
        await this.hydrateBacklinks(pool, projectId);
        return;
      case "site-architecture":
        await this.hydrateSiteArchitecture(pool, projectId);
        return;
      default:
        return;
    }
  }

  private async project(
    pool: DatabasePool,
    projectId: string,
  ): Promise<ProjectProviderRow> {
    const result = await pool.query<ProjectProviderRow>(
      `
        SELECT project.country, project.language, client.domain
        FROM navigator_projects AS project
        JOIN clients AS client ON client.id = project.client_id
        WHERE project.id = $1
          AND project.archived_at IS NULL
          AND client.archived_at IS NULL
      `,
      [projectId],
    );
    const project = result.rows[0];
    if (!project) throw new Error(`Project ${projectId} is unavailable.`);
    return project;
  }

  private async keywords(
    pool: DatabasePool,
    projectId: string,
  ): Promise<KeywordProviderRow[]> {
    const result = await pool.query<KeywordProviderRow>(
      `
        SELECT
          keyword.id,
          keyword.keyword,
          keyword.normalised_keyword,
          keyword.avg_monthly_volume,
          keyword.ranking_url,
          keyword.ranking_lookup_checked_at,
          provider.fetched_at AS provider_fetched_at
        FROM keywords AS keyword
        LEFT JOIN local_provider_keyword_inputs AS provider
          ON provider.project_id = keyword.project_id
         AND provider.normalised_keyword = keyword.normalised_keyword
        WHERE keyword.project_id = $1
          AND keyword.detox_status = 'keep'
        ORDER BY keyword.normalised_keyword
      `,
      [projectId],
    );
    return result.rows;
  }

  private async hydrateKeywordMetrics(
    pool: DatabasePool,
    projectId: string,
  ): Promise<void> {
    const [project, keywords] = await Promise.all([
      this.project(pool, projectId),
      this.keywords(pool, projectId),
    ]);
    const staleBefore = this.now() - 30 * 24 * 60 * 60 * 1_000;
    const requiresFetch = keywords.filter(
      (keyword) =>
        keyword.provider_fetched_at === null ||
        keyword.provider_fetched_at.getTime() < staleBefore,
    );
    if (requiresFetch.length === 0) return;
    const deadline = this.now() + this.keywordHydrationBudgetMs;
    const groups = batches(requiresFetch, this.keywordEnrichmentBatchSize);
    let remaining = requiresFetch.length;
    for (const group of groups) {
      if (this.now() >= deadline) {
        throw new HttpError(
          503,
          "provider_hydration_incomplete",
          `Keyword enrichment paused after persisting progress. ${remaining} keywords remaining.`,
        );
      }
      const values = await this.dataForSeo.enrichKeywords(
        group.map((keyword) => keyword.keyword),
        project.country,
        project.language,
      );
      await this.persistEnrichedKeywords(pool, projectId, values);
      remaining -= group.length;
    }
  }

  private async persistEnrichedKeywords(
    pool: DatabasePool,
    projectId: string,
    values: readonly EnrichedKeyword[],
  ): Promise<void> {
    if (values.length === 0) return;
    await withTransaction(pool, async (client) => {
      for (const value of values) {
        const key = normaliseKeyword(value.keyword);
        await client.query(
          `
            INSERT INTO local_provider_keyword_inputs (
              project_id,
              normalised_keyword,
              keyword,
              avg_monthly_volume,
              core_keyword,
              core_keyword_source,
              keyword_difficulty,
              search_intent,
              fetched_at
            )
            VALUES ($1, $2, $3, $4, $5, 'dataforseo', $6, $7, now())
            ON CONFLICT (project_id, normalised_keyword)
            DO UPDATE SET
              keyword = EXCLUDED.keyword,
              avg_monthly_volume = EXCLUDED.avg_monthly_volume,
              core_keyword = EXCLUDED.core_keyword,
              core_keyword_source = EXCLUDED.core_keyword_source,
              keyword_difficulty = EXCLUDED.keyword_difficulty,
              search_intent = EXCLUDED.search_intent,
              fetched_at = EXCLUDED.fetched_at
          `,
          [
            projectId,
            key,
            value.keyword,
            value.avgMonthlyVolume,
            value.coreKeyword,
            value.keywordDifficulty,
            value.intent,
          ],
        );
        for (const point of value.monthlyVolumes) {
          await client.query(
            `
              INSERT INTO local_provider_keyword_monthly_volumes (
                project_id,
                normalised_keyword,
                month,
                volume
              )
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (project_id, normalised_keyword, month)
              DO UPDATE SET volume = EXCLUDED.volume
            `,
            [projectId, key, point.month, point.volume],
          );
        }
      }
    });
  }

  private async hydrateRankingUrls(
    pool: DatabasePool,
    projectId: string,
  ): Promise<void> {
    const [project, keywords] = await Promise.all([
      this.project(pool, projectId),
      this.keywords(pool, projectId),
    ]);
    const staleBefore = Date.now() - 7 * 24 * 60 * 60 * 1_000;
    const requiresLookup = keywords.filter(
      (keyword) =>
        keyword.ranking_lookup_checked_at === null ||
        keyword.ranking_lookup_checked_at.getTime() < staleBefore,
    );
    if (requiresLookup.length === 0) return;
    const matches = await this.dataForSeo.rankingUrls(
      project.domain,
      requiresLookup.map((keyword) => keyword.keyword),
      project.country,
      project.language,
    );
    const byKeyword = new Map(
      matches.map((match) => [normaliseKeyword(match.keyword), match]),
    );
    await withTransaction(pool, async (client) => {
      for (const keyword of requiresLookup) {
        const match = byKeyword.get(keyword.normalised_keyword);
        await client.query(
          `
            INSERT INTO local_provider_keyword_inputs (
              project_id,
              normalised_keyword,
              keyword,
              ranking_url,
              rank
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (project_id, normalised_keyword)
            DO UPDATE SET
              keyword = EXCLUDED.keyword,
              ranking_url = EXCLUDED.ranking_url,
              rank = EXCLUDED.rank
          `,
          [
            projectId,
            keyword.normalised_keyword,
            keyword.keyword,
            match?.url ?? null,
            match?.rank ?? null,
          ],
        );
      }
    });
  }

  private async hydrateSerps(
    pool: DatabasePool,
    projectId: string,
    runId: string,
  ): Promise<void> {
    const [project, keywordResult] = await Promise.all([
      this.project(pool, projectId),
      pool.query<KeywordProviderRow>(
        `
          SELECT
            keyword.id,
            keyword.keyword,
            keyword.normalised_keyword,
            keyword.avg_monthly_volume,
            keyword.ranking_url,
            keyword.ranking_lookup_checked_at,
            provider.fetched_at AS provider_fetched_at
          FROM keyword_clusters AS cluster
          JOIN keywords AS keyword
            ON keyword.id = cluster.canonical_keyword_id
           AND keyword.project_id = cluster.project_id
          LEFT JOIN local_provider_serp_keywords AS provider
            ON provider.project_id = keyword.project_id
           AND provider.normalised_keyword = keyword.normalised_keyword
          WHERE cluster.pipeline_run_id = $1
            AND cluster.project_id = $2
            AND keyword.competitive_eligible IS DISTINCT FROM false
            AND (
              provider.fetched_at IS NULL
              OR provider.fetched_at < now() - interval '7 days'
            )
          ORDER BY keyword.normalised_keyword
        `,
        [runId, projectId],
      ),
    ]);
    const keywords = keywordResult.rows;
    if (keywords.length === 0) return;
    await pool.query(
      `
        INSERT INTO provider_work_items (
          pipeline_run_id,
          project_id,
          stage_id,
          item_key,
          provider
        )
        SELECT $1, $2, 'serp-collection', input.item_key, 'dataforseo'
        FROM jsonb_to_recordset($3::jsonb) AS input(item_key text)
        ON CONFLICT (pipeline_run_id, stage_id, item_key) DO NOTHING
      `,
      [
        runId,
        projectId,
        JSON.stringify(
          keywords.map((keyword) => ({
            item_key: keyword.normalised_keyword,
          })),
        ),
      ],
    );
    let work = await this.serpWork(pool, runId);
    const byKey = new Map(
      keywords.map((keyword) => [keyword.normalised_keyword, keyword]),
    );
    const unsubmitted = work
      .filter(
        (item) => item.state === "pending" && !item.provider_task_id,
      )
      .map((item) => ({
        itemKey: item.item_key,
        keyword: byKey.get(item.item_key)?.keyword ?? item.item_key,
      }));
    if (unsubmitted.length > 0) {
      const submitted = await this.dataForSeo.submitSerpTasks(
        unsubmitted,
        project.country,
        project.language,
      );
      await withTransaction(pool, async (client) => {
        for (const task of submitted) {
          await client.query(
            `
              UPDATE provider_work_items
              SET
                provider_task_id = $4,
                state = 'submitted',
                attempt_count = attempt_count + 1,
                submitted_at = now(),
                updated_at = now()
              WHERE pipeline_run_id = $1
                AND stage_id = 'serp-collection'
                AND item_key = $2
                AND project_id = $3
            `,
            [runId, task.itemKey, projectId, task.providerTaskId],
          );
        }
      });
    }
    const deadline = this.now() + this.serpWaitMilliseconds;
    while (this.now() < deadline) {
      work = await this.serpWork(pool, runId);
      const remaining = work.filter((item) => item.state !== "succeeded");
      if (remaining.length === 0) return;
      if (remaining.some((item) => item.state === "failed")) {
        throw new Error("A DataForSEO SERP work item failed.");
      }
      const ready = await this.dataForSeo.readySerpTaskIds();
      const readyItems = remaining.filter(
        (item) =>
          item.provider_task_id && ready.has(item.provider_task_id),
      );
      await concurrently(readyItems, 10, async (item) => {
        const snapshot = await this.dataForSeo.serpTaskResult(
          item.provider_task_id!,
        );
        const keyword = byKey.get(item.item_key);
        if (!keyword) throw new Error("SERP work item lost its keyword.");
        await this.persistSerp(
          pool,
          projectId,
          runId,
          keyword,
          snapshot,
        );
      });
      if (readyItems.length === 0) await this.wait(3_000);
    }
    throw new Error("DataForSEO SERP tasks are still pending.");
  }

  private async serpWork(
    pool: DatabasePool,
    runId: string,
  ): Promise<ProviderWorkItemRow[]> {
    const result = await pool.query<ProviderWorkItemRow>(
      `
        SELECT item_key, provider_task_id, state
        FROM provider_work_items
        WHERE pipeline_run_id = $1
          AND stage_id = 'serp-collection'
        ORDER BY item_key
      `,
      [runId],
    );
    return result.rows;
  }

  private async persistSerp(
    pool: DatabasePool,
    projectId: string,
    runId: string,
    keyword: KeywordProviderRow,
    snapshot: SerpSnapshot,
  ): Promise<void> {
    await withTransaction(pool, async (client) => {
      await client.query(
        `
          INSERT INTO local_provider_serp_keywords (
            project_id,
            normalised_keyword,
            keyword,
            source_keyword_id,
            fetched_at
          )
          VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (project_id, normalised_keyword)
          DO UPDATE SET
            keyword = EXCLUDED.keyword,
            source_keyword_id = EXCLUDED.source_keyword_id,
            fetched_at = EXCLUDED.fetched_at
        `,
        [projectId, keyword.normalised_keyword, keyword.keyword, keyword.id],
      );
      await client.query(
        `
          DELETE FROM local_provider_serp_results
          WHERE project_id = $1
            AND normalised_keyword = $2
        `,
        [projectId, keyword.normalised_keyword],
      );
      for (const result of snapshot.results) {
        await client.query(
          `
            INSERT INTO local_provider_serp_results (
              project_id,
              normalised_keyword,
              rank_absolute,
              url,
              domain
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            projectId,
            keyword.normalised_keyword,
            result.rankAbsolute,
            result.url,
            result.domain,
          ],
        );
      }
      await client.query(
        `
          DELETE FROM project_serp_features
          WHERE project_id = $1
            AND keyword_id = $2
            AND source = 'dataforseo'
        `,
        [projectId, keyword.id],
      );
      for (const feature of snapshot.features) {
        await client.query(
          `
            INSERT INTO project_serp_features (
              project_id,
              keyword_id,
              device,
              feature_raw,
              result_type,
              source
            )
            VALUES ($1, $2, 'mobile', $3, $3, 'dataforseo')
            ON CONFLICT DO NOTHING
          `,
          [projectId, keyword.id, feature],
        );
      }
      await client.query(
        `
          UPDATE provider_work_items
          SET
            state = 'succeeded',
            completed_at = now(),
            updated_at = now(),
            last_error = NULL
          WHERE pipeline_run_id = $1
            AND stage_id = 'serp-collection'
            AND item_key = $2
        `,
        [runId, keyword.normalised_keyword],
      );
    });
  }

  private async hydrateAuthority(
    pool: DatabasePool,
    projectId: string,
  ): Promise<void> {
    const current = await pool.query<{
      backlinks: string;
      domain_rating: string;
      referring_domains: number;
    }>(
      `
        SELECT
          authority_domain_rating::text AS domain_rating,
          authority_referring_domains AS referring_domains,
          authority_backlinks::text AS backlinks
        FROM navigator_projects
        WHERE id = $1
      `,
      [projectId],
    );
    const stored = current.rows[0];
    if (
      stored &&
      (Number(stored.domain_rating) > 0 ||
        stored.referring_domains > 0 ||
        Number(stored.backlinks) > 0)
    ) {
      return;
    }
    const project = await this.project(pool, projectId);
    const domain = cleanDomain(project.domain);
    const cached = await pool.query<
      AuthorityMetrics & { fetched_at: Date }
    >(
      `
        SELECT
          domain_rating AS "domainRating",
          ahrefs_rank AS "ahrefsRank",
          referring_domains AS "referringDomains",
          backlinks,
          NULL::numeric AS "urlRating",
          fetched_at
        FROM authority_domain_cache
        WHERE domain = $1
          AND fetched_at >= now() - interval '30 days'
      `,
      [domain],
    );
    const cachedValue = cached.rows[0];
    if (cachedValue) {
      await pool.query(
        `
          UPDATE navigator_projects
          SET authority_domain_rating = COALESCE($2, authority_domain_rating),
              authority_referring_domains = COALESCE($3, authority_referring_domains),
              authority_backlinks = COALESCE($4, authority_backlinks),
              updated_at = now()
          WHERE id = $1
        `,
        [
          projectId,
          cachedValue.domainRating,
          cachedValue.referringDomains,
          cachedValue.backlinks,
        ],
      );
      return;
    }
    const metrics = await this.ahrefs.metrics([
      { mode: "domain", url: domain },
    ]);
    const value = metrics.get(domain);
    if (!value) throw new Error("Ahrefs returned no client-domain record.");
    await pool.query(
      `
        UPDATE navigator_projects
        SET
          authority_domain_rating = COALESCE($2, authority_domain_rating),
          authority_referring_domains = COALESCE($3, authority_referring_domains),
          authority_backlinks = COALESCE($4, authority_backlinks),
          updated_at = now()
        WHERE id = $1
      `,
      [
        projectId,
        value.domainRating,
        value.referringDomains,
        value.backlinks,
      ],
    );
    await pool.query(
      `
        INSERT INTO authority_domain_cache (
          domain,
          domain_rating,
          ahrefs_rank,
          referring_domains,
          backlinks,
          metric_source,
          fetched_at
        )
        VALUES ($1, $2, $3, $4, $5, 'ahrefs', now())
        ON CONFLICT (domain)
        DO UPDATE SET
          domain_rating = EXCLUDED.domain_rating,
          ahrefs_rank = EXCLUDED.ahrefs_rank,
          referring_domains = EXCLUDED.referring_domains,
          backlinks = EXCLUDED.backlinks,
          metric_source = EXCLUDED.metric_source,
          fetched_at = EXCLUDED.fetched_at,
          updated_at = now()
      `,
      [
        domain,
        value.domainRating,
        value.ahrefsRank,
        value.referringDomains,
        value.backlinks,
      ],
    );
  }

  private async hydrateBacklinks(
    pool: DatabasePool,
    projectId: string,
  ): Promise<void> {
    const result = await pool.query<{ url: string }>(
      `
        SELECT DISTINCT url
        FROM local_provider_serp_results
        WHERE project_id = $1
        ORDER BY url
      `,
      [projectId],
    );
    const cached = await pool.query<
      AuthorityMetrics & { url: string }
    >(
      `
        SELECT
          url,
          url_rating AS "urlRating",
          domain_rating AS "domainRating",
          ahrefs_rank AS "ahrefsRank",
          referring_domains AS "referringDomains",
          backlinks
        FROM authority_url_cache
        WHERE url = ANY($1::text[])
          AND fetched_at >= now() - interval '30 days'
      `,
      [result.rows.map((row) => row.url)],
    );
    const metrics = new Map<string, AuthorityMetrics>(
      cached.rows.map((row) => [row.url, row]),
    );
    const missingUrls = result.rows
      .map((row) => row.url)
      .filter((url) => !metrics.has(url));
    if (missingUrls.length > 0) {
      const fetched = await this.ahrefs.metrics(
        missingUrls.map((url) => ({ mode: "exact" as const, url })),
      );
      for (const [url, value] of fetched) metrics.set(url, value);
    }
    await withTransaction(pool, async (client) => {
      for (const [url, value] of metrics) {
        await client.query(
          `
            INSERT INTO authority_url_cache (
              url,
              domain,
              url_rating,
              domain_rating,
              ahrefs_rank,
              referring_domains,
              backlinks,
              metric_source,
              fetched_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'ahrefs', now())
            ON CONFLICT (url)
            DO UPDATE SET
              domain = EXCLUDED.domain,
              url_rating = EXCLUDED.url_rating,
              domain_rating = EXCLUDED.domain_rating,
              ahrefs_rank = EXCLUDED.ahrefs_rank,
              referring_domains = EXCLUDED.referring_domains,
              backlinks = EXCLUDED.backlinks,
              metric_source = EXCLUDED.metric_source,
              fetched_at = EXCLUDED.fetched_at,
              updated_at = now()
          `,
          [
            url,
            cleanDomain(url),
            value.urlRating,
            value.domainRating,
            value.ahrefsRank,
            value.referringDomains,
            value.backlinks,
          ],
        );
        await client.query(
          `
            UPDATE local_provider_serp_results
            SET
              url_rating = $3,
              domain_rating = $4,
              ahrefs_rank = $5,
              referring_domains = $6,
              backlinks = $7
            WHERE project_id = $1
              AND url = $2
          `,
          [
            projectId,
            url,
            value.urlRating,
            value.domainRating,
            value.ahrefsRank,
            value.referringDomains,
            value.backlinks,
          ],
        );
      }
    });
  }

  private async hydrateSiteArchitecture(
    pool: DatabasePool,
    projectId: string,
  ): Promise<void> {
    const keywords = await this.keywords(pool, projectId);
    const requiresScoring = keywords.filter(
      (
        keyword,
      ): keyword is KeywordProviderRow & {
        ranking_url: string;
      } => Boolean(keyword.ranking_url),
    );
    if (requiresScoring.length === 0) {
      await pool.query(
        `DELETE FROM local_provider_site_architecture_inputs WHERE project_id = $1`,
        [projectId],
      );
      return;
    }
    const scores = await this.siteArchitecture.score(
      requiresScoring.map((keyword) => ({
        keyword: keyword.keyword,
        rankingUrl: keyword.ranking_url,
      })),
    );
    const values: SiteArchitectureResult[] = requiresScoring.map((keyword) => {
      const score = scores.get(keyword.normalised_keyword);
      if (!score) {
        throw new Error(
          `Content-fit scoring returned no result for ${keyword.normalised_keyword}.`,
        );
      }
      return {
        contentStatus: score.contentStatus,
        keyword: keyword.keyword,
        matchedUrl: keyword.ranking_url,
        relevancyScore: score.relevancyScore,
        tacticalStatus: score.tacticalStatus,
      };
    });
    await withTransaction(pool, async (client) => {
      await client.query(
        `
          DELETE FROM local_provider_site_architecture_inputs AS input
          USING keywords AS keyword
          WHERE input.project_id = $1
            AND keyword.project_id = $1
            AND keyword.normalised_keyword = input.normalised_keyword
            AND keyword.ranking_url IS NULL
        `,
        [projectId],
      );
      for (const value of values) {
        await client.query(
          `
            INSERT INTO local_provider_site_architecture_inputs (
              project_id,
              normalised_keyword,
              keyword,
              matched_url,
              relevancy_score,
              content_status,
              tactical_status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (project_id, normalised_keyword)
            DO UPDATE SET
              keyword = EXCLUDED.keyword,
              matched_url = EXCLUDED.matched_url,
              relevancy_score = EXCLUDED.relevancy_score,
              content_status = EXCLUDED.content_status,
              tactical_status = EXCLUDED.tactical_status
          `,
          [
            projectId,
            normaliseKeyword(value.keyword),
            value.keyword,
            value.matchedUrl,
            value.relevancyScore,
            value.contentStatus,
            value.tacticalStatus,
          ],
        );
      }
    });
  }
}
