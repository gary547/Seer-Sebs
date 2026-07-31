ALTER TABLE revenue_forecasts
  ADD COLUMN IF NOT EXISTS monthly_revenue_json jsonb NOT NULL
    DEFAULT '{
      "months": [],
      "monthly_source": "none",
      "months_used": 0,
      "label_mode": "none",
      "totals": {}
    }'::jsonb,
  ADD COLUMN IF NOT EXISTS svm_used numeric(8,6) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS p_att_used numeric(8,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS har_conf_used numeric(8,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS band_method text NOT NULL
    DEFAULT 'conf_interp_band_v1';

ALTER TABLE calibration_snapshots
  ADD COLUMN IF NOT EXISTS median_per_pair_ratio numeric,
  ADD COLUMN IF NOT EXISTS sum_modelled_monthly numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sum_actual_monthly numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS impressions_context bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promotion_eligible boolean NOT NULL DEFAULT false;

INSERT INTO schema_migrations (version)
VALUES ('008_model_parity_contract')
ON CONFLICT (version) DO NOTHING;
