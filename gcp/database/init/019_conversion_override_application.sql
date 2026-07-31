ALTER TABLE revenue_forecasts
  ADD COLUMN IF NOT EXISTS conversion_rate_used numeric
    CHECK (
      conversion_rate_used IS NULL
      OR conversion_rate_used BETWEEN 0 AND 1
    ),
  ADD COLUMN IF NOT EXISTS average_order_value_used numeric
    CHECK (
      average_order_value_used IS NULL
      OR average_order_value_used >= 0
    ),
  ADD COLUMN IF NOT EXISTS conversion_rate_override_id uuid,
  ADD COLUMN IF NOT EXISTS average_order_value_override_id uuid;

INSERT INTO schema_migrations (version)
VALUES ('019_conversion_override_application')
ON CONFLICT (version) DO NOTHING;
