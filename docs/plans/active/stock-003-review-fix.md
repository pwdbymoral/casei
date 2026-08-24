# Plano: correção P1 da lista de compras do STOCK-003

- Status: concluído — correções de concorrência e versão implementadas; revisão/merge pendentes
- Spec associada: [estoque-domestico.md](../../specs/estoque-domestico.md#contrato-da-implementação-stock-003)

## Objetivo

Impedir efeitos colaterais em GET da lista de compras, manter produtos automáticos visíveis mesmo
antes da materialização da linha e preservar a decisão explícita de uma compra sem entrada no
estoque até que uma movimentação real altere o produto.

## Estado inicial

`StockService.listShoppingItems` chamava `syncAutomaticShoppingItems`, inserindo itens e eventos
durante uma leitura. Além disso, produtos automáticos antigos ou criados fora do sincronizador não
tinham uma linha projetável até algum comando de escrita. Após `addToStock=false`, a linha comprada
continuava permitindo nova inserção automática em uma leitura posterior porque a unicidade só cobre
itens não comprados.

## Abordagem

Projetar produtos automáticos `low`/`missing` no GET sem INSERT/UPDATE/evento; materializar a
projeção apenas dentro da confirmação de compra. Sincronizar itens automáticos no final de comandos
de escrita que alteram produtos e, quando `addToStock=true`, também após a confirmação. A compra
sem entrada continua suprimida até uma movimentação posterior; a comparação estrita de
`purchased_at` com `max(stock_movement.occurred_at)` permite o movimento e a confirmação na mesma
transação sem empate suprimir o item. A sincronização grava a versão do produto em novas linhas e
invalida a versão de linhas automáticas ativas quando o produto muda. Se um item livre anterior
coincidir com um produto que se tornou `low`/`missing`, a linha é convertida em automática no
mesmo comando, preservando seu ID e histórico sem criar evento `created` artificial; enquanto o
produto não for candidato, o item livre continua visível. A FK dos eventos usa cascade apenas no
purge do workspace, preservando o log append-only durante a operação normal. A migration forward
`0008_stock_purge_cascade` atualiza esses FKs em ambientes que já executaram `0006`/`0007`.

## Etapas

- [x] Escrever regressões de GET viewer sem mutação e de compra sem reaparência.
- [x] Mover sincronização para escritas e derivar supressão pela última movimentação.
- [x] Invalidar versões automáticas ativas após alteração do produto e rejeitar `If-Match` antigo.
- [x] Atualizar spec e testes de contrato; não houve mudança necessária na fixture web.
- [x] Reconciliar item livre homônimo sem desaparecimento e permitir purge do workspace com eventos históricos.
- [x] Rodar lint, typecheck, testes e diff-check; commit/push/PR encadeado permanece como handoff.

## Rastreabilidade

Os testes de serviço verificam que a leitura não chama INSERT/evento e exercitam a sequência
GET→compra→GET→movimentação→GET, confirmação com entrada que permanece `low`, segunda compra
projetada suprimida e compra com `If-Match` antigo após duas alterações do produto; o teste de rota
cobre conflito de idempotência. A integração PostgreSQL deve confirmar concorrência quando o
ambiente estiver disponível.

## Riscos

- Reaparecimento prematuro: a liberação consulta movimentação posterior ao instante da compra.
- Duplicação concorrente: o produto é bloqueado antes da materialização e uma compra suprimida
  impede nova materialização até uma movimentação real.
- `If-Match` antigo em linha automática ativa: o resync atualiza a versão do produto e a compra
  também revalida a versão do produto sob lock.
- Dados antigos: compras anteriores à mudança são suprimidas pelo mesmo timestamp; uma movimentação
  posterior libera a derivação automaticamente.

## Validação

- Suítes focadas API/web/database, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Integração PostgreSQL condicionada a `DATABASE_URL_TEST`.
