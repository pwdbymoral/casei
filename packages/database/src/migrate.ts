import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabase, getDatabasePool } from "./index.js";
import { ensureApplicationRole } from "./roles.js";

const pool = getDatabasePool();

try {
  await ensureApplicationRole(pool, {
    roleName: process.env.DATABASE_ROLE ?? "casei_app",
    grantee: process.env.DATABASE_ROLE_GRANTEE,
  });
  await migrate(createDatabase(pool), { migrationsFolder: "./drizzle" });
} finally {
  await pool.end();
}
