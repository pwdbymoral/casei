import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Loan, LoanPayment } from "@/lib/loans";

import { LoanCard } from "./loan-card";

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

const payment: LoanPayment = {
  id: "payment-1",
  loanId: loan.id,
  amount: { currency: "BRL", minor: "25000" },
  occurredOn: "2026-08-24",
};

function renderLoanCard(value: Loan = loan, payments: LoanPayment[] = [], writable = true) {
  return renderToStaticMarkup(
    <LoanCard
      loan={value}
      currency="BRL"
      today="2026-09-03"
      payments={payments}
      writable={writable}
      onPay={vi.fn()}
    />,
  );
}

describe("LoanCard", () => {
  it("shows balance, schedule, payoff forecast, progress and payment action", () => {
    const html = renderLoanCard();

    expect(html).toContain("A receber");
    expect(html).toContain("R$ 750,00");
    expect(html).toContain("Vence em");
    expect(html).toContain("Previsão de quitação");
    expect(html).toContain("Se pago integralmente");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("Registrar pagamento");
  });

  it("renders payment history in date order and keeps it readable without color", () => {
    const html = renderLoanCard(loan, [payment]);

    expect(html).toContain("Histórico");
    expect(html).toContain("Contrato registrado");
    expect(html).toContain("Pagamento de R$ 250,00");
    expect(html).toContain("24 de ago. de 2026");
  });

  it("does not expose a payment action to readers or settled contracts", () => {
    const readOnly = renderLoanCard(loan, [], false);
    expect(readOnly).toContain("acesso somente para leitura");
    expect(readOnly).not.toContain("Registrar pagamento");

    const settled = renderLoanCard({
      ...loan,
      paid: loan.principal,
      remaining: { currency: "BRL", minor: "0" },
      status: "settled",
    });
    expect(settled).toContain("Quitado");
    expect(settled).toContain("Nenhum pagamento pendente");
    expect(settled).not.toContain("Registrar pagamento");
  });

  it("explains the missing schedule instead of inventing a payoff date", () => {
    const html = renderLoanCard({ ...loan, dueOn: null });

    expect(html).toContain("Sem vencimento definido");
    expect(html).toContain("Defina um vencimento para acompanhar a previsão");
  });
});
