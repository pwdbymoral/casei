import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFixtureLoansAdapter,
  createHttpLoansAdapter,
  type Loan,
  loanProgressPercent,
  loansAdapterForEnvironment,
} from "./loans";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const loan: Loan = {
  id: "loan-1",
  workspaceId: "workspace-1",
  direction: "lent",
  counterparty: "Ana",
  principal: { currency: "BRL", minor: "100000" },
  paid: { currency: "BRL", minor: "25000" },
  remaining: { currency: "BRL", minor: "75000" },
  occurredOn: "2026-08-20",
  dueOn: "2026-09-20",
  status: "open",
  version: 1,
};

describe("loans adapter", () => {
  it("uses the authenticated adapter unless fixtures are explicitly enabled", () => {
    vi.stubEnv("CASEI_UI_FIXTURES", "");
    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "");
    expect(loansAdapterForEnvironment()).not.toBe(createFixtureLoansAdapter);
  });

  it("maps the loan list page and encodes the workspace", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(input).toBe("/v1/workspaces/work%20space/loans?limit=25");
      return Response.json({ items: [loan], page: { nextCursor: null, hasMore: false } });
    });
    const adapter = createHttpLoansAdapter({ fetch });

    await expect(adapter.listLoans("work space", { limit: 25 })).resolves.toEqual({
      items: [loan],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("creates a contract with an idempotency key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe("/v1/workspaces/workspace-1/loans");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("loan-create-1");
      expect(JSON.parse(String(init?.body))).toEqual({
        direction: "lent",
        counterparty: "Ana",
        principal: { currency: "BRL", minor: "100000" },
        occurredOn: "2026-08-20",
        dueOn: "2026-09-20",
      });
      return Response.json(loan, { status: 201 });
    });
    const adapter = createHttpLoansAdapter({ fetch });

    await expect(
      adapter.createLoan(
        "workspace-1",
        {
          direction: "lent",
          counterparty: "Ana",
          principal: { currency: "BRL", minor: "100000" },
          occurredOn: "2026-08-20",
          dueOn: "2026-09-20",
        },
        "loan-create-1",
      ),
    ).resolves.toEqual(loan);
  });

  it("posts a versioned payment and maps the updated balance", async () => {
    const response = {
      loan: {
        ...loan,
        paid: { currency: "BRL", minor: "50000" },
        remaining: { currency: "BRL", minor: "50000" },
        version: 2,
      },
      payment: {
        id: "payment-1",
        loanId: "loan-1",
        amount: { currency: "BRL", minor: "25000" },
        occurredOn: "2026-08-24",
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe("/v1/workspaces/workspace-1/loans/loan-1/payments");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe("loan-payment-1");
      expect(headers.get("If-Match")).toBe('"v1"');
      expect(JSON.parse(String(init?.body))).toEqual({
        amount: { currency: "BRL", minor: "25000" },
        occurredOn: "2026-08-24",
      });
      return Response.json(response);
    });
    const adapter = createHttpLoansAdapter({ fetch });

    await expect(
      adapter.payLoan(
        "workspace-1",
        loan,
        { amount: { currency: "BRL", minor: "25000" }, occurredOn: "2026-08-24" },
        "loan-payment-1",
      ),
    ).resolves.toEqual(response);
  });

  it("preserves API conflict details for stale payment versions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { error: { message: "O empréstimo foi alterado.", currentVersion: 3 } },
        { status: 412 },
      ),
    );
    const adapter = createHttpLoansAdapter({ fetch });

    await expect(
      adapter.payLoan("workspace-1", loan, { amount: loan.remaining }),
    ).rejects.toMatchObject({
      status: 412,
      currentVersion: 3,
      message: "O empréstimo foi alterado.",
    });
  });

  it("keeps fixture payments in the loan history and settles at the exact principal", async () => {
    const adapter = createFixtureLoansAdapter();
    const workspaceId = "loan-fixture-workspace";
    const created = await adapter.createLoan(workspaceId, {
      direction: "borrowed",
      counterparty: "Rafa",
      principal: { currency: "BRL", minor: "10000" },
      occurredOn: "2026-08-20",
    });
    const partial = await adapter.payLoan(
      workspaceId,
      created,
      { amount: { currency: "BRL", minor: "4000" }, occurredOn: "2026-08-21" },
      "fixture-payment-1",
    );
    const settled = await adapter.payLoan(
      workspaceId,
      partial.loan,
      { amount: { currency: "BRL", minor: "6000" }, occurredOn: "2026-08-22" },
      "fixture-payment-2",
    );

    expect(settled.loan).toMatchObject({
      paid: { minor: "10000" },
      remaining: { minor: "0" },
      status: "settled",
      version: 2,
    });
    await expect(adapter.listPayments(workspaceId, created.id)).resolves.toHaveLength(2);
    await expect(
      adapter.payLoan(
        workspaceId,
        partial.loan,
        { amount: { currency: "BRL", minor: "4000" } },
        "fixture-payment-1",
      ),
    ).resolves.toEqual(partial);
  });
});

describe("loan presentation helpers", () => {
  it("calculates progress without floating point or exceeding 100%", () => {
    expect(loanProgressPercent(loan)).toBe(25);
    expect(loanProgressPercent({ ...loan, paid: { currency: "BRL", minor: "100000" } })).toBe(100);
  });
});
