ALTER TABLE facet_demo_runs ADD COLUMN IF NOT EXISTS facet_type text;
ALTER TABLE facet_demo_runs ADD COLUMN IF NOT EXISTS dataset jsonb;
ALTER TABLE facet_demo_runs ADD COLUMN IF NOT EXISTS usage_meta jsonb;
ALTER TABLE facet_demo_runs ADD COLUMN IF NOT EXISTS input_hash text;
ALTER TABLE facet_demo_runs ADD COLUMN IF NOT EXISTS receipt_tx_hash text;
