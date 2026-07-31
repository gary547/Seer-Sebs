ALTER TABLE public.keyword_forecasts
  ADD COLUMN IF NOT EXISTS months_to_peak smallint,
  ADD COLUMN IF NOT EXISTS seasonal_urgency numeric(4,3),
  ADD COLUMN IF NOT EXISTS is_in_capture_window boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS peak_source text;

CREATE INDEX IF NOT EXISTS idx_kw_forecasts_capture
  ON public.keyword_forecasts (is_in_capture_window)
  WHERE is_in_capture_window = true;