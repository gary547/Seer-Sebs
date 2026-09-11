import { createHash } from "node:crypto";

import { normaliseKeyword } from "../../../packages/fixtures/src/representative-project.js";
import type { ProjectPipelineSource } from "../../../packages/fixtures/src/representative-project.js";
import { decideTier, type DataDrivenStageData } from "../../../packages/pipeline/src/stage-handlers.js";
import type { PipelineStageId } from "../../../packages/pipeline/src/definition.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import { INTENT_CLASSIFICATION_VERSION, OpenRouterPipelineClient, OPENROUTER_MODEL, type AiOptions } from "./openrouter.js";
import { classificationCache } from "./classification-cache.js";
import { PIPELINE_AI_MODEL_LABEL } from "../../../packages/pipeline/src/ai-model.js";
import { StageContinuation, STAGE_EXECUTION_BUDGET_MS } from "./stage-continuation.js";

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
  source?: string;
  scope?: "domain" | "page" | "domain_fallback";
}

interface AuthorityCheckpoint {
  checkBudget?: (milliseconds: number) => void;
  domains?: Map<string, AuthorityMetrics>;
  saveDomain?: (domain: string, metrics: AuthorityMetrics) => Promise<void>;
  savePages?: (metrics: ReadonlyMap<string, AuthorityMetrics>) => Promise<void>;
}

interface SiteArchitectureResult {
  model: string;
  contentStatus: "amber" | "green" | "red";
  keyword: string;
  matchedUrl: string | null;
  relevancyScore: number;
  inputScope?: "page" | "domain_fallback";
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
  return /^[a-z0-9\s\-'&.]+$/i.test(trimmed);
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

function isProviderRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /40202/.test(message) || /rates? limit per minute/i.test(message);
}

function rejectedKeywordFromError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(
    /Invalid Field: 'keywords'\.[^']*'([^']+)'/i,
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
    private readonly wait: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async json(
    url: string,
    init: Omit<RequestInit, "headers"> & {
      headers?: Record<string, string>;
    } = {},
    validate?: (payload: Record<string, unknown>) => void,
    checkBudget?: (milliseconds: number) => void,
  ): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      checkBudget?.(120_000);
      let retryAfterMilliseconds: number | null = null;
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
          const retryAfter = Number(response.headers.get("retry-after"));
          retryAfterMilliseconds =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1_000
              : null;
          throw new ProviderResponseError(response.status);
        }
        const payload = record(await response.json());
        validate?.(payload);
        return payload;
      } catch (error) {
        lastError = error;
        if (
          (error instanceof ProviderResponseError || error instanceof DataForSeoTaskError) &&
          !error.retryable
        ) throw error;
      }
      if (attempt < 5) {
        const delay = retryAfterMilliseconds ?? 250 * 2 ** (attempt - 1);
        checkBudget?.(delay + 120_000);
        await this.wait(delay);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Provider API request failed after five attempts.");
  }
}

class ProviderResponseError extends Error {
  readonly retryable: boolean;

  constructor(readonly statusCode: number) {
    super("Provider API request was rejected.");
    this.name = "ProviderResponseError";
    this.retryable = statusCode === 429 || statusCode >= 500;
  }
}

class DataForSeoTaskError extends Error {
  readonly retryable: boolean;

  constructor(readonly statusCode: number) {
    super("DataForSEO did not complete the requested task.");
    this.retryable = statusCode >= 50000 || [40202, 40209].includes(statusCode);
  }
}

function backlinksFailure(error: unknown): HttpError {
  const statusCode =
    error instanceof ProviderResponseError || error instanceof DataForSeoTaskError
      ? error.statusCode : null;
  console.warn(JSON.stringify({
    event: "provider_request_failed",
    provider: "dataforseo_backlinks",
    statusCode,
  }));
  if ([401, 403, 40100, 40104, 40201, 40204, 40207, 40208].includes(statusCode ?? 0)) {
    return new HttpError(
      424,
      "dataforseo_backlinks_access_rejected",
      "DataForSEO Backlinks access was rejected. Check API credentials, the Backlinks subscription and IP access settings.",
    );
  }
  if ([402, 40200, 40203, 40205, 40206, 40210].includes(statusCode ?? 0)) {
    return new HttpError(
      424,
      "dataforseo_backlinks_usage_exhausted",
      "DataForSEO Backlinks usage is unavailable. Check account balance and API usage limits.",
    );
  }
  if ([429, 40202, 40209].includes(statusCode ?? 0)) {
    return new HttpError(
      424,
      "dataforseo_backlinks_rate_limited",
      "DataForSEO Backlinks rate limiting did not clear after five attempts.",
    );
  }
  if (statusCode !== null && ((statusCode >= 500 && statusCode < 600) || statusCode >= 50000)) {
    return new HttpError(
      424,
      "dataforseo_backlinks_unavailable",
      "DataForSEO Backlinks remained unavailable after five attempts.",
    );
  }
  return new HttpError(
    424,
    "dataforseo_backlinks_request_failed",
    "DataForSEO did not return usable backlink metrics. Check the affected target and provider availability.",
  );
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
      { method: "GET" },
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

  async serpTaskSnapshot(
    providerTaskId: string,
  ): Promise<SerpSnapshot | "pending"> {
    const raw = await this.http.json(
      `https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(providerTaskId)}`,
    );
    const task = records(raw.tasks)[0];
    const code = numberOrNull(task?.status_code);
    if (code === 40601 || code === 40602) return "pending";
    const items = dataForSeoItems(raw);
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

  async serpTaskResult(providerTaskId: string): Promise<SerpSnapshot> {
    const snapshot = await this.serpTaskSnapshot(providerTaskId);
    if (snapshot === "pending") {
      throw new Error("DataForSEO SERP task is still pending.");
    }
    return snapshot;
  }
}

export class DataForSeoAuthorityClient {
  private readonly http: ProviderHttpClient;

  constructor(
    credentials: string,
    fetchImplementation: typeof fetch = fetch,
    wait?: (milliseconds: number) => Promise<void>,
  ) {
    if (!credentials.trim()) throw new Error("DataForSEO credentials are required.");
    const value = credentials.trim();
    this.http = new ProviderHttpClient(
      `Basic ${value.includes(":") ? Buffer.from(value).toString("base64") : value}`,
      fetchImplementation,
      wait,
    );
  }

  private async request(path: string, task: Record<string, unknown>, checkpoint: AuthorityCheckpoint): Promise<Record<string, unknown>[]> {
    const response = await this.http.json(`https://api.dataforseo.com/v3/backlinks/${path}/live`, {
      method: "POST",
      body: JSON.stringify([{ ...task, rank_scale: "one_hundred" }]),
    }, (payload) => {
      const code = numberOrNull(payload.status_code);
      if (code !== 20000) throw new DataForSeoTaskError(code ?? 50000);
      const tasks = records(payload.tasks);
      if (tasks.length !== 1) throw new DataForSeoTaskError(50000);
      const taskCode = numberOrNull(tasks[0]?.status_code);
      if (taskCode !== 20000) throw new DataForSeoTaskError(taskCode ?? 50000);
    }, checkpoint.checkBudget);
    const results = records(records(response.tasks)[0]?.result);
    return path === "summary" ? results : records(results[0]?.items);
  }

  private parse(row: Record<string, unknown>, scope: "domain" | "page"): AuthorityMetrics {
    const rank = numberOrNull(row.rank);
    const domainRank = numberOrNull(scope === "domain" ? row.rank : row.main_domain_rank);
    if ((rank !== null && rank > 100) || (domainRank !== null && domainRank > 100)) {
      throw new Error("DataForSEO returned authority outside the requested 0–100 scale.");
    }
    return {
      ahrefsRank: null,
      backlinks: numberOrNull(row.backlinks),
      domainRating: domainRank,
      referringDomains: numberOrNull(row.referring_domains),
      urlRating: scope === "page" ? rank : null,
      source: "dataforseo",
      scope,
    };
  }

  async metrics(
    targets: readonly { mode: "domain" | "exact"; url: string }[],
    checkpoint: AuthorityCheckpoint = {},
  ): Promise<Map<string, AuthorityMetrics>> {
    const output = new Map<string, AuthorityMetrics>();
    const pending = new Map<string, AuthorityMetrics>();
    let checkpointFailure: unknown;
    const savePages = async () => {
      if (pending.size === 0) return;
      try {
        await checkpoint.savePages?.(pending);
      } catch (error) {
        checkpointFailure = error;
        throw error;
      }
      pending.clear();
    };
    try {
      const domains = checkpoint.domains ?? new Map<string, AuthorityMetrics>();
      const domainMetrics = async (domain: string) => {
        const cached = domains.get(domain);
        if (cached) return cached;
        const rows = await this.request("summary", { target: domain, include_subdomains: true }, checkpoint);
        const row = rows.find((item) => item.target === domain);
        if (!row) throw new Error("DataForSEO omitted the requested domain.");
        const value = this.parse(row, "domain");
        if ([value.domainRating, value.backlinks, value.referringDomains].some((item) => item === null)) {
          throw new Error("DataForSEO returned incomplete domain authority.");
        }
        try {
          await checkpoint.saveDomain?.(domain, value);
        } catch (error) {
          checkpointFailure = error;
          throw error;
        }
        domains.set(domain, value);
        return value;
      };
      for (const target of targets.filter((target) => target.mode === "domain")) {
        output.set(target.url, await domainMetrics(cleanDomain(target.url)));
      }
      const urls = [...new Set(targets.filter((target) => target.mode === "exact").map((target) => target.url))];
      for (const group of batches(urls, 100)) {
        const rows = await this.request("bulk_pages_summary", { targets: group }, checkpoint);
        for (const url of group) {
          const row = rows.find((item) => item.url === url);
          const value = this.parse(row ?? {}, "page");
          const incomplete = [value.urlRating, value.domainRating, value.backlinks, value.referringDomains].some((item) => item === null);
          if (incomplete) {
            const fallback = await domainMetrics(cleanDomain(url));
            value.urlRating ??= fallback.domainRating;
            value.domainRating ??= fallback.domainRating;
            value.backlinks ??= fallback.backlinks;
            value.referringDomains ??= fallback.referringDomains;
            value.scope = "domain_fallback";
          }
          output.set(url, value);
          pending.set(url, value);
        }
        await savePages();
      }
    } catch (error) {
      if (error === checkpointFailure) throw error;
      await savePages();
      if (error instanceof StageContinuation) throw error;
      throw backlinksFailure(error);
    }
    return output;
  }
}

export interface PipelineProviderHydrator {
  refineStage?(
    pool: DatabasePool,
    projectId: string,
    runId: string,
    source: ProjectPipelineSource,
    data: DataDrivenStageData,
    deadline?: number,
  ): Promise<DataDrivenStageData>;
  hydrate(
    pool: DatabasePool,
    projectId: string,
    runId: string,
    stageId: PipelineStageId,
    deadline?: number,
  ): Promise<void>;
}

export const KEYWORD_ENRICHMENT_BATCH_SIZE = 700;
export const KEYWORD_HYDRATION_BUDGET_MS = 1_700_000;
export const SERP_SUBMIT_CHUNK = 500;
export const SERP_RESULT_CONCURRENCY = 8;
export const SERP_HYDRATION_BUDGET_MS = 1_700_000;

export class LivePipelineProviderHydrator implements PipelineProviderHydrator {
  constructor(
    private readonly dataForSeo: DataForSeoClient,
    private readonly authorityProvider: DataForSeoAuthorityClient,
    private readonly ai: OpenRouterPipelineClient,
    private readonly wait: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => number = Date.now,
    private readonly serpWaitMilliseconds = 780_000,
    private readonly keywordHydrationBudgetMs = KEYWORD_HYDRATION_BUDGET_MS,
    private readonly keywordEnrichmentBatchSize = KEYWORD_ENRICHMENT_BATCH_SIZE,
    private readonly serpHydrationBudgetMs = SERP_HYDRATION_BUDGET_MS,
    private readonly serpSubmitChunk = SERP_SUBMIT_CHUNK,
  ) {}

  private aiOptions(pool: DatabasePool, projectId: string, runId: string, stageId: PipelineStageId, deadline?: number): AiOptions {
    let completedBatches: Promise<Map<string, unknown>> | undefined;
    return {
      deadline,
      cache: {
        startAttempt: async (key) => {
          const result = await pool.query<{ attempt_count: number }>(
            `INSERT INTO provider_work_items (pipeline_run_id, project_id, stage_id, item_key, provider, state, attempt_count)
             VALUES ($1, $2, $3, $4, 'openrouter', 'pending', 1)
             ON CONFLICT (pipeline_run_id, stage_id, item_key) DO UPDATE
             SET attempt_count = provider_work_items.attempt_count + 1, updated_at = now()
             RETURNING attempt_count`, [runId, projectId, stageId, key]);
          return result.rows[0]!.attempt_count;
        },
        get: async (key) => {
          completedBatches ??= pool.query<{ item_key: string; result: unknown }>(
            `SELECT result, item_key FROM provider_work_items
             WHERE pipeline_run_id = $1 AND stage_id = $2
               AND provider = 'openrouter' AND state = 'succeeded'`, [runId, stageId])
            .then((result) => new Map(result.rows.map((row) => [row.item_key, row.result])));
          return (await completedBatches).get(key);
        },
        set: async (key, output) => {
          await pool.query(
            `INSERT INTO provider_work_items (pipeline_run_id, project_id, stage_id, item_key, provider, state, result, completed_at)
             VALUES ($1, $2, $3, $4, 'openrouter', 'succeeded', $5::jsonb, now())
             ON CONFLICT (pipeline_run_id, stage_id, item_key) DO UPDATE
             SET state = 'succeeded', result = EXCLUDED.result, completed_at = now(), updated_at = now()`,
            [runId, projectId, stageId, key, JSON.stringify(output)]);
          (await completedBatches)?.set(key, output);
        },
      },
      progress: async (progress) => {
        const activity = progress.phase === "checkpointing" ? " Saved results; continuing automatically."
          : progress.phase === "failed" ? " Remaining batches could not finish; completed results are saved."
          : progress.phase === "completed" ? ""
          : ` Batch ${progress.batch}, attempt ${progress.attempt}/${progress.maxAttempts}${progress.phase === "retrying" ? "; retrying in 2s" : ""}.`;
        await pool.query(
          `UPDATE pipeline_stage_runs SET output = COALESCE(output, '{}'::jsonb) ||
             jsonb_build_object('message', $3::text, 'provider', 'openrouter', 'model', $4::text, 'providerProgress', $5::jsonb)
           WHERE run_id = $1 AND stage_id = $2 AND state = 'running'`,
          [runId, stageId, `${PIPELINE_AI_MODEL_LABEL}: ${progress.operation}, ${progress.completedBatches}/${progress.batchCount} batches complete, ${progress.activeBatches} in parallel.${activity}`, OPENROUTER_MODEL, JSON.stringify(progress)]);
      },
    };
  }

  async refineStage(pool: DatabasePool, projectId: string, runId: string, source: ProjectPipelineSource, data: DataDrivenStageData, deadline?: number): Promise<DataDrivenStageData> {
    const mode = await pool.query<{ mode: string }>(`SELECT input->>'mode' AS mode FROM pipeline_runs WHERE id = $1`, [runId]);
    if (mode.rows[0]?.mode === "recalculate") return data;
    if (data.handlerVersion === "detox-v1") {
      const candidates = data.keywords.filter((keyword) => keyword.detox.rule === "manual-review" || keyword.detox.rule === "category-relevance");
      const decisions = await this.ai.detox(candidates.map((keyword) => ({ keyword: keyword.text })), source, this.aiOptions(pool, projectId, runId, "detox", deadline));
      const keywords = data.keywords.map((keyword) => {
        const decision = decisions.get(keyword.normalisedText);
        return decision ? { ...keyword, detox: { ...decision, rule: `openrouter:${decision.model}` } } : keyword;
      });
      return { ...data, keywords,
        keptKeywordCount: keywords.filter((keyword) => keyword.detox.decision === "keep").length,
        removedKeywordCount: keywords.filter((keyword) => keyword.detox.decision === "remove").length,
        reviewKeywordCount: keywords.filter((keyword) => keyword.detox.decision === "review").length,
      };
    }
    if (data.handlerVersion === "categorisation-v1") {
      const candidates = data.keywords.filter((keyword) => !keyword.preCurated);
      const categories = await this.ai.categorise(candidates.map((keyword) => ({ keyword: keyword.text })), source, {
        ...this.aiOptions(pool, projectId, runId, "categorisation", deadline),
        classifications: classificationCache(pool, source.client.id),
      });
      const keywords = data.keywords.map((keyword) => {
        const category = categories.get(keyword.normalisedText);
        return category ? { ...keyword, categorisation: { ...category, source: "openrouter" as const, tier: decideTier(keyword.text, category.intent) } } : keyword;
      });
      return { ...data, keywords, classificationContract: INTENT_CLASSIFICATION_VERSION, summary: { ...data.summary,
        liveKeywordCount: keywords.filter((keyword) => keyword.categorisation.tier === "live").length,
        deferredKeywordCount: keywords.filter((keyword) => keyword.categorisation.tier === "deferred").length,
      } };
    }
    return data;
  }

  async hydrate(
    pool: DatabasePool,
    projectId: string,
    runId: string,
    stageId: PipelineStageId,
    deadline?: number,
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
        await this.hydrateBacklinks(pool, projectId, runId, deadline);
        return;
      case "site-architecture":
        await this.hydrateSiteArchitecture(pool, projectId, runId, deadline);
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
    for (const group of batches(keywords, 2_000)) {
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
            group.map((keyword) => ({
              item_key: keyword.normalised_keyword,
            })),
          ),
        ],
      );
    }
    const byKey = new Map(
      keywords.map((keyword) => [keyword.normalised_keyword, keyword]),
    );
    const deadline = this.now() + this.serpHydrationBudgetMs;
    while (this.now() < deadline) {
      const work = await this.serpWork(pool, runId);
      const remaining = work.filter((item) => item.state !== "succeeded");
      if (remaining.length === 0) return;
      if (remaining.some((item) => item.state === "failed")) {
        throw new Error("A DataForSEO SERP work item failed.");
      }
      const unsubmitted = remaining
        .filter((item) => item.state === "pending" && !item.provider_task_id)
        .map((item) => ({
          itemKey: item.item_key,
          keyword: byKey.get(item.item_key)?.keyword ?? item.item_key,
        }));
      const inFlight = remaining.filter(
        (item) => item.state === "submitted" && item.provider_task_id,
      ).length;
      if (
        unsubmitted.length > 0 &&
        inFlight < this.serpSubmitChunk &&
        deadline - this.now() > 20_000
      ) {
        await this.submitSerpChunk(
          pool,
          project,
          projectId,
          runId,
          unsubmitted.slice(0, this.serpSubmitChunk - inFlight),
        );
      }
      const submitted = remaining.filter(
        (item) => item.state === "submitted" && item.provider_task_id,
      );
      const collected = await this.collectReadySerps(
        pool,
        projectId,
        runId,
        submitted,
        byKey,
        deadline,
      );
      if (
        unsubmitted.length === 0 &&
        submitted.length === 0
      ) {
        break;
      }
      if (collected === 0) await this.wait(3_000);
    }
    const leftover = (await this.serpWork(pool, runId)).filter(
      (item) => item.state !== "succeeded",
    ).length;
    if (leftover > 0) {
      throw new HttpError(
        503,
        "provider_hydration_incomplete",
        `SERP collection paused after persisting progress. ${leftover} keywords remaining.`,
      );
    }
  }

  private async submitSerpChunk(
    pool: DatabasePool,
    project: ProjectProviderRow,
    projectId: string,
    runId: string,
    items: Array<{ itemKey: string; keyword: string }>,
  ): Promise<void> {
    if (items.length === 0) return;
    let submitted: SerpTask[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        submitted = await this.dataForSeo.submitSerpTasks(
          items,
          project.country,
          project.language,
        );
        break;
      } catch (error) {
        if (!isProviderRateLimit(error) || attempt === 4) throw error;
        await this.wait(35_000);
      }
    }
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

  private async collectReadySerps(
    pool: DatabasePool,
    projectId: string,
    runId: string,
    submitted: ProviderWorkItemRow[],
    byKey: Map<string, KeywordProviderRow>,
    deadline: number,
  ): Promise<number> {
    if (submitted.length === 0) return 0;
    let ready = new Set<string>();
    try {
      ready = await this.dataForSeo.readySerpTaskIds();
    } catch (error) {
      if (!isProviderRateLimit(error)) throw error;
      await this.wait(35_000);
    }
    const readyItems = submitted.filter(
      (item) => item.provider_task_id && ready.has(item.provider_task_id),
    );
    const candidates =
      readyItems.length > 0
        ? readyItems
        : submitted.filter((item) => item.provider_task_id);
    let collected = 0;
    await concurrently(candidates, SERP_RESULT_CONCURRENCY, async (item) => {
      if (this.now() >= deadline) return;
      const keyword = byKey.get(item.item_key);
      if (!keyword) return;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          const snapshot = await this.dataForSeo.serpTaskSnapshot(
            item.provider_task_id!,
          );
          if (snapshot === "pending") return;
          await this.persistSerp(pool, projectId, runId, keyword, snapshot);
          collected += 1;
          return;
        } catch (error) {
          if (!isProviderRateLimit(error) || attempt === 4) throw error;
          await this.wait(35_000);
        }
      }
    });
    return collected;
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
      authority_metric_source: string | null;
      authority_fetched_at: Date | null;
    }>(
      `
        SELECT
          authority_domain_rating::text AS domain_rating,
          authority_referring_domains AS referring_domains,
          authority_backlinks::text AS backlinks,
          authority_metric_source,
          authority_fetched_at
        FROM navigator_projects
        WHERE id = $1
      `,
      [projectId],
    );
    const stored = current.rows[0];
    if (
      stored &&
      ((stored.authority_metric_source === "dataforseo" && stored.authority_fetched_at &&
        stored.authority_fetched_at.getTime() >= this.now() - 30 * 86_400_000) ||
      (!stored.authority_metric_source && (Number(stored.domain_rating) > 0 ||
        stored.referring_domains > 0 ||
        Number(stored.backlinks) > 0)))
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
          AND metric_source = 'dataforseo'
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
              authority_metric_source = 'dataforseo',
              authority_fetched_at = $5,
              updated_at = now()
          WHERE id = $1
        `,
        [
          projectId,
          cachedValue.domainRating,
          cachedValue.referringDomains,
          cachedValue.backlinks,
          cachedValue.fetched_at,
        ],
      );
      return;
    }
    const metrics = await this.authorityProvider.metrics([
      { mode: "domain", url: domain },
    ]);
    const value = metrics.get(domain);
    if (!value) throw new Error("DataForSEO returned no client-domain record.");
    await pool.query(
      `
        UPDATE navigator_projects
        SET
          authority_domain_rating = COALESCE($2, authority_domain_rating),
          authority_referring_domains = COALESCE($3, authority_referring_domains),
          authority_backlinks = COALESCE($4, authority_backlinks),
          authority_metric_source = 'dataforseo',
          authority_fetched_at = now(),
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
        VALUES ($1, $2, $3, $4, $5, 'dataforseo', now())
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
    runId: string,
    deadline = this.now() + STAGE_EXECUTION_BUDGET_MS,
  ): Promise<void> {
    const result = await pool.query<{ url: string }>(
      `SELECT DISTINCT url FROM local_provider_serp_results WHERE project_id = $1 ORDER BY url`,
      [projectId],
    );
    const urls = result.rows.map(row => row.url);
    const cached = await pool.query<{ url: string }>(
      `SELECT url FROM authority_url_cache
       WHERE url = ANY($1::text[]) AND metric_source = 'dataforseo'
         AND fetched_at >= now() - interval '30 days'
         AND url_rating IS NOT NULL AND domain_rating IS NOT NULL
         AND backlinks IS NOT NULL AND referring_domains IS NOT NULL`,
      [urls],
    );
    const saved = new Set(cached.rows.map(row => row.url));
    const domainResult = await pool.query<AuthorityMetrics & { domain: string }>(
      `SELECT domain, domain_rating AS "domainRating", backlinks,
         referring_domains AS "referringDomains", NULL AS "urlRating",
         NULL AS "ahrefsRank", 'dataforseo' AS source, 'domain' AS scope
       FROM authority_domain_cache
       WHERE domain = ANY($1::text[]) AND metric_source = 'dataforseo'
         AND fetched_at >= now() - interval '30 days'
         AND domain_rating IS NOT NULL AND backlinks IS NOT NULL AND referring_domains IS NOT NULL`,
      [[...new Set(urls.map(cleanDomain))]],
    );
    const domains = new Map(domainResult.rows.map(row => [row.domain, row]));
    const progress = async () => {
      const done = saved.size;
      await pool.query(
        `UPDATE pipeline_stage_runs
         SET output = COALESCE(output, '{}'::jsonb) ||
           jsonb_build_object('message', $2::text, 'providerProgress', $3::jsonb)
         WHERE run_id = $1 AND stage_id = 'backlinks' AND state = 'running'`,
        [runId,
          `DataForSEO Backlinks: ${done} of ${urls.length} URLs saved; remaining work resumes automatically.`,
          JSON.stringify({ provider: "dataforseo_backlinks", unit: "items", batch: Math.min(done + 1, urls.length),
            batchCount: urls.length, completedBatches: done, activeBatches: 0 })],
      );
    };
    const applyCached = async (client: Pick<DatabasePool, "query">, targets: readonly string[]) => {
      await client.query(
        `UPDATE local_provider_serp_results AS serp
         SET url_rating = cache.url_rating, domain_rating = cache.domain_rating,
             ahrefs_rank = NULL, referring_domains = cache.referring_domains,
             backlinks = cache.backlinks, metric_source = 'dataforseo',
             authority_scope = cache.authority_scope
         FROM authority_url_cache AS cache
         WHERE serp.project_id = $1 AND serp.url = cache.url AND cache.url = ANY($2::text[])
           AND (serp.url_rating, serp.domain_rating, serp.ahrefs_rank, serp.referring_domains,
                serp.backlinks, serp.metric_source, serp.authority_scope)
             IS DISTINCT FROM
               (cache.url_rating, cache.domain_rating, NULL::bigint, cache.referring_domains,
                cache.backlinks, 'dataforseo', cache.authority_scope)`,
        [projectId, targets],
      );
    };
    await progress();
    for (const group of batches([...saved], 500)) await applyCached(pool, group);
    await this.authorityProvider.metrics(
      urls.filter(url => !saved.has(url)).map(url => ({ mode: "exact" as const, url })),
      {
        domains,
        checkBudget: milliseconds => {
          if (this.now() + milliseconds + 10_000 >= deadline) throw new StageContinuation();
        },
        saveDomain: async (domain, value) => {
          await pool.query(
            `INSERT INTO authority_domain_cache
               (domain, domain_rating, ahrefs_rank, referring_domains, backlinks, metric_source, fetched_at)
             VALUES ($1, $2, NULL, $3, $4, 'dataforseo', now())
             ON CONFLICT (domain) DO UPDATE SET domain_rating = EXCLUDED.domain_rating,
               ahrefs_rank = NULL, referring_domains = EXCLUDED.referring_domains,
               backlinks = EXCLUDED.backlinks, metric_source = 'dataforseo',
               fetched_at = EXCLUDED.fetched_at, updated_at = now()`,
            [domain, value.domainRating, value.referringDomains, value.backlinks],
          );
        },
        savePages: async values => {
          const rows = [...values].map(([url, value]) => ({ url, domain: cleanDomain(url),
            url_rating: value.urlRating, domain_rating: value.domainRating,
            referring_domains: value.referringDomains, backlinks: value.backlinks,
            authority_scope: value.scope ?? "page" }));
          await withTransaction(pool, async client => {
            await client.query(
              `INSERT INTO authority_url_cache
                 (url, domain, url_rating, domain_rating, ahrefs_rank, referring_domains,
                  backlinks, metric_source, authority_scope, fetched_at)
               SELECT url, domain, url_rating, domain_rating, NULL, referring_domains,
                      backlinks, 'dataforseo', authority_scope, now()
               FROM jsonb_to_recordset($1::jsonb) AS metric(
                 url text, domain text, url_rating numeric, domain_rating numeric,
                 referring_domains bigint, backlinks bigint, authority_scope text)
               ON CONFLICT (url) DO UPDATE SET domain = EXCLUDED.domain,
                 url_rating = EXCLUDED.url_rating, domain_rating = EXCLUDED.domain_rating,
                 ahrefs_rank = NULL, referring_domains = EXCLUDED.referring_domains,
                 backlinks = EXCLUDED.backlinks, metric_source = 'dataforseo',
                 authority_scope = EXCLUDED.authority_scope,
                 fetched_at = EXCLUDED.fetched_at, updated_at = now()`,
              [JSON.stringify(rows)],
            );
            await applyCached(client, rows.map(row => row.url));
          });
          for (const url of values.keys()) saved.add(url);
          await progress();
        },
      },
    );
  }
  private async hydrateSiteArchitecture(
    pool: DatabasePool,
    projectId: string,
    runId: string,
    deadline?: number,
  ): Promise<void> {
    const project = await this.project(pool, projectId);
    await pool.query(
      `INSERT INTO provider_work_items
         (pipeline_run_id, project_id, stage_id, item_key, provider, state, result, completed_at)
       SELECT $1, $2, 'site-architecture', 'content-fit-inputs-v1', 'input_snapshot', 'succeeded',
         jsonb_build_object('domain', $3::text, 'keywords', COALESCE(jsonb_agg(
           jsonb_build_object('keyword', keyword, 'normalised_keyword', normalised_keyword,
             'ranking_url', ranking_url) ORDER BY normalised_keyword), '[]'::jsonb)), now()
       FROM keywords WHERE project_id = $2 AND detox_status = 'keep'
       ON CONFLICT (pipeline_run_id, stage_id, item_key) DO NOTHING`,
      [runId, projectId, project.domain],
    );
    const snapshot = await pool.query<{ result: { domain: string; keywords: Array<Pick<KeywordProviderRow, "keyword" | "normalised_keyword" | "ranking_url">> } }>(
      `SELECT result FROM provider_work_items WHERE pipeline_run_id = $1
       AND stage_id = 'site-architecture' AND item_key = 'content-fit-inputs-v1'
       AND provider = 'input_snapshot' AND state = 'succeeded'`, [runId]);
    const inputs = snapshot.rows[0]?.result;
    if (!inputs || !Array.isArray(inputs.keywords)) throw new Error("Content-fit input snapshot is unavailable.");
    const requiresScoring = inputs.keywords;
    if (requiresScoring.length === 0) {
      await pool.query(
        `DELETE FROM local_provider_site_architecture_inputs WHERE project_id = $1`,
        [projectId],
      );
      return;
    }
    const scores = await this.ai.score(
      requiresScoring.map((keyword) => ({
        keyword: keyword.keyword,
        rankingUrl: keyword.ranking_url ?? `https://${cleanDomain(inputs.domain)}/`,
        scope: keyword.ranking_url ? "page" : "domain_fallback",
      })),
      this.aiOptions(pool, projectId, runId, "site-architecture", deadline),
    );
    const values: SiteArchitectureResult[] = requiresScoring.map((keyword) => {
      const score = scores.get(keyword.normalised_keyword);
      if (!score) {
        throw new Error(
          `Content-fit scoring returned no result for ${keyword.normalised_keyword}.`,
        );
      }
      return {
        model: score.model,
        contentStatus: score.contentStatus,
        keyword: keyword.keyword,
        matchedUrl: keyword.ranking_url,
        relevancyScore: score.relevancyScore,
        inputScope: keyword.ranking_url ? "page" : "domain_fallback",
        tacticalStatus: score.tacticalStatus,
      };
    });
    await withTransaction(pool, async (client) => {
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
              tactical_status,
              metric_source,
              input_scope
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (project_id, normalised_keyword)
            DO UPDATE SET
              keyword = EXCLUDED.keyword,
              matched_url = EXCLUDED.matched_url,
              relevancy_score = EXCLUDED.relevancy_score,
              content_status = EXCLUDED.content_status,
              tactical_status = EXCLUDED.tactical_status,
              metric_source = EXCLUDED.metric_source,
              input_scope = EXCLUDED.input_scope
          `,
          [
            projectId,
            normaliseKeyword(value.keyword),
            value.keyword,
            value.matchedUrl,
            value.relevancyScore,
            value.contentStatus,
            value.tacticalStatus,
            `openrouter:${value.model}`,
            value.inputScope,
          ],
        );
      }
    });
  }
}
