-- Phase 2A: client domain normalisation + uniqueness on live rows.

-- 1. Canonical host helper: lowercase, strip scheme, strip leading www., strip anything from first / ? #.
CREATE OR REPLACE FUNCTION public.normalize_domain(_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _input IS NULL THEN NULL
    WHEN btrim(_input) = '' THEN NULL
    ELSE NULLIF(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(btrim(_input)), '^https?://', ''),
            '^www\.', ''
          ),
          '[/?#].*$', ''
        ),
        '\s+', '', 'g'
      ),
      ''
    )
  END;
$$;

-- 2. Generated column so every insert/update is canonicalised without app-side effort.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS domain_normalized text
    GENERATED ALWAYS AS (public.normalize_domain(domain)) STORED;

-- 3. Pre-flight: abort if any live duplicates remain. Archived rows are ignored.
DO $$
DECLARE
  v_conflicts text;
BEGIN
  SELECT string_agg(
    format('%s -> [%s]', domain_normalized, ids),
    E'\n'
  )
  INTO v_conflicts
  FROM (
    SELECT domain_normalized,
           string_agg(id::text, ', ' ORDER BY created_at) AS ids
      FROM public.clients
     WHERE archived_at IS NULL
       AND domain_normalized IS NOT NULL
     GROUP BY domain_normalized
    HAVING count(*) > 1
  ) t;

  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create unique index: live duplicate client domains still exist. Resolve manually (archive extras via archive_client) then re-run migration.%s%s',
      E'\n', v_conflicts;
  END IF;
END $$;

-- 4. Enforce uniqueness on live rows only. Archived clients (including hard-delete precursors) do not block reuse.
CREATE UNIQUE INDEX IF NOT EXISTS clients_domain_normalized_active_uidx
  ON public.clients (domain_normalized)
  WHERE archived_at IS NULL AND domain_normalized IS NOT NULL;

-- 5. Lock down function visibility: readable/executable by the roles the app uses.
REVOKE ALL ON FUNCTION public.normalize_domain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_domain(text) TO anon, authenticated, service_role;