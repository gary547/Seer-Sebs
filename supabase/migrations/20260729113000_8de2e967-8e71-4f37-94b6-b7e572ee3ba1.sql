ALTER TABLE public.categorisation_jobs
  ADD COLUMN IF NOT EXISTS from_fallback integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.claim_categorisation_batch_v2(
  _project_id uuid,
  _tier text,
  _limit integer
)
RETURNS TABLE (
  id uuid,
  keyword text,
  search_intent text,
  categorisation_tier text,
  categorisation_attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimable AS (
    SELECT k.id
      FROM public.keywords k
     WHERE k.project_id = _project_id
       AND k.detox_status = 'keep'
       AND k.tag_1 IS NULL
       AND k.categorisation_status IN ('pending', 'error')
       AND (
         _tier IS NULL
         OR k.categorisation_tier = _tier
         OR k.categorisation_tier IS NULL
       )
       AND k.categorisation_attempts < 5
     ORDER BY k.categorisation_attempts ASC, k.created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(_limit, 500))
  )
  UPDATE public.keywords k
     SET categorisation_status = 'processing',
         categorisation_locked_at = now(),
         categorisation_attempts = k.categorisation_attempts + 1
    FROM claimable
   WHERE k.id = claimable.id
   RETURNING
     k.id,
     k.keyword,
     k.search_intent,
     k.categorisation_tier,
     k.categorisation_attempts;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_categorisation_batch_v2(
  _ids uuid[],
  _error text,
  _consume_attempt boolean DEFAULT true
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH released AS (
    UPDATE public.keywords
       SET categorisation_status = 'pending',
           categorisation_locked_at = NULL,
           categorisation_last_error = _error,
           categorisation_attempts = CASE
             WHEN _consume_attempt THEN categorisation_attempts
             ELSE GREATEST(0, categorisation_attempts - 1)
           END
     WHERE id = ANY(COALESCE(_ids, ARRAY[]::uuid[]))
       AND categorisation_status = 'processing'
     RETURNING 1
  )
  SELECT COALESCE(COUNT(*), 0)::integer FROM released;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_categorisation_batch_v2(uuid, text, integer)
  FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.release_categorisation_batch_v2(uuid[], text, boolean)
  FROM PUBLIC, authenticated, anon;

GRANT EXECUTE ON FUNCTION public.claim_categorisation_batch_v2(uuid, text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_categorisation_batch_v2(uuid[], text, boolean)
  TO service_role;

UPDATE public.keywords
   SET categorisation_attempts = 3,
       categorisation_status = 'pending',
       categorisation_locked_at = NULL,
       categorisation_last_error = 'Recovered from the legacy exhausted retry state'
 WHERE tag_1 IS NULL
   AND detox_status = 'keep'
   AND categorisation_status <> 'skipped'
   AND categorisation_attempts >= 5;
