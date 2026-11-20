ALTER TABLE facet_demo_runs
  ADD COLUMN IF NOT EXISTS pricing_model text,
  ADD COLUMN IF NOT EXISTS unit_price_atomic text,
  ADD COLUMN IF NOT EXISTS max_items_cap integer,
  ADD COLUMN IF NOT EXISTS max_amount_atomic text,
  ADD COLUMN IF NOT EXISTS deposit_tx_hash text,
  ADD COLUMN IF NOT EXISTS refund_amount_atomic text;
