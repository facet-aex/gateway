import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { Pool } from "pg";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  for (const name of ["0001_demo_runs.sql", "0002_demo_payments.sql"]) {
    await pool.query(
      await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8"),
    );
  }
  process.stdout.write("Gateway demo migration applied.\n");
} finally {
  await pool.end();
}
