CREATE OR REPLACE FUNCTION public.bulk_update_serp_authority(_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE n integer;
BEGIN
  WITH input AS (
    SELECT
      (r->>'id')::uuid                            AS id,
      NULLIF(r->>'url_rating','')::numeric        AS url_rating,
      NULLIF(r->>'domain_rating','')::numeric     AS domain_rating,
      NULLIF(r->>'ahrefs_rank','')::bigint        AS ahrefs_rank,
      NULLIF(r->>'referring_domains','')::bigint  AS referring_domains,
      NULLIF(r->>'backlinks','')::bigint          AS backlinks,
      NULLIF(r->>'fetched_at','')::timestamptz    AS fetched_at
    FROM jsonb_array_elements(_rows) r
  )
  UPDATE public.serp_results s
     SET url_rating        = COALESCE(i.url_rating,        s.url_rating),
         domain_rating     = COALESCE(i.domain_rating,     s.domain_rating),
         ahrefs_rank       = COALESCE(i.ahrefs_rank,       s.ahrefs_rank),
         referring_domains = COALESCE(i.referring_domains, s.referring_domains),
         backlinks         = COALESCE(i.backlinks,         s.backlinks),
         fetched_at        = COALESCE(i.fetched_at,        s.fetched_at)
    FROM input i
   WHERE s.id = i.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_update_serp_authority(jsonb) TO authenticated, service_role;