import type { Pool } from "@casei/database";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { configureFinanceRoutes } from "../src/finance-routes.js";
import {
  calculateWalletAdjustment,
  FinancePermissionError,
  FinanceService,
} from "../src/finance-service.js";
import { createActorMiddleware, createWorkspaceScopeMiddleware } from "../src/http/middleware.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const transactionId = "0190f3c8-2a10-7abc-8def-1234567890ac";

const scope = {
  workspaceId,
  actorId: "user-1",
  correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  role: "member" as const,
};

describe("wallet reconciliation", () => {
  it("calculates the signed difference from the canonical balance", () => {
    expect(calculateWalletAdjustment(1_000n, 1_350n)).toBe(350n);
    expect(calculateWalletAdjustment(1_000n, 750n)).toBe(-250n);
    expect(calculateWalletAdjustment(-200n, -50n)).toBe(150n);
  });

  it("rejects a viewer before opening an adjustment transaction", async () => {
    const service = new FinanceService({ connect: vi.fn() } as unknown as Pool);
    await expect(
      service.adjustWallet(
        { ...scope, role: "viewer" },
        {
          observedBalance: { currency: "BRL", minor: "1000" },
          reason: "Conferência",
        },
        "wallet-viewer-test-001",
        0,
      ),
    ).rejects.toBeInstanceOf(FinancePermissionError);
  });

  it("publishes only the negative delta with reason and the wallet version precondition", async () => {
    let walletReads = 0;
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const transactionRow = {
      id: transactionId,
      workspace_id: workspaceId,
      kind: "adjustment",
      state: "posted",
      amount_minor: "250",
      settled_minor: "250",
      currency_code: "BRL",
      occurred_on: "2026-08-25",
      due_on: null,
      posted_on: "2026-08-25T12:00:00.000Z",
      description: "Ajuste de saldo",
      category_id: null,
      card_id: null,
      statement_id: null,
      recurrence_id: null,
      installment_plan_id: null,
      version: 0,
    };
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        queries.push({ sql, values });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"')) {
          return { rowCount: 1, rows: [{ id: "idem-wallet" }] };
        }
        if (sql.includes("SELECT initial_balance_minor")) {
          return {
            rows: [
              {
                initial_balance_minor: "1000",
                initial_balance_materialized_at: "2026-08-25T10:00:00.000Z",
                initial_balance_transaction_id: "0190f3c8-2a10-7abc-8def-1234567890ad",
                currency_code: "BRL",
                timezone: "America/Fortaleza",
              },
            ],
          };
        }
        if (sql.includes("FROM financial_account") && sql.includes("kind = 'wallet'")) {
          walletReads += 1;
          return {
            rows: [
              {
                id: "0190f3c8-2a10-7abc-8def-1234567890ae",
                currency_code: "BRL",
                version: walletReads === 1 ? 3 : 4,
              },
            ],
          };
        }
        if (sql.includes("SELECT timezone FROM workspace_preference")) {
          return { rows: [{ timezone: "America/Fortaleza" }] };
        }
        if (sql.includes("coalesce(sum(entry.amount_minor)")) {
          return { rows: [{ balance_minor: walletReads === 1 ? "1000" : "750" }] };
        }
        if (sql.includes("INSERT INTO finance_transaction")) return { rows: [transactionRow] };
        if (sql.includes("INSERT INTO financial_account")) {
          const name = values?.[2];
          return {
            rows: [
              {
                id:
                  name === "Carteira"
                    ? "0190f3c8-2a10-7abc-8def-1234567890ae"
                    : "0190f3c8-2a10-7abc-8def-1234567890af",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO ledger_event")) {
          return { rows: [{ id: "0190f3c8-2a10-7abc-8def-1234567890b0" }] };
        }
        if (
          sql.includes("INSERT INTO ledger_entry") ||
          sql.includes("INSERT INTO audit_event") ||
          sql.includes('UPDATE "idempotency_key"')
        ) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as unknown as Pool, {
      clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
    });

    const result = await service.adjustWallet(
      scope,
      {
        observedBalance: { currency: "BRL", minor: "750" },
        reason: "Dinheiro contado em espécie",
      },
      "wallet-adjust-test-001",
      3,
    );

    expect(result.adjustment).toMatchObject({
      wallet: { balance: { currency: "BRL", minor: "750" }, version: 4 },
      difference: { currency: "BRL", minor: "-250" },
      transaction: {
        id: transactionId,
        kind: "adjustment",
        categoryId: null,
        cardId: null,
      },
    });
    const ledgerValues = queries
      .filter((query) => query.sql.includes("INSERT INTO ledger_entry"))
      .map((query) => query.values?.at(-1));
    expect(ledgerValues).toEqual([-250n, 250n]);
    expect(
      queries.find((query) => query.sql.includes("INSERT INTO audit_event"))?.values,
    ).toContain("Dinheiro contado em espécie");
    expect(queries.some((query) => /income|expense/.test(query.sql))).toBe(false);
  });

  it("requires the previewed version and idempotency headers at the HTTP boundary", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const fakeService = {
      getWallet: async (...args: unknown[]) => {
        calls.push({ method: "getWallet", args });
        return { workspaceId, balance: { currency: "BRL", minor: "1000" }, version: 3 };
      },
      previewWalletAdjustment: async (...args: unknown[]) => {
        calls.push({ method: "preview", args });
        return {
          wallet: { workspaceId, balance: { currency: "BRL", minor: "1000" }, version: 3 },
          observedBalance: { currency: "BRL", minor: "750" },
          difference: { currency: "BRL", minor: "-250" },
        };
      },
      adjustWallet: async (...args: unknown[]) => {
        calls.push({ method: "adjust", args });
        return {
          replayed: false,
          adjustment: {
            wallet: { workspaceId, balance: { currency: "BRL", minor: "750" }, version: 4 },
            observedBalance: { currency: "BRL", minor: "750" },
            difference: { currency: "BRL", minor: "-250" },
            transaction: { id: transactionId },
          },
        };
      },
    } as unknown as FinanceService;
    const actor = createActorMiddleware(async () => ({ userId: "user-1" }));
    const membership = createWorkspaceScopeMiddleware(async ({ actor: requestActor }) => ({
      actor: requestActor,
      workspaceId,
      role: "member" as const,
    }));
    const app = createApp((v1) =>
      configureFinanceRoutes(v1, {
        service: fakeService,
        scopeMiddleware: async (context, next) => {
          await actor(context, async () => {
            await membership(context, next);
          });
        },
      }),
    );

    const wallet = await app.request(`/v1/workspaces/${workspaceId}/wallet`);
    expect(wallet.status).toBe(200);
    expect(wallet.headers.get("etag")).toBe('"v3"');

    const preview = await app.request(`/v1/workspaces/${workspaceId}/wallet/adjustments/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ observedBalance: { currency: "BRL", minor: "750" } }),
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("etag")).toBe('"v3"');

    const missingHeaders = await app.request(`/v1/workspaces/${workspaceId}/wallet/adjustments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        observedBalance: { currency: "BRL", minor: "750" },
        reason: "Conferência",
      }),
    });
    expect(missingHeaders.status).toBe(422);

    const adjusted = await app.request(`/v1/workspaces/${workspaceId}/wallet/adjustments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "wallet-adjust-route-001",
        "if-match": '"v3"',
      },
      body: JSON.stringify({
        observedBalance: { currency: "BRL", minor: "750" },
        reason: "Conferência",
      }),
    });
    expect(adjusted.status).toBe(201);
    expect(adjusted.headers.get("etag")).toBe('"v4"');
    expect(calls.find((call) => call.method === "adjust")?.args.slice(1)).toEqual([
      {
        observedBalance: { currency: "BRL", minor: "750" },
        reason: "Conferência",
      },
      "wallet-adjust-route-001",
      3,
    ]);
  });
});
