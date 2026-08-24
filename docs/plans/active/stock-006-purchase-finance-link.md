# Plano: STOCK-006 — vínculo explícito de compra com despesa

## Objetivo

Permitir que a conclusão de um item da lista de compras registre opcionalmente a despesa financeira
já existente, sem criar ou inferir transações e sem distribuir valor por produto.

## Critérios de aceitação

- Concluir sem `expenseTransactionId` mantém a jornada atual e não consulta finanças.
- Concluir com o ID grava uma referência no mesmo espaço, somente para despesa não cancelada.
- ID inexistente, de outro espaço, ou transação que não seja despesa retorna conflito sem alterar estoque,
  item ou histórico.
- A referência aparece em leituras e no evento append-only; retries são idempotentes.
- A referência não pode bloquear o purge autorizado do espaço.

## Tarefas e evidência

- [x] Contrato, coluna com FK composta e índice.
- [x] Validação transacional e evento de conclusão.
- [x] Adapter/fixtures e testes de ausência e vínculo explícito.
- [x] Documentação da regra e do purge.
- [ ] Revisão independente antes do merge.
