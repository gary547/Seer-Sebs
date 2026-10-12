BEGIN;

CREATE TABLE IF NOT EXISTS provider_volume_coverage (
  project_id uuid NOT NULL,
  normalised_keyword text NOT NULL,
  month_count integer NOT NULL CHECK (month_count > 0),
  earliest_month date NOT NULL,
  latest_month date NOT NULL CHECK (latest_month >= earliest_month),
  PRIMARY KEY (project_id, normalised_keyword),
  FOREIGN KEY (project_id, normalised_keyword)
    REFERENCES local_provider_keyword_inputs(project_id, normalised_keyword)
    ON DELETE CASCADE
);

LOCK TABLE local_provider_keyword_monthly_volumes IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION maintain_provider_volume_coverage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE coverage public.provider_volume_coverage%ROWTYPE;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    TRUNCATE public.provider_volume_coverage;
    RETURN NULL;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT * INTO coverage FROM public.provider_volume_coverage
    WHERE project_id = OLD.project_id AND normalised_keyword = OLD.normalised_keyword
    FOR UPDATE;
    IF FOUND THEN
      IF coverage.month_count = 1 OR NOT EXISTS (
        SELECT 1 FROM public.local_provider_keyword_monthly_volumes
        WHERE project_id = OLD.project_id AND normalised_keyword = OLD.normalised_keyword
      ) THEN
        DELETE FROM public.provider_volume_coverage
        WHERE project_id = OLD.project_id AND normalised_keyword = OLD.normalised_keyword;
      ELSE
        UPDATE public.provider_volume_coverage
        SET month_count = coverage.month_count - 1,
          earliest_month = CASE WHEN coverage.earliest_month = OLD.month
            THEN (SELECT min(month) FROM public.local_provider_keyword_monthly_volumes
              WHERE project_id = OLD.project_id AND normalised_keyword = OLD.normalised_keyword)
            ELSE coverage.earliest_month END,
          latest_month = CASE WHEN coverage.latest_month = OLD.month
            THEN (SELECT max(month) FROM public.local_provider_keyword_monthly_volumes
              WHERE project_id = OLD.project_id AND normalised_keyword = OLD.normalised_keyword)
            ELSE coverage.latest_month END
        WHERE project_id = OLD.project_id AND normalised_keyword = OLD.normalised_keyword;
      END IF;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO public.provider_volume_coverage
      (project_id, normalised_keyword, month_count, earliest_month, latest_month)
    VALUES (NEW.project_id, NEW.normalised_keyword, 1, NEW.month, NEW.month)
    ON CONFLICT (project_id, normalised_keyword) DO UPDATE SET
      month_count = provider_volume_coverage.month_count + 1,
      earliest_month = LEAST(provider_volume_coverage.earliest_month, EXCLUDED.earliest_month),
      latest_month = GREATEST(provider_volume_coverage.latest_month, EXCLUDED.latest_month);
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;

REVOKE ALL ON FUNCTION maintain_provider_volume_coverage() FROM PUBLIC;

DROP TRIGGER IF EXISTS provider_volume_coverage_insert_delete ON local_provider_keyword_monthly_volumes;
CREATE TRIGGER provider_volume_coverage_insert_delete
AFTER INSERT OR DELETE ON local_provider_keyword_monthly_volumes
FOR EACH ROW EXECUTE FUNCTION maintain_provider_volume_coverage();

DROP TRIGGER IF EXISTS provider_volume_coverage_key_update ON local_provider_keyword_monthly_volumes;
CREATE TRIGGER provider_volume_coverage_key_update
AFTER UPDATE ON local_provider_keyword_monthly_volumes FOR EACH ROW
WHEN ((OLD.project_id, OLD.normalised_keyword, OLD.month)
  IS DISTINCT FROM (NEW.project_id, NEW.normalised_keyword, NEW.month))
EXECUTE FUNCTION maintain_provider_volume_coverage();

DROP TRIGGER IF EXISTS provider_volume_coverage_truncate ON local_provider_keyword_monthly_volumes;
CREATE TRIGGER provider_volume_coverage_truncate
AFTER TRUNCATE ON local_provider_keyword_monthly_volumes
FOR EACH STATEMENT EXECUTE FUNCTION maintain_provider_volume_coverage();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '041_provider_volume_coverage') THEN
    INSERT INTO provider_volume_coverage
      (project_id, normalised_keyword, month_count, earliest_month, latest_month)
    SELECT project_id, normalised_keyword, count(*)::integer, min(month), max(month)
    FROM local_provider_keyword_monthly_volumes GROUP BY project_id, normalised_keyword
    ON CONFLICT (project_id, normalised_keyword) DO UPDATE SET
      month_count = EXCLUDED.month_count, earliest_month = EXCLUDED.earliest_month,
      latest_month = EXCLUDED.latest_month;
  END IF;
END $$;

ANALYZE provider_volume_coverage;
GRANT SELECT ON provider_volume_coverage TO seer_api, seer_worker;
INSERT INTO schema_migrations (version) VALUES ('041_provider_volume_coverage')
ON CONFLICT (version) DO NOTHING;

COMMIT;
