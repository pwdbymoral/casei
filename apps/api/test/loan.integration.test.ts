import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { FinanceService } from "../src/finance-service.js";
import { InvalidCursorError } from "../src/http/cursor.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

describe("LOAN-001/002 simple IOU PostgreSQL", () => {
  integrationIt("paginates persisted payments and hides a foreign contract", async () => {
    const fixture = await createFixture();
    try {
      const service = new FinanceService(fixture.pool, {
        cursorSecret: "loan-integration-secret",
      });
      const created = await service.createLoan(
        fixture.scope,
        {
          direction: "lent",
          counterparty: "Bia",
          principal: { currency: "BRL", minor: "600" },
          occurredOn: "2030-01-10",
        },
        "loan-history-create-001",
      );
      const first = await service.payLoan(
        fixture.scope,
        created.loan.id,
        "loan-history-payment-001",
        0,
        { amount: { currency: "BRL", minor: "100" }, occurredOn: "2030-01-20" },
      );
      const second = await service.payLoan(
        fixture.scope,
        created.loan.id,
        "loan-history-payment-002",
        1,
        { amount: { currency: "BRL", minor: "200" }, occurredOn: "2030-01-21" },
      );

      const firstPage = await service.listLoanPayments(fixture.scope, created.loan.id, {
        limit: 1,
      });
      expect(firstPage).toMatchObject({
        items: [{ id: second.response.payment.id, amount: { minor: "200" } }],
        hasMore: true,
      });
      const nextCursor = firstPage.nextCursor;
      expect(nextCursor).toBeTruthy();
      if (!nextCursor) throw new Error("expected a next cursor");
      const secondPage = await service.listLoanPayments(fixture.scope, created.loan.id, {
        cursor: nextCursor,
        limit: 1,
      });
      expect(secondPage).toMatchObject({
        items: [{ id: first.response.payment.id, amount: { minor: "100" } }],
        hasMore: false,
        nextCursor: null,
      });
      await expect(
        service.listLoanPayments(fixture.scope, created.loan.id, {
          cursor: "cursor-tampered",
          limit: 1,
        }),
      ).rejects.toBeInstanceOf(InvalidCursorError);

      const otherWorkspace = await fixture.pool.query<{ id: string }>(
        `INSERT INTO workspace (name) VALUES ('Outra casa') RETURNING id`,
      );
      const otherWorkspaceId = otherWorkspace.rows[0]?.id;
      if (!otherWorkspaceId) throw new Error("other workspace was not created");
      await fixture.pool.query(
        `INSERT INTO workspace_preference (workspace_id, currency_code, timezone)
         VALUES ($1, 'BRL', 'America/Fortaleza')`,
        [otherWorkspaceId],
      );
      await fixture.pool.query(
        `INSERT INTO membership (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [otherWorkspaceId, fixture.scope.actorId],
      );
      const foreign = await service.createLoan(
        { ...fixture.scope, workspaceId: otherWorkspaceId },
        {
          direction: "borrowed",
          counterparty: "Pessoa externa",
          principal: { currency: "BRL", minor: "100" },
          occurredOn: "2030-01-10",
        },
        "loan-history-foreign-001",
      );
      await expect(
        service.listLoanPayments(fixture.scope, foreign.loan.id, { limit: 10 }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await fixture.close();
    }
  });

  integrationIt("keeps lent principal/reimbursements out of income and expense", async () => {
    const fixture = await createFixture();
    try {
      const service = new FinanceService(fixture.pool, {
        cursorSecret: "loan-integration-secret",
      });
      const created = await service.createLoan(
        fixture.scope,
        {
          direction: "lent",
          counterparty: "Ana",
          principal: { currency: "BRL", minor: "1000" },
          occurredOn: "2030-01-10",
          dueOn: "2030-02-10",
        },
        "loan-create-lent-001",
      );
      expect(created.loan).toMatchObject({
        direction: "lent",
        principal: { minor: "1000" },
        paid: { minor: "0" },
        remaining: { minor: "1000" },
        status: "open",
        version: 0,
      });
      const principal = await fixture.pool.query<{ principal_event_id: string }>(
        `SELECT principal_event_id FROM loan_contract WHERE workspace_id = $1 AND id = $2`,
        [fixture.workspaceId, created.loan.id],
      );
      const alternateEvent = await fixture.pool.query<{ id: string }>(
        `INSERT INTO ledger_event
          (workspace_id, event_type, currency_code, status, occurred_on)
         VALUES ($1, 'loan.principal.lent.v1', 'BRL', 'draft', '2030-01-10')
         RETURNING id`,
        [fixture.workspaceId],
      );
      await expect(
        fixture.pool.query(
          `UPDATE loan_contract SET principal_event_id = $1 WHERE workspace_id = $2 AND id = $3`,
          [alternateEvent.rows[0]?.id, fixture.workspaceId, created.loan.id],
        ),
      ).rejects.toThrow(/loan contract ledger reference is immutable/);
      expect(principal.rows[0]?.principal_event_id).toBeTruthy();

      const partial = await service.payLoan(
        fixture.scope,
        created.loan.id,
        "loan-payment-lent-001",
        0,
        { amount: { currency: "BRL", minor: "250" }, occurredOn: "2030-01-20" },
      );
      expect(partial.response.loan).toMatchObject({
        paid: { minor: "250" },
        remaining: { minor: "750" },
        status: "open",
        version: 1,
      });
      const replay = await service.payLoan(
        fixture.scope,
        created.loan.id,
        "loan-payment-lent-001",
        0,
        { amount: { currency: "BRL", minor: "250" }, occurredOn: "2030-01-20" },
      );
      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(partial.response);

      const settled = await service.payLoan(
        fixture.scope,
        created.loan.id,
        "loan-payment-lent-002",
        1,
        { amount: { currency: "BRL", minor: "750" }, occurredOn: "2030-02-01" },
      );
      expect(settled.response.loan).toMatchObject({
        paid: { minor: "1000" },
        remaining: { minor: "0" },
        status: "settled",
        version: 2,
      });
      await expect(
        service.payLoan(fixture.scope, created.loan.id, "loan-payment-lent-overflow", 2, {
          amount: { currency: "BRL", minor: "1" },
          occurredOn: "2030-02-02",
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      const events = await fixture.pool.query<{
        event_type: string;
        kinds: string[];
      }>(
        `SELECT e.event_type, array_agg(a.kind ORDER BY a.kind) AS kinds
           FROM ledger_event e
           JOIN ledger_entry le ON le.workspace_id = e.workspace_id AND le.event_id = e.id
           JOIN financial_account a ON a.workspace_id = le.workspace_id AND a.id = le.account_id
          WHERE e.workspace_id = $1 AND e.event_type LIKE 'loan.%'
          GROUP BY e.id, e.event_type
          ORDER BY e.created_at`,
        [fixture.workspaceId],
      );
      expect(events.rows).toEqual([
        { event_type: "loan.principal.lent.v1", kinds: ["loan_receivable", "wallet"] },
        { event_type: "loan.payment.received.v1", kinds: ["loan_receivable", "wallet"] },
        { event_type: "loan.payment.received.v1", kinds: ["loan_receivable", "wallet"] },
      ]);
      expect(events.rows.flatMap((row) => row.kinds)).not.toContain("income");
      expect(events.rows.flatMap((row) => row.kinds)).not.toContain("expense");
      const audit = await fixture.pool.query<{
        action: string;
        after_redacted: Record<string, unknown>;
      }>(
        `SELECT action, after_redacted
           FROM audit_event
          WHERE workspace_id = $1 AND target_type = 'loan_contract' AND target_id = $2
          ORDER BY occurred_at, id`,
        [fixture.workspaceId, created.loan.id],
      );
      expect(audit.rows.map((row) => row.action)).toEqual([
        "loan.created",
        "loan.payment",
        "loan.payment",
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain('"principal"');
    } finally {
      await fixture.close();
    }
  });

  integrationIt("serializes borrowed payments with optimistic version", async () => {
    const fixture = await createFixture();
    try {
      const service = new FinanceService(fixture.pool, { cursorSecret: "loan-integration-secret" });
      const created = await service.createLoan(
        fixture.scope,
        {
          direction: "borrowed",
          counterparty: "Banco doméstico",
          principal: { currency: "BRL", minor: "500" },
          occurredOn: "2030-01-10",
        },
        "loan-create-borrowed-001",
      );
      const results = await Promise.allSettled([
        service.payLoan(fixture.scope, created.loan.id, "loan-payment-borrowed-a", 0, {
          amount: { currency: "BRL", minor: "300" },
          occurredOn: "2030-01-20",
        }),
        service.payLoan(fixture.scope, created.loan.id, "loan-payment-borrowed-b", 0, {
          amount: { currency: "BRL", minor: "300" },
          occurredOn: "2030-01-20",
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const current = await service.getLoan(fixture.scope, created.loan.id);
      expect(current).toMatchObject({ paid: { minor: "300" }, remaining: { minor: "200" } });
      const event = await fixture.pool.query<{ event_type: string; kinds: string[] }>(
        `SELECT e.event_type, array_agg(a.kind ORDER BY a.kind) AS kinds
           FROM ledger_event e
           JOIN ledger_entry le ON le.workspace_id = e.workspace_id AND le.event_id = e.id
           JOIN financial_account a ON a.workspace_id = le.workspace_id AND a.id = le.account_id
          WHERE e.workspace_id = $1 AND e.event_type LIKE 'loan.%'
          GROUP BY e.id, e.event_type
          ORDER BY e.created_at`,
        [fixture.workspaceId],
      );
      expect(event.rows.map((row) => row.event_type)).toEqual([
        "loan.principal.borrowed.v1",
        "loan.payment.made.v1",
      ]);
      expect(event.rows.flatMap((row) => row.kinds)).not.toContain("income");
      expect(event.rows.flatMap((row) => row.kinds)).not.toContain("expense");
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture() {
  if (!adminUrl) throw new Error("DATABASE_URL_TEST is required");
  const adminPool = getDatabasePool({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `casei_loan_${suffix}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  let pool: ReturnType<typeof getDatabasePool> | undefined;
  try {
    await ensureApplicationRole(adminPool);
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    pool = getDatabasePool({ connectionString: databaseUrl.toString() });
    await migrate(createDatabase(pool), {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    const workspace = await pool.query<{ id: string }>(
      `INSERT INTO workspace (name) VALUES ('Casa IOU') RETURNING id`,
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) throw new Error("workspace was not created");
    const actorId = `loan-owner-${suffix}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Owner', $2, true)`,
      [actorId, `${actorId}@example.test`],
    );
    await pool.query(
      `INSERT INTO workspace_preference (workspace_id, currency_code, timezone)
       VALUES ($1, 'BRL', 'America/Fortaleza')`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO membership (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [workspaceId, actorId],
    );
    return {
      pool,
      workspaceId,
      scope: {
        workspaceId,
        actorId,
        role: "owner" as const,
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
      async close() {
        await pool?.end();
        await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await adminPool.end();
      },
    };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
    await adminPool.end();
    throw error;
  }
}
