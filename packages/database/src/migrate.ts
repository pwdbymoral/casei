import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabase, getDatabasePool } from "./index.js";
import { ensureApplicationRole } from "./roles.js";

const pool = getDatabasePool();

try {
  await ensureApplicationRole(pool);
  await migrate(createDatabase(pool), { migrationsFolder: "./drizzle" });
} finally {
  await pool.end();
}
