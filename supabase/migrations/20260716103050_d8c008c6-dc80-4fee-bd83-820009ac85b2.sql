ALTER TABLE public.keyword_forecast_scenarios
  ADD COLUMN IF NOT EXISTS expected_incremental_low_annual numeric,
  ADD COLUMN IF NOT EXISTS expected_incremental_high_annual numeric;