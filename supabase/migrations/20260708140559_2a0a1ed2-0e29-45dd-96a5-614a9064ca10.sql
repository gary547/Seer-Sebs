CREATE OR REPLACE FUNCTION public.project_monthly_coverage(p_project_id uuid)
RETURNS TABLE (
  keywords_with_history integer,
  kept_keywords_total integer,
  min_months integer,
  median_months numeric,
  max_months integer,
  percent_keywords_at_or_above_24_months numeric,
  percent_keywords_at_or_above_12_months numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH kept AS (
    SELECT id FROM public.keywords
    WHERE project_id = p_project_id AND detox_status = 'keep'
  ),
  per_kw AS (
    SELECT k.id, COUNT(DISTINCT v.month) AS months
    FROM kept k
    LEFT JOIN public.keyword_monthly_volumes v ON v.keyword_id = k.id
    GROUP BY k.id
  )
  SELECT
    COUNT(*) FILTER (WHERE months > 0)::int,
    (SELECT COUNT(*) FROM kept)::int,
    COALESCE(MIN(months) FILTER (WHERE months > 0), 0)::int,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY months) FILTER (WHERE months > 0), 0)::numeric,
    COALESCE(MAX(months), 0)::int,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE months >= 24) / COUNT(*), 2) END,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE months >= 12) / COUNT(*), 2) END
  FROM per_kw;
$$;

GRANT EXECUTE ON FUNCTION public.project_monthly_coverage(uuid) TO authenticated, service_role;