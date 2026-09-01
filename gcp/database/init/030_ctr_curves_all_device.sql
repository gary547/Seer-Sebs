ALTER TABLE ctr_curves
  DROP CONSTRAINT IF EXISTS ctr_curves_device_check;

ALTER TABLE ctr_curves
  ADD CONSTRAINT ctr_curves_device_check
  CHECK (device IN ('all', 'desktop', 'mobile', 'tablet'));

INSERT INTO schema_migrations (version)
VALUES ('030_ctr_curves_all_device')
ON CONFLICT (version) DO NOTHING;
