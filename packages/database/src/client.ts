import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

const defaultConnectionString = "postgres://casei:casei@localhost:5432/casei";

export function getDatabasePool(config: PoolConfig = {}) {
  return new Pool({
    connectionString: process.env.DATABASE_URL ?? defaultConnectionString,
    ...config,
  });
}

export function createDatabase(pool = getDatabasePool()) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDatabase>;
