ALTER TABLE facet_demo_runs ADD COLUMN IF NOT EXISTS payment_state text NOT NULL DEFAULT 'NOT_REQUIRED';
ALTER TABLE facet_demo_runs ADD COLUMN IF NOT EXISTS payment_payload jsonb;
ALTER TABLE facet_demo_runs ADD COLUMN IF NOT EXISTS payment_tx_hash text;
ALTER TABLE facet_demo_runs ADD COLUMN IF NOT EXISTS payment_payload_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS facet_demo_runs_payment_payload_hash_uidx ON facet_demo_runs(payment_payload_hash) WHERE payment_payload_hash IS NOT NULL;
