import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { ensureApplicationRole } from "../src/roles.js";

test("persiste excedente de pagamento como crédito reversível", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0024_card_payment_credit.sql", import.meta.url)),
    "utf8",
  );

  assert.match(migration, /ADD COLUMN "applied_minor" bigint/i);
  assert.match(migration, /CREATE TABLE "card_credit"/i);
  assert.match(migration, /REFERENCES "card_payment"\("id"\)/i);
  assert.match(migration, /"state" in \('active', 'consumed', 'canceled'\)/i);
  assert.match(migration, /CREATE TABLE "card_credit_application"/i);
  assert.match(migration, /"transaction_id" uuid NOT NULL/i);
  assert.match(migration, /"remaining_minor" bigint NOT NULL/i);
  assert.match(migration, /card_statement_adjustment/i);
  assert.match(migration, /GREATEST\([\s\S]*applied_minor/i);
  assert.match(
    migration,
    /JOIN finance_transaction t[\s\S]*t\.state IN \('posted', 'partially_settled'\)/i,
  );
  assert.match(migration, /CREATE POLICY "card_credit_scope"/i);
  assert.match(migration, /UPDATE "card_payment"[\s\S]*SET "applied_minor" = "amount_minor"/i);
});

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationTest = adminUrl ? test : test.skip;

integrationTest("reconcilia pagamentos legados cancelados sem consumir o saldo", async () => {
  if (!adminUrl) throw new Error("DATABASE_URL_TEST is required");
  const adminPool = new Pool({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `casei_card_credit_${suffix}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const migrationRoot = await mkdtemp("/tmp/casei-card-credit-migrations-");
  let pool: Pool | undefined;
  try {
    await ensureApplicationRole(adminPool);
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    pool = new Pool({ connectionString: databaseUrl.toString() });
    const sourceRoot = fileURLToPath(new URL("../drizzle", import.meta.url));
    const journalPath = `${sourceRoot}/meta/_journal.json`;
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    journal.entries = journal.entries.filter((entry) => Number(entry.idx) < 23);
    await mkdir(`${migrationRoot}/meta`, { recursive: true });
    await writeFile(`${migrationRoot}/meta/_journal.json`, JSON.stringify(journal));
    const migrationFiles = (await readdir(sourceRoot))
      .filter(
        (name) =>
          name.endsWith(".sql") &&
          !name.endsWith(".down.sql") &&
          name < "0024_card_payment_credit.sql",
      )
      .sort();
    for (const name of migrationFiles) {
      await copyFile(`${sourceRoot}/${name}`, `${migrationRoot}/${name}`);
    }
    await migrate(drizzle(pool), { migrationsFolder: migrationRoot });

    const workspace = await pool.query<{ id: string }>(
      `INSERT INTO workspace (name) VALUES ('Fixture crédito legado') RETURNING id`,
    );
    const workspaceId = workspace.rows[0]?.id;
    assert.ok(workspaceId);
    const cardId = "00000000-0000-0000-0000-000000000301";
    const statementId = "00000000-0000-0000-0000-000000000201";
    const canceledTransactionId = "00000000-0000-0000-0000-000000000101";
    const activeTransactionId = "00000000-0000-0000-0000-000000000102";
    const purchaseTransactionId = "00000000-0000-0000-0000-000000000103";
    const feeTransactionId = "00000000-0000-0000-0000-000000000104";
    const refundTransactionId = "00000000-0000-0000-0000-000000000105";
    await pool.query(
      `INSERT INTO credit_card
        (id, workspace_id, name, closing_day, due_day, currency_code)
       VALUES ($1, $2, 'Cartão legado', 10, 17, 'BRL')`,
      [cardId, workspaceId],
    );
    await pool.query(
      `INSERT INTO credit_statement
        (id, workspace_id, card_id, period_start, closing_on, due_on, total_minor, paid_minor)
       VALUES ($1, $2, $3, '2030-01-01', '2030-01-10', '2030-01-17', 999, 0)`,
      [statementId, workspaceId, cardId],
    );
    await pool.query(
      `INSERT INTO finance_transaction
        (id, workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code,
         occurred_on, posted_on, cash_settled_on, description, statement_id)
       VALUES
        ($1, $2, 'transfer', 'canceled', 'wallet', 100, 100, 'BRL', '2030-01-10', now(), now(), 'Cancelado', $3),
        ($4, $2, 'transfer', 'posted', 'wallet', 130, 130, 'BRL', '2030-01-10', now(), now(), 'Ativo', $3)`,
      [canceledTransactionId, workspaceId, statementId, activeTransactionId],
    );
    await pool.query(
      `INSERT INTO finance_transaction
        (id, workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code,
         occurred_on, posted_on, description, card_id, statement_id)
       VALUES ($1, $2, 'expense', 'posted', 'card', 100, 100, 'BRL', '2030-01-05', now(), 'Compra', $3, $4)`,
      [purchaseTransactionId, workspaceId, cardId, statementId],
    );
    await pool.query(
      `INSERT INTO finance_transaction
        (id, workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code,
         occurred_on, posted_on, description, card_id, statement_id)
       VALUES ($1, $2, 'expense', 'posted', 'card', 50, 50, 'BRL', '2030-01-05', now(), 'Tarifa', $3, $4)`,
      [feeTransactionId, workspaceId, cardId, statementId],
    );
    await pool.query(
      `INSERT INTO card_statement_adjustment
        (workspace_id, statement_id, transaction_id, kind, amount_minor, description, occurred_on)
       VALUES ($1, $2, $3, 'fee', 50, 'Tarifa legada', '2030-01-05')`,
      [workspaceId, statementId, feeTransactionId],
    );
    await pool.query(
      `INSERT INTO finance_transaction
        (id, workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code,
         occurred_on, posted_on, description, card_id, statement_id)
       VALUES ($1, $2, 'expense', 'posted', 'card', 20, 20, 'BRL', '2030-01-06', now(), 'Estorno', $3, $4)`,
      [refundTransactionId, workspaceId, cardId, statementId],
    );
    await pool.query(
      `INSERT INTO card_statement_adjustment
        (workspace_id, statement_id, transaction_id, source_transaction_id, kind, amount_minor, description, occurred_on)
       VALUES ($1, $2, $3, $4, 'refund', -20, 'Estorno legado', '2030-01-06')`,
      [workspaceId, statementId, refundTransactionId, purchaseTransactionId],
    );
    await pool.query(
      `INSERT INTO card_payment (workspace_id, statement_id, transaction_id, amount_minor, created_at)
       VALUES
        ($1, $2, $3, 100, '2030-01-10T00:00:00Z'),
        ($1, $2, $4, 130, '2030-01-10T00:00:01Z')`,
      [workspaceId, statementId, canceledTransactionId, activeTransactionId],
    );

    await copyFile(
      `${sourceRoot}/0024_card_payment_credit.sql`,
      `${migrationRoot}/0024_card_payment_credit.sql`,
    );
    journal.entries.push({
      idx: 24,
      version: "7",
      when: 1788537500000,
      tag: "0024_card_payment_credit",
      breakpoints: true,
    });
    await writeFile(`${migrationRoot}/meta/_journal.json`, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: migrationRoot });

    const payments = await pool.query<{ transaction_id: string; applied_minor: string }>(
      `SELECT transaction_id, applied_minor::text
         FROM card_payment
        WHERE workspace_id = $1
        ORDER BY transaction_id`,
      [workspaceId],
    );
    assert.deepEqual(payments.rows, [
      { transaction_id: canceledTransactionId, applied_minor: "0" },
      { transaction_id: activeTransactionId, applied_minor: "130" },
    ]);
    const statement = await pool.query<{ paid_minor: string; state: string }>(
      `SELECT paid_minor::text, state FROM credit_statement WHERE id = $1`,
      [statementId],
    );
    assert.deepEqual(statement.rows, [{ paid_minor: "130", state: "paid" }]);
    const credits = await pool.query(`SELECT id FROM card_credit WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    assert.equal(credits.rowCount, 0);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
    await rm(migrationRoot, { recursive: true, force: true });
  }
});
