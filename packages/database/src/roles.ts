import type { Pool } from "pg";

export async function ensureApplicationRole(pool: Pool) {
  try {
    await pool.query("CREATE ROLE casei_app NOLOGIN NOSUPERUSER NOBYPASSRLS");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "42710") {
      throw error;
    }
  }

  const result = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls
     FROM pg_roles
     WHERE rolname = 'casei_app'`,
  );
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error("casei_app must remain a non-superuser role without BYPASSRLS");
  }
}
