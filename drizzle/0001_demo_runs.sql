CREATE TABLE IF NOT EXISTS facet_demo_runs (
  id uuid PRIMARY KEY,
  caller_id text NOT NULL,
  facet_version_id uuid NOT NULL REFERENCES facet_versions(id),
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('EXECUTING', 'SUCCEEDED', 'FAILED')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (caller_id, facet_version_id, idempotency_key)
);
