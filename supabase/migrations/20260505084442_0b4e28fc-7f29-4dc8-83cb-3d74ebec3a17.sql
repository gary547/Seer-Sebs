
-- Global cache for deterministic universal "remove" verdicts
CREATE TABLE public.detox_global_cache (
  keyword text PRIMARY KEY,
  reason text NOT NULL,
  rule_source text NOT NULL,
  hit_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.detox_global_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read detox_global_cache"
  ON public.detox_global_cache FOR SELECT TO authenticated USING (true);

CREATE POLICY "Internal users manage detox_global_cache"
  ON public.detox_global_cache FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
  WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

CREATE INDEX idx_detox_global_cache_rule_source ON public.detox_global_cache(rule_source);

-- Per-invocation observability
CREATE TABLE public.detox_run_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  invocation_started_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  total_pending integer NOT NULL DEFAULT 0,
  resolved_rules integer NOT NULL DEFAULT 0,
  resolved_client_cache integer NOT NULL DEFAULT 0,
  resolved_global_cache integer NOT NULL DEFAULT 0,
  resolved_haiku integer NOT NULL DEFAULT 0,
  resolved_sonnet integer NOT NULL DEFAULT 0,
  deferred integer NOT NULL DEFAULT 0,
  haiku_429 integer NOT NULL DEFAULT 0,
  sonnet_429 integer NOT NULL DEFAULT 0,
  haiku_retries integer NOT NULL DEFAULT 0,
  sonnet_retries integer NOT NULL DEFAULT 0,
  haiku_circuit_tripped boolean NOT NULL DEFAULT false,
  sonnet_circuit_tripped boolean NOT NULL DEFAULT false,
  haiku_input_tokens integer NOT NULL DEFAULT 0,
  haiku_output_tokens integer NOT NULL DEFAULT 0,
  sonnet_input_tokens integer NOT NULL DEFAULT 0,
  sonnet_output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.detox_run_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to detox_run_stats"
  ON public.detox_run_stats FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
  WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

CREATE POLICY "View-only see assigned detox_run_stats"
  ON public.detox_run_stats FOR SELECT TO authenticated
  USING (
    get_user_role(auth.uid()) = 'view_only'
    AND project_id IN (
      SELECT np.id FROM navigator_projects np
      JOIN user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

CREATE INDEX idx_detox_run_stats_project ON public.detox_run_stats(project_id, invocation_started_at DESC);
