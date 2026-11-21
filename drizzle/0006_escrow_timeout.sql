ALTER TABLE facet_demo_runs
  ADD COLUMN IF NOT EXISTS escrow_expires_at timestamptz;
