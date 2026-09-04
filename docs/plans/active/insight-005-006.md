# Plano: INSIGHT-005/006 — relatórios e simulações

- Status: consolidado em `origin/main` (revisão 2026-09-04)
- Specs: [metas e planejamento](../../specs/metas-e-planejamento.md) e [MVP Casei](../../specs/mvp-casei.md)

## Critérios de aceite

- [x] Relatório mensal e por categoria usa os lançamentos publicados como fonte canônica, aceita os mesmos filtros de período, tipo e categoria e devolve totais reconciliáveis.
- [x] A resposta explicita os filtros que podem ser reutilizados pela exportação de transações; a UI leva o mesmo período para a jornada de exportação.
- [x] Simulações são cópias imutáveis dos dados do relatório: adicionar um evento hipotético altera somente a prévia e não chama mutação.
- [x] Aplicar uma simulação é uma ação explícita e cria um compromisso planejado idempotente; cancelar/recarregar descarta a prévia.
- [ ] A interface apresenta estados de carregamento, vazio, erro, permissão e sucesso, funciona por teclado e reflowa em telas estreitas.

## Consolidação

`origin/main` já contém a entrega funcional no commit `66f1b65` (`feat(insights): add reports and simulations`). A antiga `feat/insight-005-006` possuía dois conjuntos duplicados dos mesmos quatro commits, sem diferença de árvore em relação a esse commit squash; por isso nenhum commit de implementação foi reaplicado nesta branch.

Evidências preservadas no estado consolidado:

- `apps/api/test/insight-service.integration.test.ts` reconcilia totais, mês, categoria e descriptor de exportação contra o ledger publicado; os cenários PostgreSQL ficam condicionados a `DATABASE_URL_TEST`.
- `apps/api/test/finance-routes.test.ts` cobre os endpoints de relatório sob escopo de workspace.
- `apps/web/src/lib/reports.test.ts` cobre filtros compartilhados, isolamento da cópia simulada e chave estável de idempotência.
- `pnpm --filter @casei/api test -- insight-service finance-routes finance-contracts` e `pnpm --filter web test -- src/lib/reports.test.ts` passaram nesta revisão (265 testes API e 155 testes web no escopo executado).

A validação visual/interativa com Playwright MCP não estava disponível nesta execução. O item de interface permanece pendente até essa validação; a integração PostgreSQL também permanece pendente enquanto `DATABASE_URL_TEST` não estiver configurada.

## Estratégia

1. Materializar contrato e testes de rota para relatório.
2. Agregar os dados no `InsightService` diretamente das tabelas canônicas, sem cache mutável.
3. Criar adapter e funções puras de simulação com testes de isolamento.
4. Entregar `/app/reports` com filtros na URL, tabelas mensais/categorias e painel de simulação.
5. Validar testes focados, lint, typecheck e build; registrar a limitação de browser se o MCP não estiver disponível.
