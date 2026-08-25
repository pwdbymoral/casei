import { getDatabasePool } from "@casei/database";
import { bootstrapFirstPlatformAdmin } from "./admin-bootstrap.js";
import { PostgresAdminAccountStore } from "./admin-store.js";

const userId = process.env.CASEI_BOOTSTRAP_USER_ID;
if (!userId) throw new Error("CASEI_BOOTSTRAP_USER_ID is required");

const migrationUrl = process.env.DATABASE_URL_MIGRATION ?? process.env.DATABASE_URL;
if (!migrationUrl) throw new Error("DATABASE_URL_MIGRATION or DATABASE_URL is required");

const pool = getDatabasePool({ connectionString: migrationUrl });
try {
  await bootstrapFirstPlatformAdmin(
    new PostgresAdminAccountStore(pool, process.env.DATABASE_ROLE),
    userId,
  );
  console.log("platform admin bootstrap completed");
} finally {
  await pool.end();
}
