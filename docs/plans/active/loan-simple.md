# Plano: LOAN-001/002 IOU simples

- Status: concluído
- Spec associada: [finanças](../../specs/financas.md)
- Plano macro: [MVP Casei](mvp-casei.md)

## Objetivo

Representar empréstimos pessoais concedidos ou recebidos como contratos de
principal, sem classificar o principal como renda ou despesa e sem duplicar o
efeito de caixa no ledger.

## Critérios de aceitação

- Criar contrato exige direção, contraparte, principal, data e vencimento
  opcional; moeda deve ser a do espaço e o contrato inicia `open`.
- Conceder publica `wallet → loan receivable`; receber publica
  `loan payable → wallet`; nenhum evento usa contas de receita/despesa.
- Pagamento parcial ou total exige valor positivo, não excede o saldo e publica
  somente o principal efetivo na direção inversa.
- O último pagamento deixa saldo zero e status `settled`; saldo nunca fica
  negativo.
- Criação e pagamento são idempotentes; pagamento usa `If-Match`/versão e
  locks para serializar concorrência.
- Auditoria registra origem, autor, correlação e snapshots sanitizados do
  contrato/pagamento.
- Juros, tarifas, baixa e perdão não têm campos nem comandos nesta fatia.

## Estratégia

1. Atualizar contratos e helpers puros de postings com testes Red/Green.
2. Criar tabelas de contrato/pagamento, constraints, FKs compostas, RLS e
   migration serializada após a base atual.
3. Implementar comandos transacionais no `FinanceService`, rotas e testes de
   isolamento/idempotência/ledger.
4. Atualizar documentação e checklist do MVP; UI ficará para LOAN-003.

## Validação

Domain/contratos, testes de schema e integração PostgreSQL devem cobrir as duas
direções, pagamentos parciais/totais, excedente, retry, concorrência, moeda,
RLS e ausência de contas income/expense nos eventos.

## Evidência da entrega

- Helpers de postings puros cobrem principal e pagamento nas duas direções.
- API cobre criação, listagem, detalhe e pagamento com idempotência/versão.
- PostgreSQL cobre migration `0012_loans`, FKs compostas, RLS, ledger,
  auditoria, retry, excedente e concorrência.
- UI fica deliberadamente em LOAN-003, sem inventar uma jornada visual antes
  do contrato estabilizar.
