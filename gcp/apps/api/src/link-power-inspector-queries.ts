export const linkPowerSummarySql = `
  WITH score_histogram AS MATERIALIZED (
    SELECT score.score, count(*) AS frequency,
      count(*) FILTER (WHERE score.confidence = 'high') AS high_count,
      count(*) FILTER (WHERE score.confidence = 'medium') AS medium_count,
      count(*) FILTER (WHERE score.confidence = 'low') AS low_count
    FROM link_power_scores AS score
    WHERE score.project_id = $1 AND score.pipeline_run_id = $2
    GROUP BY score.score
  ), distribution AS MATERIALIZED (
    SELECT score, sum(frequency) OVER (ORDER BY score) AS end_position
    FROM score_histogram
  ), aggregate AS (
    SELECT COALESCE(sum(frequency), 0) AS scored_count,
      sum(score * frequency) / NULLIF(sum(frequency), 0) AS average_score,
      COALESCE(sum(high_count), 0) AS high_confidence_count,
      COALESCE(sum(medium_count), 0) AS medium_confidence_count,
      COALESCE(sum(low_count), 0) AS low_confidence_count
    FROM score_histogram
  ), percentiles AS (
    SELECT fraction, lower_score.score::double precision
      + (upper_score.score::double precision - lower_score.score::double precision)
        * (position - floor(position)) AS value
    FROM aggregate
    CROSS JOIN (VALUES (0.1::double precision), (0.5), (0.9)) AS fractions(fraction)
    CROSS JOIN LATERAL (SELECT (scored_count - 1)::double precision * fraction AS position) AS target
    LEFT JOIN LATERAL (
      SELECT score FROM distribution WHERE end_position > floor(position)
      ORDER BY score LIMIT 1
    ) AS lower_score ON scored_count > 0
    LEFT JOIN LATERAL (
      SELECT score FROM distribution WHERE end_position > ceil(position)
      ORDER BY score LIMIT 1
    ) AS upper_score ON scored_count > 0
  )
  SELECT aggregate.scored_count::text, aggregate.average_score::text,
    aggregate.high_confidence_count::text, aggregate.medium_confidence_count::text,
    aggregate.low_confidence_count::text,
    (SELECT count(*)::text FROM (
      SELECT score.keyword_id FROM link_power_scores AS score
      WHERE score.project_id = $1 AND score.pipeline_run_id = $2
      GROUP BY score.keyword_id
    ) AS scored_keywords) AS keyword_count,
    (SELECT value::text FROM percentiles WHERE fraction = 0.1) AS p10_score,
    (SELECT value::text FROM percentiles WHERE fraction = 0.5) AS p50_score,
    (SELECT value::text FROM percentiles WHERE fraction = 0.9) AS p90_score
  FROM aggregate
`;

export const linkPowerDomainSummarySql = `
  WITH domains AS MATERIALIZED (
    SELECT result.domain, result.is_client_domain,
      count(*) AS appearance_count, avg(score.score) AS mean_score,
      min(result.rank_absolute) AS best_rank,
      count(*) FILTER (WHERE result.url_rating IS NULL) AS missing_url_rating_count,
      count(*) FILTER (WHERE result.domain_rating IS NULL) AS missing_domain_rating_count,
      count(*) FILTER (WHERE result.referring_domains IS NULL) AS missing_referring_domains_count,
      count(*) FILTER (WHERE result.backlinks IS NULL) AS missing_backlinks_count
    FROM link_power_scores AS score
    JOIN serp_results AS result ON result.id = score.serp_result_id
    WHERE score.project_id = $1 AND score.pipeline_run_id = $2
    GROUP BY result.domain, result.is_client_domain
  ), domain_page AS (
    SELECT domain, is_client_domain, appearance_count::text, mean_score::text, best_rank
    FROM domains
    ORDER BY domains.is_client_domain DESC, domains.mean_score DESC, domains.domain LIMIT 10
  ), totals AS (
    SELECT COALESCE(sum(missing_url_rating_count), 0)::text AS missing_url_rating_count,
      COALESCE(sum(missing_domain_rating_count), 0)::text AS missing_domain_rating_count,
      COALESCE(sum(missing_referring_domains_count), 0)::text AS missing_referring_domains_count,
      COALESCE(sum(missing_backlinks_count), 0)::text AS missing_backlinks_count
    FROM domains
  )
  SELECT page.*, totals.* FROM totals LEFT JOIN domain_page AS page ON true
  ORDER BY page.is_client_domain DESC, page.mean_score::numeric DESC, page.domain
`;

const detailColumns = `keyword.id AS keyword_id, keyword.keyword, keyword.normalised_keyword,
  result.rank_absolute, result.url, result.domain, result.is_client_domain,
  result.url_rating::text, result.domain_rating::text, result.referring_domains::text,
  result.backlinks::text, score.score::text, score.confidence,
  result.metric_source, result.authority_scope, score.serp_result_id`;

export function linkPowerDetailsSql(hasSearch: boolean): string {
  if (!hasSearch) return `
    SELECT ${detailColumns}
    FROM link_power_scores AS score
    JOIN keywords AS keyword ON keyword.id = score.keyword_id
    JOIN serp_results AS result ON result.id = score.serp_result_id
    WHERE score.project_id = $1 AND score.pipeline_run_id = $2
    ORDER BY score.score DESC, keyword.normalised_keyword, result.rank_absolute, score.serp_result_id
    LIMIT $3 OFFSET $4
  `;
  return `
    WITH matching_scores AS MATERIALIZED (
      SELECT score.keyword_id, score.serp_result_id
      FROM keywords AS keyword
      JOIN link_power_scores AS score ON score.keyword_id = keyword.id
      WHERE score.project_id = $1 AND score.pipeline_run_id = $2
        AND keyword.project_id = $1 AND keyword.normalised_keyword LIKE '%' || $3 || '%'
      UNION
      SELECT score.keyword_id, score.serp_result_id
      FROM serp_results AS result
      JOIN link_power_scores AS score ON score.serp_result_id = result.id
      WHERE score.project_id = $1 AND score.pipeline_run_id = $2
        AND result.project_id = $1 AND result.domain LIKE '%' || $3 || '%'
    ), detail_page AS (
      SELECT ${detailColumns}
      FROM matching_scores AS matched
      JOIN link_power_scores AS score
        ON score.pipeline_run_id = $2 AND score.serp_result_id = matched.serp_result_id
      JOIN keywords AS keyword ON keyword.id = matched.keyword_id
      JOIN serp_results AS result ON result.id = matched.serp_result_id
      ORDER BY score.score DESC, keyword.normalised_keyword, result.rank_absolute, score.serp_result_id
      LIMIT $4 OFFSET $5
    )
    SELECT page.*, totals.total
    FROM (SELECT count(*)::text AS total FROM matching_scores) AS totals
    LEFT JOIN detail_page AS page ON true
    ORDER BY page.score::numeric DESC, page.normalised_keyword, page.rank_absolute, page.serp_result_id
  `;
}
