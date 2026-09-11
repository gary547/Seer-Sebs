CREATE TABLE IF NOT EXISTS keyword_intent_cache (
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  context_hash text NOT NULL,
  normalised_keyword text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, context_hash, normalised_keyword)
);

GRANT SELECT, INSERT ON keyword_intent_cache TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('035_keyword_intent_cache')
ON CONFLICT (version) DO NOTHING;
