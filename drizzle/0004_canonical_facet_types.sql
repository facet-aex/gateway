UPDATE facet_demo_runs
   SET facet_type = 'API'
 WHERE lower(facet_type) IN ('external_http_api', 'api');

UPDATE facet_demo_runs
   SET facet_type = 'ACTOR'
 WHERE lower(facet_type) IN ('hosted_actor', 'actor');

UPDATE facet_demo_runs
   SET facet_type = 'AGENT'
 WHERE lower(facet_type) IN ('autonomous_agent', 'agent');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'facet_demo_runs_facet_type_chk'
  ) THEN
    ALTER TABLE facet_demo_runs
      ADD CONSTRAINT facet_demo_runs_facet_type_chk
      CHECK (facet_type IS NULL OR facet_type IN ('API', 'ACTOR', 'AGENT'));
  END IF;
END $$;
