CREATE TABLE IF NOT EXISTS pipeline_stage_output_chunks (
  run_id uuid NOT NULL,
  stage_id text NOT NULL,
  field_name text NOT NULL CHECK (length(field_name) BETWEEN 1 AND 128),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  item_count integer NOT NULL CHECK (item_count > 0),
  payload text NOT NULL CHECK (octet_length(payload) <= 8388608),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (run_id, stage_id, field_name, chunk_index),
  FOREIGN KEY (run_id, stage_id)
    REFERENCES pipeline_stage_runs(run_id, stage_id) ON DELETE CASCADE,
  CHECK (json_typeof(payload::json) = 'array')
);

GRANT SELECT, INSERT, DELETE ON pipeline_stage_output_chunks TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('036_pipeline_stage_output_chunks')
ON CONFLICT (version) DO NOTHING;
