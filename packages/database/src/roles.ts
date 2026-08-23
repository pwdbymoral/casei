import type { Pool } from "pg";

export async function ensureApplicationRole(pool: Pool) {
  try {
    await pool.query("CREATE ROLE casei_app NOLOGIN NOSUPERUSER NOBYPASSRLS");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "42710") {
      throw error;
    }
  }
}
