import { readFile } from "node:fs/promises";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  for (const name of [
    "0001_demo_runs.sql",
    "0002_demo_payments.sql",
    "0003_multimodal_runs.sql",
    "0004_canonical_facet_types.sql",
    "0005_run_pricing_snapshot.sql",
  ]) {
    await pool.query(
      await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8"),
    );
  }
  process.stdout.write("Gateway migrations applied.\n");
} finally {
  await pool.end();
}
