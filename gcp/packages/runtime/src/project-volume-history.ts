export function canonicalProjectVolumeCte(keptOnly = false): string {
  const qualification = keptOnly ? "AND keyword.detox_status = 'keep'" : "";
  return `imported_volume AS (
    SELECT DISTINCT ON (volume.keyword_id, volume.month)
      volume.keyword_id, volume.month, volume.volume
    FROM keyword_monthly_volumes AS volume
    JOIN keywords AS keyword ON keyword.id = volume.keyword_id
    WHERE keyword.project_id = $1 ${qualification}
    ORDER BY volume.keyword_id, volume.month,
      volume.fetched_at DESC, volume.source DESC, volume.id DESC
  ), canonical_volume AS (
    SELECT keyword_id, month, volume FROM imported_volume
    UNION ALL
    SELECT keyword.id AS keyword_id, provider.month, provider.volume
    FROM keywords AS keyword
    JOIN local_provider_keyword_monthly_volumes AS provider
      ON provider.project_id = keyword.project_id
      AND provider.normalised_keyword = keyword.normalised_keyword
    WHERE keyword.project_id = $1 ${qualification}
      AND NOT EXISTS (
        SELECT 1 FROM imported_volume AS imported
        WHERE imported.keyword_id = keyword.id AND imported.month = provider.month
      )
  )`;
}

export function projectVolumeHistoryCte(): string {
  return `provider_history AS MATERIALIZED (
    SELECT normalised_keyword, count(*)::integer AS month_count,
      min(month) AS earliest_month, max(month) AS latest_month
    FROM local_provider_keyword_monthly_volumes
    WHERE project_id = $1 GROUP BY normalised_keyword
  ), extra_imported_months AS (
    SELECT DISTINCT volume.keyword_id, volume.month
    FROM keyword_monthly_volumes AS volume
    JOIN keywords AS keyword ON keyword.id = volume.keyword_id
    WHERE keyword.project_id = $1 AND keyword.detox_status = 'keep'
      AND NOT EXISTS (
        SELECT 1 FROM local_provider_keyword_monthly_volumes AS provider
        WHERE provider.project_id = $1 AND provider.normalised_keyword = keyword.normalised_keyword
          AND provider.month = volume.month
      )
  ), imported_history AS (
    SELECT keyword_id, count(*)::integer AS month_count,
      min(month) AS earliest_month, max(month) AS latest_month
    FROM extra_imported_months GROUP BY keyword_id
  ), history AS (
    SELECT keyword.id, keyword.keyword, keyword.normalised_keyword,
      COALESCE(provider.month_count, 0) + COALESCE(imported.month_count, 0) AS month_count,
      LEAST(provider.earliest_month, imported.earliest_month) AS earliest_month,
      GREATEST(provider.latest_month, imported.latest_month) AS latest_month
    FROM keywords AS keyword
    LEFT JOIN provider_history AS provider ON provider.normalised_keyword = keyword.normalised_keyword
    LEFT JOIN imported_history AS imported ON imported.keyword_id = keyword.id
    WHERE keyword.project_id = $1 AND keyword.detox_status = 'keep'
  )`;
}
export function projectVolumeSummarySql(): string {
  return `WITH ${projectVolumeHistoryCte()}
    SELECT count(*)::text AS kept_keyword_count,
      count(*) FILTER (WHERE month_count > 0)::text AS with_history_count,
      count(*) FILTER (WHERE month_count >= 12)::text AS with_12_months_count,
      count(*) FILTER (WHERE month_count >= 24)::text AS with_24_months_count,
      sum(month_count)::text AS history_row_count,
      min(month_count)::text AS minimum_months,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY month_count)::text AS median_months,
      max(month_count)::text AS maximum_months,
      to_char(min(earliest_month), 'YYYY-MM-DD') AS earliest_month,
      to_char(max(latest_month), 'YYYY-MM-DD') AS latest_month
    FROM history`;
}

export function projectVolumeSampleSql(): string {
  return `WITH ${projectVolumeHistoryCte()}, sample_keywords AS MATERIALIZED (
    SELECT * FROM history ORDER BY month_count DESC, normalised_keyword LIMIT 20
  )
  SELECT keyword.id AS keyword_id, keyword.keyword, keyword.month_count::text,
    COALESCE(sample.months, '[]'::jsonb) AS months
  FROM sample_keywords AS keyword
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'month', to_char(month, 'YYYY-MM-DD'), 'volume', volume) ORDER BY month) AS months
    FROM (
      SELECT DISTINCT ON (month) month, volume FROM (
        SELECT month, volume, 0 AS priority, fetched_at, source, id
        FROM keyword_monthly_volumes WHERE keyword_id = keyword.id
        UNION ALL
        SELECT month, volume, 1 AS priority, NULL::timestamptz, NULL::text, NULL::uuid
        FROM local_provider_keyword_monthly_volumes
        WHERE project_id = $1 AND normalised_keyword = keyword.normalised_keyword
      ) AS candidates
      ORDER BY month, priority, fetched_at DESC, source DESC, id DESC
    ) AS canonical_months
  ) AS sample
  ORDER BY keyword.month_count DESC, keyword.normalised_keyword`;
}
