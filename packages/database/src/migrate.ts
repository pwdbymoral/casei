import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabase, getDatabasePool } from "./index.js";
import { ensureApplicationRole } from "./roles.js";

const migrationUrl = process.env.DATABASE_URL_MIGRATION;
const pool = migrationUrl ? getDatabasePool({ connectionString: migrationUrl }) : getDatabasePool();

try {
  await ensureApplicationRole(pool, {
    roleName: process.env.DATABASE_ROLE ?? "casei_app",
    grantee: process.env.DATABASE_ROLE_GRANTEE,
  });
  await migrate(createDatabase(pool), { migrationsFolder: "./drizzle" });
} finally {
  await pool.end();
}
