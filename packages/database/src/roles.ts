import type { Pool } from "pg";

const defaultApplicationRole = "casei_app";

function quoteRoleIdentifier(roleName: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(roleName)) {
    throw new Error(`Invalid PostgreSQL role name: ${roleName}`);
  }
  return `"${roleName}"`;
}

export interface ApplicationRoleOptions {
  roleName?: string;
  /** Optional non-superuser LOGIN role that is allowed to SET ROLE to the app role. */
  grantee?: string;
}

export async function ensureApplicationRole(
  pool: Pool,
  roleOrOptions: string | ApplicationRoleOptions = defaultApplicationRole,
) {
  const options = typeof roleOrOptions === "string" ? { roleName: roleOrOptions } : roleOrOptions;
  const roleName = options.roleName ?? defaultApplicationRole;
  const roleIdentifier = quoteRoleIdentifier(roleName);
  try {
    await pool.query(`CREATE ROLE ${roleIdentifier} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "42710") {
      throw error;
    }
  }

  const result = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls
     FROM pg_roles
     WHERE rolname = $1`,
    [roleName],
  );
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(`${roleName} must remain a non-superuser role without BYPASSRLS`);
  }

  const ownership = await pool.query<{ schema: string; relname: string }>(
    `SELECT n.nspname AS schema, c.relname
     FROM pg_class AS c
     JOIN pg_roles AS r ON r.oid = c.relowner
     JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE r.rolname = $1
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND c.relkind IN ('r', 'p')
     LIMIT 1`,
    [roleName],
  );
  if (ownership.rows[0]) {
    throw new Error(
      `${roleName} must not own table ${ownership.rows[0].schema}.${ownership.rows[0].relname}`,
    );
  }

  if (options.grantee) {
    const granteeIdentifier = quoteRoleIdentifier(options.grantee);
    const granteeResult = await pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls
       FROM pg_roles
       WHERE rolname = $1`,
      [options.grantee],
    );
    const grantee = granteeResult.rows[0];
    if (!grantee?.rolcanlogin || grantee.rolsuper || grantee.rolbypassrls) {
      throw new Error(`${options.grantee} must be a non-superuser LOGIN role without BYPASSRLS`);
    }
    await pool.query(`GRANT ${roleIdentifier} TO ${granteeIdentifier}`);
  }
}
