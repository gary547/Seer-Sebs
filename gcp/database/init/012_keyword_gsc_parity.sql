ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS keyword_priority integer;

ALTER TABLE keywords
  DROP CONSTRAINT IF EXISTS keywords_keyword_priority_check,
  DROP CONSTRAINT IF EXISTS keywords_categorisation_source_check;

ALTER TABLE keywords
  ADD CONSTRAINT keywords_keyword_priority_check
    CHECK (
      keyword_priority IS NULL
      OR keyword_priority BETWEEN 1 AND 3
    ),
  ADD CONSTRAINT keywords_categorisation_source_check
    CHECK (
      categorisation_source IS NULL
      OR categorisation_source IN ('client_supplied', 'rule', 'taxonomy')
    );

ALTER TABLE gsc_uploads
  ADD COLUMN IF NOT EXISTS date_range_end date,
  ADD COLUMN IF NOT EXISTS date_range_start date,
  ADD COLUMN IF NOT EXISTS device text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS original_filename text;

ALTER TABLE gsc_uploads
  DROP CONSTRAINT IF EXISTS gsc_uploads_device_check;

ALTER TABLE gsc_uploads
  ADD CONSTRAINT gsc_uploads_device_check
    CHECK (device IN ('all', 'desktop', 'mixed', 'mobile', 'tablet'));

ALTER TABLE gsc_upload_keywords
  DROP CONSTRAINT IF EXISTS gsc_upload_keywords_device_check;

ALTER TABLE gsc_upload_keywords
  ADD CONSTRAINT gsc_upload_keywords_device_check
    CHECK (device IN ('all', 'desktop', 'mobile', 'tablet'));

CREATE TABLE IF NOT EXISTS gsc_upload_pages (
  id uuid PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES gsc_uploads(id) ON DELETE CASCADE,
  page_url text NOT NULL,
  device text NOT NULL CHECK (device IN ('all', 'desktop', 'mobile', 'tablet')),
  clicks integer NOT NULL CHECK (clicks >= 0),
  impressions integer NOT NULL CHECK (impressions >= 0),
  ctr numeric(12, 8) NOT NULL CHECK (ctr BETWEEN 0 AND 1),
  position numeric(10, 4) NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (upload_id, page_url, device)
);

CREATE INDEX IF NOT EXISTS gsc_upload_pages_upload_idx
  ON gsc_upload_pages (upload_id, id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON gsc_upload_pages
  TO seer_api;

GRANT SELECT ON gsc_upload_pages TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('012_keyword_gsc_parity')
ON CONFLICT (version) DO NOTHING;
