export const serpVisibilitySummarySql = `
  WITH feature_groups AS MATERIALIZED (
    SELECT keyword_id, result_type, GROUPING(result_type, keyword_id) AS scope,
      count(*) AS feature_count, count(*) FILTER (WHERE owned) AS owned_count
    FROM project_serp_features
    WHERE project_id = $1
    GROUP BY GROUPING SETS ((keyword_id), (result_type), ())
  ), feature_types AS (
    SELECT result_type, feature_count AS count, owned_count
    FROM feature_groups WHERE scope = 1
    ORDER BY feature_count DESC, result_type LIMIT 30
  )
  SELECT totals.feature_count::text AS feature_count,
    (SELECT count(*)::text FROM feature_groups WHERE scope = 2) AS keyword_count,
    totals.owned_count::text AS owned_count,
    (SELECT avg(serp_visibility_multiplier)::text FROM har_forecasts
      WHERE project_id = $1 AND pipeline_run_id = $2::uuid AND scenario = 'realistic'
    ) AS average_visibility_multiplier,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'resultType', result_type, 'count', count, 'ownedCount', owned_count
    ) ORDER BY count DESC, result_type) FROM feature_types), '[]'::jsonb) AS feature_types
  FROM feature_groups AS totals WHERE scope = 3
`;
