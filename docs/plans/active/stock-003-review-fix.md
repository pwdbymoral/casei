# Plano: correção P1 da lista de compras do STOCK-003

- Status: concluído — PR de correção pendente de revisão/merge
- Spec associada: [estoque-domestico.md](../../specs/estoque-domestico.md#contrato-da-implementação-stock-003)

## Objetivo

Impedir efeitos colaterais em GET da lista de compras e preservar a decisão explícita de uma compra
automática sem entrada no estoque até que uma movimentação real altere o produto.

## Estado inicial

`StockService.listShoppingItems` chama `syncAutomaticShoppingItems`, inserindo itens e eventos
durante uma leitura. Após `addToStock=false`, a linha comprada continua permitindo nova inserção
automática em uma leitura posterior porque a unicidade só cobre itens não comprados.

## Abordagem

Sincronizar itens automáticos somente no final de comandos de escrita que alteram produtos, manter
GET sem INSERT/UPDATE/evento e considerar a compra automática suprimida enquanto o último
`purchased_at` não for anterior a uma movimentação posterior do produto. Não foi necessária nova
migration: a decisão é derivada de `shopping_item.purchased_at` e `stock_movement.occurred_at`.

## Etapas

- [x] Escrever regressões de GET viewer sem mutação e de compra sem reaparência.
- [x] Mover sincronização para escritas e derivar supressão pela última movimentação.
- [x] Atualizar spec e testes de contrato; não houve mudança necessária na fixture web.
- [x] Rodar lint, typecheck, testes e diff-check; commit/push/PR encadeado permanece como handoff.

## Rastreabilidade

Os testes de serviço verificam que a leitura não chama INSERT/evento e que a condição de supressão
compara `purchased_at` com `max(stock_movement.occurred_at)`; o teste de rota cobre conflito de
idempotência. A integração PostgreSQL deve confirmar concorrência quando o ambiente estiver disponível.

## Riscos

- Reaparecimento prematuro: a liberação consulta movimentação posterior ao instante da compra.
- Duplicação concorrente: a unicidade parcial existente e o `ON CONFLICT DO NOTHING` permanecem.
- Dados antigos: compras anteriores à mudança são suprimidas pelo mesmo timestamp; uma movimentação
  posterior libera a derivação automaticamente.

## Validação

- Suítes focadas API/web/database, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Integração PostgreSQL condicionada a `DATABASE_URL_TEST`.
