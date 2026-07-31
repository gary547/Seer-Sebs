#!/usr/bin/env bash

set -euo pipefail

compose_file="gcp/docker-compose.local.yml"
migration_file="supabase/migrations/20260729113000_8de2e967-8e71-4f37-94b6-b7e572ee3ba1.sql"
database_name="seer_categorisation_test_${RANDOM}_$$"
created_roles=()

cleanup() {
  docker compose -f "$compose_file" exec -T postgres \
    dropdb -U seer_owner --if-exists "$database_name" >/dev/null
  for role in "${created_roles[@]}"; do
    docker compose -f "$compose_file" exec -T postgres \
      psql -U seer_owner -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${role}" >/dev/null
  done
}
trap cleanup EXIT

for role in authenticated anon service_role; do
  exists="$(
    docker compose -f "$compose_file" exec -T postgres \
      psql -U seer_owner -d postgres -Atqc "SELECT 1 FROM pg_roles WHERE rolname = '${role}'"
  )"
  if [[ "$exists" != "1" ]]; then
    docker compose -f "$compose_file" exec -T postgres \
      psql -U seer_owner -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role}" >/dev/null
    created_roles+=("$role")
  fi
done

docker compose -f "$compose_file" exec -T postgres \
  createdb -U seer_owner "$database_name"

docker compose -f "$compose_file" exec -T postgres \
  psql -U seer_owner -d "$database_name" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE public.categorisation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE public.keywords (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  keyword text NOT NULL,
  search_intent text,
  categorisation_tier text,
  categorisation_attempts integer NOT NULL DEFAULT 0,
  categorisation_status text NOT NULL DEFAULT 'pending',
  categorisation_locked_at timestamptz,
  categorisation_last_error text,
  detox_status text NOT NULL,
  tag_1 text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.keywords (
  id,
  project_id,
  keyword,
  categorisation_tier,
  categorisation_attempts,
  categorisation_status,
  detox_status,
  created_at
)
VALUES
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'first retry', 'live', 3, 'pending', 'keep', '2026-01-01'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'legacy exhausted', 'live', 5, 'error', 'keep', '2026-01-02'),
  ('10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'owned elsewhere', 'live', 2, 'processing', 'keep', '2026-01-03');
SQL

docker compose -f "$compose_file" exec -T postgres \
  psql -U seer_owner -d "$database_name" -v ON_ERROR_STOP=1 >/dev/null < "$migration_file"

docker compose -f "$compose_file" exec -T postgres \
  psql -U seer_owner -d "$database_name" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TEMP TABLE claimed AS
SELECT *
FROM public.claim_categorisation_batch_v2(
  '20000000-0000-0000-0000-000000000001',
  'live',
  2
);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM claimed) <> 2 THEN
    RAISE EXCEPTION 'expected two claimed rows';
  END IF;
  IF EXISTS (SELECT 1 FROM claimed WHERE categorisation_attempts <> 4) THEN
    RAISE EXCEPTION 'claim did not return the incremented attempt count';
  END IF;
  IF (
    SELECT categorisation_attempts
    FROM public.keywords
    WHERE id = '10000000-0000-0000-0000-000000000002'
  ) <> 4 THEN
    RAISE EXCEPTION 'legacy exhausted row was not recovered before claiming';
  END IF;
END;
$$;

SELECT public.release_categorisation_batch_v2(
  ARRAY['10000000-0000-0000-0000-000000000001'::uuid],
  'provider rate limited',
  false
);

SELECT public.release_categorisation_batch_v2(
  ARRAY['10000000-0000-0000-0000-000000000002'::uuid],
  'AI response failed',
  true
);

DO $$
BEGIN
  IF (
    SELECT categorisation_attempts
    FROM public.keywords
    WHERE id = '10000000-0000-0000-0000-000000000001'
  ) <> 3 THEN
    RAISE EXCEPTION 'unattempted work consumed a retry';
  END IF;
  IF (
    SELECT categorisation_attempts
    FROM public.keywords
    WHERE id = '10000000-0000-0000-0000-000000000002'
  ) <> 4 THEN
    RAISE EXCEPTION 'attempted work did not retain its retry count';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.keywords
    WHERE id IN (
      '10000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002'
    )
      AND categorisation_status <> 'pending'
  ) THEN
    RAISE EXCEPTION 'released rows did not return to pending';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'categorisation_jobs'
      AND column_name = 'from_fallback'
  ) THEN
    RAISE EXCEPTION 'fallback provenance column is missing';
  END IF;
END;
$$;
SQL

echo "Categorisation SQL integration test passed."
