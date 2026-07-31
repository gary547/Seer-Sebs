ALTER TABLE public.detox_run_stats
  ADD COLUMN IF NOT EXISTS haiku_max_tokens_per_call numeric,
  ADD COLUMN IF NOT EXISTS deferred_reason text;