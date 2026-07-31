import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import {
  assertProjectAccessByRole,
  getUserRole,
} from "./authorization.js";
import type { TextGenerationClient } from "./anthropic-client.js";

type ContentFormat = "blog" | "category" | "hero" | "page" | "product";

interface ContentMix {
  blog: number;
  category: number;
  hero: number;
  page: number;
  product: number;
}

interface GenerationInput {
  clientId: string;
  defaultLeadWeeks: number;
  heroLeadWeeks: number;
  keywordIds: string[];
  mix: ContentMix;
  name: string;
  projectId: string;
  promotedHeroIds: string[];
}

interface PlannerKeywordRow {
  base_rank: number | null;
  category: string | null;
  id: string;
  keyword: string;
  matched_url: string | null;
  peak_months: number[];
  ranking_url: string | null;
  revenue_gain: string | null;
  search_intent: string | null;
  tactical_status: string | null;
  tags: string[];
}

interface SerpRow {
  domain: string;
  keyword_id: string;
  rank_absolute: number;
  url: string;
}

interface Cluster {
  archStatus: string | null;
  format?: ContentFormat;
  intent: string;
  peakMonth: number | null;
  primary: PlannerKeywordRow;
  recommendedUrl: string | null;
  score: number;
  secondaries: PlannerKeywordRow[];
  totalRevenue: number;
}

interface GeneratedBrief {
  idx: number;
  internal_link_anchors?: string[];
  meta_description?: string;
  meta_title?: string;
  page_title_h1?: string;
  suggested_h2?: string[];
  synopsis?: string;
}

const DEFAULT_MIX: ContentMix = {
  blog: 6,
  category: 1,
  hero: 2,
  page: 2,
  product: 1,
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }
  return value as Record<string, unknown>;
}

function stringValue(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value.trim();
}

function uuid(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!UUID_PATTERN.test(parsed)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return parsed;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value;
}

function parseMix(value: unknown): ContentMix {
  const source = value === undefined ? DEFAULT_MIX : record(value);
  const mix: ContentMix = {
    blog: boundedInteger(source.blog, "mix.blog", 0, 12),
    category: boundedInteger(source.category, "mix.category", 0, 12),
    hero: boundedInteger(source.hero, "mix.hero", 0, 12),
    page: boundedInteger(source.page, "mix.page", 0, 12),
    product: boundedInteger(source.product, "mix.product", 0, 12),
  };
  if (Object.values(mix).reduce((total, count) => total + count, 0) !== 12) {
    throw new HttpError(
      400,
      "invalid_request",
      "The content mix must total 12.",
    );
  }
  return mix;
}

function parseGenerationInput(value: unknown): GenerationInput {
  const input = record(value);
  if (!Array.isArray(input.keywordIds) || input.keywordIds.length === 0) {
    throw new HttpError(
      400,
      "invalid_request",
      "At least one keyword is required.",
    );
  }
  if (input.keywordIds.length > 2_000) {
    throw new HttpError(400, "invalid_request", "Too many keywords were selected.");
  }
  const defaultName = `Content plan · ${new Date().toISOString().slice(0, 10)}`;
  return {
    clientId: uuid(input.clientId, "clientId"),
    defaultLeadWeeks: boundedInteger(
      input.defaultLeadWeeks ?? 12,
      "defaultLeadWeeks",
      1,
      52,
    ),
    heroLeadWeeks: boundedInteger(
      input.heroLeadWeeks ?? 16,
      "heroLeadWeeks",
      1,
      52,
    ),
    keywordIds: [...new Set(input.keywordIds.map((id, index) =>
      uuid(id, `keywordIds[${index}]`),
    ))],
    mix: parseMix(input.mix),
    name:
      input.name === undefined || input.name === null || input.name === ""
        ? defaultName
        : stringValue(input.name, "name", 200),
    projectId: uuid(input.projectId, "projectId"),
    promotedHeroIds: Array.isArray(input.promotedHeroIds)
      ? [...new Set(input.promotedHeroIds.map((id, index) =>
          uuid(id, `promotedHeroIds[${index}]`),
        ))]
      : [],
  };
}

function intentWeight(intent: string | null): number {
  if (intent === "transactional") return 1;
  if (intent === "commercial") return 0.85;
  if (intent === "informational") return 0.6;
  if (intent === "navigational") return 0.4;
  return 0.5;
}

function journeyStage(intent: string): string {
  if (intent === "transactional") return "Convert";
  if (intent === "commercial") return "Consider";
  if (intent === "informational") return "Attract";
  if (intent === "navigational") return "Retain";
  return "Consider";
}

function looksLikeProduct(url: string | null): boolean {
  return Boolean(url && /\/(product|products|p|item|items|sku)\//i.test(url));
}

function looksLikeCategory(url: string | null): boolean {
  return Boolean(
    url &&
      /\/(category|categories|collection|collections|c|shop|range|ranges)\//i.test(
        url,
      ),
  );
}

function dateBeforePeak(
  peakMonth: number | null,
  weeksBefore: number,
): string | null {
  if (peakMonth === null || peakMonth < 1 || peakMonth > 12) return null;
  const now = new Date();
  const currentMonth = now.getUTCMonth() + 1;
  const year =
    peakMonth >= currentMonth
      ? now.getUTCFullYear()
      : now.getUTCFullYear() + 1;
  const date = new Date(Date.UTC(year, peakMonth - 1, 1));
  date.setUTCDate(date.getUTCDate() - weeksBefore * 7);
  return date.toISOString().slice(0, 10);
}

function shiftDate(value: string | null, weeks: number): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - weeks * 7);
  return date.toISOString().slice(0, 10);
}

function clusterKey(keyword: PlannerKeywordRow): string {
  const recommendedUrl = keyword.matched_url ?? keyword.ranking_url;
  if (recommendedUrl) return `url:${recommendedUrl.trim().toLowerCase()}`;
  const topic =
    keyword.tags.at(-1) ?? keyword.category ?? "uncategorised";
  return `topic:${topic.trim().toLowerCase()}|${keyword.search_intent ?? "unknown"}`;
}

function assignFormats(
  clusters: Cluster[],
  mix: ContentMix,
  promotedHeroIds: string[],
): Cluster[] {
  const remaining = [...clusters].sort((left, right) => right.score - left.score);
  const taken: Cluster[] = [];
  const take = (
    predicate: (cluster: Cluster) => boolean,
    maximum: number,
    format: ContentFormat,
  ) => {
    let count = 0;
    for (let index = 0; index < remaining.length && count < maximum; index += 1) {
      const cluster = remaining[index];
      if (!cluster || !predicate(cluster)) continue;
      cluster.format = format;
      taken.push(cluster);
      remaining.splice(index, 1);
      index -= 1;
      count += 1;
    }
  };

  take(
    (cluster) => promotedHeroIds.includes(cluster.primary.id),
    Math.min(promotedHeroIds.length, mix.hero),
    "hero",
  );
  take(
    () => true,
    Math.max(0, mix.hero - taken.filter((item) => item.format === "hero").length),
    "hero",
  );
  take((cluster) => looksLikeProduct(cluster.recommendedUrl), mix.product, "product");
  take((cluster) => looksLikeCategory(cluster.recommendedUrl), mix.category, "category");
  take(
    (cluster) =>
      cluster.archStatus === "optimise_content" ||
      (["transactional", "navigational"].includes(cluster.intent) &&
        cluster.recommendedUrl !== null),
    mix.page,
    "page",
  );
  take(() => true, mix.blog, "blog");
  while (taken.length < 12 && remaining.length > 0) {
    const cluster = remaining.shift();
    if (!cluster) break;
    cluster.format = "blog";
    taken.push(cluster);
  }
  return taken.slice(0, 12);
}

function responseText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { text: string } =>
        Boolean(
          item &&
            typeof item === "object" &&
            "text" in item &&
            typeof item.text === "string",
        ),
    )
    .map((item) => item.text)
    .join("");
}

function parseBriefs(value: string): GeneratedBrief[] {
  const fenced = value.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? value.slice(value.indexOf("["), value.lastIndexOf("]") + 1);
  const parsed = JSON.parse(candidate) as unknown;
  if (!Array.isArray(parsed)) throw new Error("AI response is not an array.");
  return parsed.filter(
    (item): item is GeneratedBrief =>
      Boolean(
        item &&
          typeof item === "object" &&
          "idx" in item &&
          Number.isInteger((item as { idx: unknown }).idx),
      ),
  );
}

function fallbackBrief(
  cluster: Cluster,
  serpTop3: Array<{ domain: string; rank: number; url: string }>,
  index: number,
): GeneratedBrief {
  const secondaryText = cluster.secondaries
    .slice(0, 4)
    .map((keyword) => keyword.keyword)
    .join(", ");
  const competitors = serpTop3.map((item) => item.domain).join(", ");
  return {
    idx: index,
    internal_link_anchors: cluster.secondaries
      .slice(0, 4)
      .map((keyword) => keyword.keyword),
    meta_description: `A practical guide to ${cluster.primary.keyword}, covering the questions and options searchers need to make a confident decision.`.slice(
      0,
      160,
    ),
    meta_title: cluster.primary.keyword.slice(0, 60),
    page_title_h1: cluster.primary.keyword.slice(0, 70),
    suggested_h2: cluster.secondaries
      .slice(0, 6)
      .map((keyword) => keyword.keyword),
    synopsis: [
      `Create a focused ${cluster.format ?? "page"} for people searching for “${cluster.primary.keyword}”.`,
      `Sections to include:\n- Core answer and decision criteria${secondaryText ? `\n- Related needs: ${secondaryText}` : ""}`,
      `Content gaps:\n- Add first-hand evidence and clear next steps${competitors ? `\n- Cover the themes currently surfaced by ${competitors}` : ""}`,
    ].join("\n\n"),
  };
}

async function enrichBriefs(
  client: TextGenerationClient | undefined,
  clusters: Cluster[],
  serpByKeyword: Map<
    string,
    Array<{ domain: string; rank: number; url: string }>
  >,
): Promise<GeneratedBrief[]> {
  const fallbacks = clusters.map((cluster, index) =>
    fallbackBrief(cluster, serpByKeyword.get(cluster.primary.id) ?? [], index),
  );
  if (!client || clusters.length === 0) return fallbacks;
  const payload = clusters.map((cluster, index) => ({
    arch_status: cluster.archStatus,
    format: cluster.format,
    idx: index,
    intent: cluster.intent,
    potential_revenue_gain: Math.round(cluster.totalRevenue),
    primary_keyword: cluster.primary.keyword,
    recommended_url: cluster.recommendedUrl,
    secondary_keywords: cluster.secondaries
      .slice(0, 5)
      .map((keyword) => keyword.keyword),
    serp_top3: serpByKeyword.get(cluster.primary.id) ?? [],
  }));
  try {
    const generated = await client.generate({
      maxTokens: 12_000,
      messages: [
        {
          content: `Items:\n${JSON.stringify(payload, null, 2)}`,
          role: "user",
        },
      ],
      system:
        "You are a senior SEO content strategist. Return only one JSON array with one object per idx. Each object must contain idx, page_title_h1 (maximum 70 characters), meta_title (maximum 60 characters), meta_description (maximum 160 characters), synopsis (three short paragraphs with sections and content gaps), suggested_h2 (4-7 strings), and internal_link_anchors (3-5 strings).",
    });
    const parsed = parseBriefs(responseText(generated));
    const byIndex = new Map(parsed.map((brief) => [brief.idx, brief]));
    return fallbacks.map((fallback) => ({
      ...fallback,
      ...(byIndex.get(fallback.idx) ?? {}),
      idx: fallback.idx,
    }));
  } catch {
    return fallbacks;
  }
}

async function projectKeywords(
  pool: DatabasePool,
  projectId: string,
): Promise<PlannerKeywordRow[]> {
  const result = await pool.query<PlannerKeywordRow>(
    `
      WITH latest_run AS (
        SELECT id
        FROM pipeline_runs
        WHERE input->>'projectId' = $1::text
          AND status = 'succeeded'
        ORDER BY completed_at DESC, id DESC
        LIMIT 1
      )
      SELECT
        keyword.id,
        keyword.keyword,
        keyword.search_intent,
        keyword.category,
        coalesce(keyword.tags, ARRAY[]::text[]) AS tags,
        keyword.base_rank,
        keyword.ranking_url,
        revenue.target_incremental_revenue_annual::text AS revenue_gain,
        coalesce(demand.peak_months, ARRAY[]::integer[]) AS peak_months,
        architecture.matched_url,
        architecture.tactical_status
      FROM keywords AS keyword
      LEFT JOIN latest_run ON true
      LEFT JOIN revenue_forecasts AS revenue
        ON revenue.pipeline_run_id = latest_run.id
       AND revenue.keyword_id = keyword.id
       AND revenue.scenario = 'realistic'
      LEFT JOIN keyword_demand_signals AS demand
        ON demand.pipeline_run_id = latest_run.id
       AND demand.keyword_id = keyword.id
      LEFT JOIN site_architecture AS architecture
        ON architecture.pipeline_run_id = latest_run.id
       AND architecture.keyword_id = keyword.id
      WHERE keyword.project_id = $1::uuid
        AND keyword.detox_status = 'keep'
      ORDER BY keyword.created_at, keyword.id
    `,
    [projectId],
  );
  return result.rows;
}

async function serpTop3(
  pool: DatabasePool,
  projectId: string,
): Promise<
  Map<string, Array<{ domain: string; rank: number; url: string }>>
> {
  const result = await pool.query<SerpRow>(
    `
      SELECT keyword_id, rank_absolute, url, domain
      FROM serp_results
      WHERE project_id = $1
        AND rank_absolute <= 3
      ORDER BY keyword_id, rank_absolute
    `,
    [projectId],
  );
  const grouped = new Map<
    string,
    Array<{ domain: string; rank: number; url: string }>
  >();
  for (const row of result.rows) {
    grouped.set(row.keyword_id, [
      ...(grouped.get(row.keyword_id) ?? []),
      {
        domain: row.domain,
        rank: row.rank_absolute,
        url: row.url,
      },
    ]);
  }
  return grouped;
}

function buildClusters(
  keywords: PlannerKeywordRow[],
  selectedIds: Set<string>,
): Cluster[] {
  const allByKey = new Map<string, PlannerKeywordRow[]>();
  const selectedByKey = new Map<string, PlannerKeywordRow[]>();
  for (const keyword of keywords) {
    const key = clusterKey(keyword);
    allByKey.set(key, [...(allByKey.get(key) ?? []), keyword]);
    if (selectedIds.has(keyword.id)) {
      selectedByKey.set(key, [...(selectedByKey.get(key) ?? []), keyword]);
    }
  }
  const clusters: Cluster[] = [];
  for (const [key, selected] of selectedByKey) {
    const ranked = selected
      .map((keyword) => ({
        keyword,
        revenue: Number(keyword.revenue_gain ?? 0),
      }))
      .sort((left, right) => right.revenue - left.revenue);
    const primary = ranked[0]?.keyword;
    if (!primary) continue;
    const secondaries = (allByKey.get(key) ?? [])
      .filter((keyword) => keyword.id !== primary.id)
      .slice(0, 8);
    const totalRevenue = [
      primary,
      ...secondaries,
    ].reduce(
      (total, keyword) => total + Number(keyword.revenue_gain ?? 0),
      0,
    );
    clusters.push({
      archStatus: primary.tactical_status,
      intent: primary.search_intent ?? "informational",
      peakMonth: primary.peak_months[0] ?? null,
      primary,
      recommendedUrl: primary.matched_url ?? primary.ranking_url,
      score: 0,
      secondaries,
      totalRevenue,
    });
  }
  const maximumRevenue = Math.max(1, ...clusters.map((cluster) => cluster.totalRevenue));
  const maximumSize = Math.max(
    1,
    ...clusters.map((cluster) => cluster.secondaries.length + 1),
  );
  for (const cluster of clusters) {
    const revenue = cluster.totalRevenue / maximumRevenue;
    const size = (cluster.secondaries.length + 1) / maximumSize;
    const freshness =
      cluster.archStatus === "create_content"
        ? 1
        : cluster.archStatus === "optimise_content"
          ? 0.6
          : 0.4;
    const competitorStrength = cluster.primary.base_rank
      ? Math.max(0, 1 - Math.min(cluster.primary.base_rank, 100) / 100) * 0.5 +
        0.5
      : 0.7;
    cluster.score =
      revenue * 0.4 +
      size * 0.15 +
      competitorStrength * 0.15 +
      intentWeight(cluster.intent) * 0.15 +
      freshness * 0.15;
  }
  return clusters;
}

export async function generateContentPlan(
  pool: DatabasePool,
  user: AuthenticatedUser,
  body: unknown,
  textGenerationClient?: TextGenerationClient,
): Promise<Record<string, unknown>> {
  const input = parseGenerationInput(body);
  const project = await assertProjectAccessByRole(
    pool,
    user.id,
    input.projectId,
    true,
  );
  if (project.client_id !== input.clientId) {
    throw new HttpError(
      400,
      "invalid_request",
      "The project does not belong to the selected client.",
    );
  }
  const [keywords, serpByKeyword] = await Promise.all([
    projectKeywords(pool, input.projectId),
    serpTop3(pool, input.projectId),
  ]);
  const selectedIds = new Set(input.keywordIds);
  const selectedFound = keywords.filter((keyword) => selectedIds.has(keyword.id));
  if (selectedFound.length !== selectedIds.size) {
    throw new HttpError(
      400,
      "invalid_keywords",
      "One or more selected keywords are unavailable for this project.",
    );
  }
  const clusters = assignFormats(
    buildClusters(keywords, selectedIds),
    input.mix,
    input.promotedHeroIds,
  );
  if (clusters.length === 0) {
    throw new HttpError(
      400,
      "empty_content_plan",
      "The selected keywords did not produce any content opportunities.",
    );
  }
  const briefs = await enrichBriefs(
    textGenerationClient,
    clusters,
    serpByKeyword,
  );
  const planId = randomUUID();
  const totalRevenueGain = clusters.reduce(
    (total, cluster) => total + cluster.totalRevenue,
    0,
  );
  await withTransaction(pool, async (client: PoolClient) => {
    await client.query(
      `
        INSERT INTO content_plans (
          id,
          client_id,
          project_id,
          name,
          mix,
          default_lead_weeks,
          hero_lead_weeks,
          status,
          total_revenue_gain,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'briefed', $8, $9)
      `,
      [
        planId,
        input.clientId,
        input.projectId,
        input.name,
        input.mix,
        input.defaultLeadWeeks,
        input.heroLeadWeeks,
        totalRevenueGain,
        user.id,
      ],
    );
    const items = clusters.map((cluster, index) => {
      const brief = briefs[index] ?? fallbackBrief(
        cluster,
        serpByKeyword.get(cluster.primary.id) ?? [],
        index,
      );
      const publishMonth = dateBeforePeak(cluster.peakMonth, 8);
      const leadWeeks =
        cluster.format === "hero"
          ? input.heroLeadWeeks
          : input.defaultLeadWeeks;
      return {
        business_area: cluster.primary.category,
        cluster_score: cluster.score,
        content_action:
          cluster.archStatus === "optimise_content"
            ? "optimise"
            : cluster.archStatus === "watch"
              ? "watch"
              : "create",
        content_format: cluster.format ?? "blog",
        first_draft_deadline: shiftDate(publishMonth, leadWeeks),
        hero_promoted:
          cluster.format === "hero" &&
          input.promotedHeroIds.includes(cluster.primary.id),
        inbound_links: [],
        internal_links: brief.internal_link_anchors ?? [],
        meta_description: brief.meta_description?.slice(0, 160) ?? null,
        meta_title: brief.meta_title?.slice(0, 60) ?? null,
        notes: brief.suggested_h2?.length
          ? `Suggested H2: ${brief.suggested_h2.join(" · ")}`
          : null,
        page_title_h1:
          brief.page_title_h1?.slice(0, 70) ?? cluster.primary.keyword,
        position: index + 1,
        potential_revenue_gain: cluster.totalRevenue,
        primary_keyword_id: cluster.primary.id,
        primary_keyword_text: cluster.primary.keyword,
        publish_month: publishMonth,
        recommended_url: cluster.recommendedUrl,
        secondary_keyword_ids: cluster.secondaries.map(
          (keyword) => keyword.id,
        ),
        secondary_keyword_text: cluster.secondaries.map(
          (keyword) => keyword.keyword,
        ),
        serp_top3: serpByKeyword.get(cluster.primary.id) ?? [],
        synopsis: brief.synopsis ?? "",
        journey_stage: journeyStage(cluster.intent),
      };
    });
    await client.query(
      `
        INSERT INTO content_plan_items (
          id,
          plan_id,
          position,
          content_format,
          content_action,
          primary_keyword_id,
          secondary_keyword_ids,
          primary_keyword_text,
          secondary_keyword_text,
          recommended_url,
          page_title_h1,
          synopsis,
          meta_title,
          meta_description,
          internal_links,
          inbound_links,
          serp_top3,
          serp_fetched_at,
          potential_revenue_gain,
          journey_stage,
          business_area,
          first_draft_deadline,
          publish_month,
          cluster_score,
          hero_promoted,
          status,
          notes
        )
        SELECT
          input.id,
          $1,
          input.position,
          input.content_format,
          input.content_action,
          input.primary_keyword_id,
          input.secondary_keyword_ids,
          input.primary_keyword_text,
          input.secondary_keyword_text,
          input.recommended_url,
          input.page_title_h1,
          input.synopsis,
          input.meta_title,
          input.meta_description,
          input.internal_links,
          input.inbound_links,
          input.serp_top3,
          now(),
          input.potential_revenue_gain,
          input.journey_stage,
          input.business_area,
          input.first_draft_deadline,
          input.publish_month,
          input.cluster_score,
          input.hero_promoted,
          'queued',
          input.notes
        FROM jsonb_to_recordset($2::jsonb) AS input(
          id uuid,
          position integer,
          content_format text,
          content_action text,
          primary_keyword_id uuid,
          secondary_keyword_ids uuid[],
          primary_keyword_text text,
          secondary_keyword_text text[],
          recommended_url text,
          page_title_h1 text,
          synopsis text,
          meta_title text,
          meta_description text,
          internal_links jsonb,
          inbound_links jsonb,
          serp_top3 jsonb,
          potential_revenue_gain numeric,
          journey_stage text,
          business_area text,
          first_draft_deadline date,
          publish_month date,
          cluster_score numeric,
          hero_promoted boolean,
          notes text
        )
      `,
      [
        planId,
        JSON.stringify(
          items.map((item) => ({ id: randomUUID(), ...item })),
        ),
      ],
    );
    await client.query(
      `
        INSERT INTO content_plan_jobs (
          plan_id,
          client_id,
          project_id,
          status,
          total,
          processed,
          started_at,
          finished_at
        )
        VALUES ($1, $2, $3, 'done', $4, $4, now(), now())
      `,
      [planId, input.clientId, input.projectId, items.length],
    );
  });
  return {
    aiEnriched: Boolean(textGenerationClient),
    items: clusters.length,
    planId,
  };
}

export async function listContentPlans(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string | null,
): Promise<Record<string, unknown>> {
  if (projectId) {
    await assertProjectAccessByRole(pool, user.id, projectId);
  }
  const role = await getUserRole(pool, user.id);
  const result = await pool.query(
    `
      WITH format_counts AS (
        SELECT
          plan_id,
          content_format,
          count(*)::integer AS count
        FROM content_plan_items
        GROUP BY plan_id, content_format
      ),
      item_summary AS (
        SELECT
          item.plan_id,
          count(*)::integer AS item_count,
          min(item.first_draft_deadline) AS next_deadline
        FROM content_plan_items AS item
        GROUP BY item.plan_id
      ),
      format_summary AS (
        SELECT
          plan_id,
          jsonb_object_agg(content_format, count) AS format_mix
        FROM format_counts
        GROUP BY plan_id
      )
      SELECT
        plan.id,
        plan.name,
        plan.status,
        plan.total_revenue_gain::text,
        plan.created_at,
        plan.client_id,
        plan.project_id,
        client.company_name AS client_name,
        project.project_name,
        coalesce(item.item_count, 0) AS item_count,
        item.next_deadline,
        coalesce(format.format_mix, '{}'::jsonb) AS format_mix
      FROM content_plans AS plan
      JOIN clients AS client ON client.id = plan.client_id
      JOIN navigator_projects AS project ON project.id = plan.project_id
      LEFT JOIN item_summary AS item ON item.plan_id = plan.id
      LEFT JOIN format_summary AS format ON format.plan_id = plan.id
      WHERE client.archived_at IS NULL
        AND project.archived_at IS NULL
        AND ($1::uuid IS NULL OR plan.project_id = $1)
        AND (
          $2::text IN ('super_admin', 'admin', 'user')
          OR EXISTS (
            SELECT 1
            FROM user_client_access AS access
            WHERE access.user_id = $3
              AND access.client_id = plan.client_id
          )
        )
      ORDER BY plan.created_at DESC, plan.id DESC
      LIMIT 1_000
    `,
    [projectId, role, user.id],
  );
  return {
    plans: result.rows.map((row) => ({
      ...row,
      total_revenue_gain:
        row.total_revenue_gain === null
          ? null
          : Number(row.total_revenue_gain),
    })),
  };
}

async function planProjectId(
  database: DatabasePool | PoolClient,
  planId: string,
): Promise<string> {
  const result = await database.query<{ project_id: string }>(
    "SELECT project_id FROM content_plans WHERE id = $1",
    [planId],
  );
  const projectId = result.rows[0]?.project_id;
  if (!projectId) {
    throw new HttpError(404, "content_plan_not_found", "Content plan not found.");
  }
  return projectId;
}

export async function getContentPlan(
  pool: DatabasePool,
  user: AuthenticatedUser,
  planId: string,
): Promise<Record<string, unknown>> {
  const projectId = await planProjectId(pool, planId);
  await assertProjectAccessByRole(pool, user.id, projectId);
  const [plan, items] = await Promise.all([
    pool.query(
      `
        SELECT
          plan.*,
          plan.total_revenue_gain::text,
          jsonb_build_object(
            'id', client.id,
            'company_name', client.company_name
          ) AS clients,
          jsonb_build_object(
            'id', project.id,
            'project_name', project.project_name
          ) AS navigator_projects
        FROM content_plans AS plan
        JOIN clients AS client ON client.id = plan.client_id
        JOIN navigator_projects AS project ON project.id = plan.project_id
        WHERE plan.id = $1
      `,
      [planId],
    ),
    pool.query(
      `
        SELECT *
        FROM content_plan_items
        WHERE plan_id = $1
        ORDER BY position, id
      `,
      [planId],
    ),
  ]);
  return {
    items: items.rows,
    plan: {
      ...plan.rows[0],
      total_revenue_gain:
        plan.rows[0]?.total_revenue_gain === null
          ? null
          : Number(plan.rows[0]?.total_revenue_gain),
    },
  };
}

const PATCHABLE_ITEM_FIELDS = new Map<string, string>([
  ["audience", "audience"],
  ["business_area", "business_area"],
  ["campaign_tie_in", "campaign_tie_in"],
  ["content_action", "content_action"],
  ["content_format", "content_format"],
  ["first_draft_deadline", "first_draft_deadline"],
  ["journey_stage", "journey_stage"],
  ["meta_description", "meta_description"],
  ["meta_title", "meta_title"],
  ["notes", "notes"],
  ["page_title_h1", "page_title_h1"],
  ["publish_month", "publish_month"],
  ["recommended_url", "recommended_url"],
  ["responsibility", "responsibility"],
  ["status", "status"],
  ["synopsis", "synopsis"],
]);

export async function updateContentPlanItem(
  pool: DatabasePool,
  user: AuthenticatedUser,
  itemId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const input = record(body);
  const entries = Object.entries(input).filter(([field]) =>
    PATCHABLE_ITEM_FIELDS.has(field),
  );
  if (entries.length === 0 || entries.length !== Object.keys(input).length) {
    throw new HttpError(
      400,
      "invalid_request",
      "No supported item fields were supplied.",
    );
  }
  return withTransaction(pool, async (client) => {
    const item = await client.query<{ plan_id: string }>(
      "SELECT plan_id FROM content_plan_items WHERE id = $1 FOR UPDATE",
      [itemId],
    );
    const planId = item.rows[0]?.plan_id;
    if (!planId) {
      throw new HttpError(
        404,
        "content_plan_item_not_found",
        "Content plan item not found.",
      );
    }
    await assertProjectAccessByRole(
      client,
      user.id,
      await planProjectId(client, planId),
      true,
    );
    const parameters: unknown[] = [itemId];
    const assignments = entries.map(([field, value]) => {
      parameters.push(value === "" ? null : value);
      return `${PATCHABLE_ITEM_FIELDS.get(field)} = $${parameters.length}`;
    });
    const result = await client.query(
      `
        UPDATE content_plan_items
        SET ${assignments.join(", ")}, updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      parameters,
    );
    return result.rows[0];
  });
}

export async function promoteContentPlanItemToHero(
  pool: DatabasePool,
  user: AuthenticatedUser,
  itemId: string,
): Promise<Record<string, unknown>> {
  return withTransaction(pool, async (client) => {
    const targetResult = await client.query<{
      content_format: ContentFormat;
      plan_id: string;
    }>(
      `
        SELECT plan_id, content_format
        FROM content_plan_items
        WHERE id = $1
        FOR UPDATE
      `,
      [itemId],
    );
    const target = targetResult.rows[0];
    if (!target) {
      throw new HttpError(
        404,
        "content_plan_item_not_found",
        "Content plan item not found.",
      );
    }
    await assertProjectAccessByRole(
      client,
      user.id,
      await planProjectId(client, target.plan_id),
      true,
    );
    if (target.content_format === "hero") {
      return { id: itemId, swappedItemId: null };
    }
    const currentHero = await client.query<{ id: string }>(
      `
        SELECT id
        FROM content_plan_items
        WHERE plan_id = $1
          AND content_format = 'hero'
        ORDER BY cluster_score ASC NULLS FIRST, position DESC, id
        LIMIT 1
        FOR UPDATE
      `,
      [target.plan_id],
    );
    const swappedItemId = currentHero.rows[0]?.id ?? null;
    if (swappedItemId) {
      await client.query(
        `
          UPDATE content_plan_items
          SET
            content_format = $2,
            hero_promoted = false,
            updated_at = now()
          WHERE id = $1
        `,
        [swappedItemId, target.content_format],
      );
    }
    await client.query(
      `
        UPDATE content_plan_items
        SET
          content_format = 'hero',
          hero_promoted = true,
          updated_at = now()
        WHERE id = $1
      `,
      [itemId],
    );
    return { id: itemId, swappedItemId };
  });
}
