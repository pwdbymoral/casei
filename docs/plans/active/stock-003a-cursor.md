# Plano: STOCK-003a — cursores assinados de estoque

- Status: implementação concluída; revisão independente pendente
- Spec associada: [estoque doméstico](../../specs/estoque-domestico.md)
- Contratos: [contratos transversais do MVP](../../architecture/contratos-transversais-mvp.md)

## Objetivo

Substituir a paginação efetivamente limitada por `LIMIT` nos endpoints de produtos e movimentações
por cursores opacos assinados, preservando a ordenação publicada e o envelope comum `{ items, page }`.
O cursor deve continuar a consulta após o último item, respeitar o limite 1–100 e rejeitar qualquer
cursor adulterado ou incompatível com a ordenação.

## Estado inicial

`paginationQuerySchema` já aceita `cursor`, mas `StockService.listProducts` ignora a posição e
retorna apenas um array, enquanto `listMovements` recebe somente `limit`. As rotas sempre devolvem
`nextCursor: null`, deixando o segundo lote inacessível. O helper HMAC `encodeCursor/decodeCursor`
já é usado por `GoalService` e não exige mudança de migration ou contrato central.

## Abordagem

Adicionar `cursorSecret` às opções do `StockService`, validar cursores com o helper assinado
existente e codificar somente posição/ordenação. Produtos usarão a chave publicada
`archived ASC, state rank ASC, lower(name) ASC, id ASC`; movimentações usarão
`occurred_at DESC, id DESC`. Cada consulta busca `limit + 1`, devolve no máximo `limit` e emite
cursor apenas quando houver próxima página. A rota passará a usar a página retornada, sem mudar
mutations ou migrations. Os adapters web continuarão consumindo `items` e poderão evoluir para
percorrer páginas em uma fatia posterior.

## Etapas

- [x] Escrever testes Red de serviço/HTTP para primeira página, continuidade, limite e adulteração.
- [x] Implementar cursores assinados e paginação SQL dos dois endpoints.
- [x] Atualizar testes existentes e documentação de rastreabilidade do MVP.
- [x] Executar validações focadas e completas, abrir PR e solicitar revisão independente.

## Rastreabilidade

- Continuidade: cursor contém a posição completa da ordenação e a consulta usa desempate por ID.
- Limite: `limit + 1` detecta `hasMore` sem retornar item extra.
- Adulteração: assinatura HMAC e `ordering`/shape validados; erro chega como cursor inválido.
- Contrato HTTP: rotas retornam envelope comum com `nextCursor` real.

## Riscos

- Precisão temporal em movimentações: a posição será preservada como texto ISO/timestamp e o ID
  desempata empates; não haverá conversão para `number`.
- Reuso de cursor em filtro diferente: cursor não autoriza acesso; a consulta continua protegida
  pelo workspace e o ordering validado. Filtros permanecem responsabilidade da chamada atual.

## Validação

- `pnpm --filter @casei/api test` e testes de rota focados.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` e `git diff --check`.
