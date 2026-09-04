# Plano: núcleo financeiro vertical

- Status: FIN-004/FIN-005, FIN-005b e PLAN-001 backend implementados; hardening aplicado; revisão agêntica em andamento
- Specs: [finanças](../../specs/financas.md), [cartões](../../specs/cartoes-de-credito.md), [metas e planejamento](../../specs/metas-e-planejamento.md)
- Arquitetura: [modelo de domínio](../../architecture/modelo-de-dominio-mvp.md) e [ADR do ledger](../../architecture/decisions/0004-livro-razao-financeiro.md)

## Entrega desta fatia

- [x] Contratos Zod de Money, transação, categoria, cartão, fatura, recorrência e parcelamento.
- [x] Kernel puro para balanceamento do ledger, distribuição exata de centavos, recorrência em calendário civil, ciclos de cartão, contribuição de meta e valor seguro.
- [x] Migration `0002_finance_core`: contas internas, categorias, transações, eventos/lançamentos imutáveis, recorrências/ocorrências, planos/parcelas, cartão/fatura/pagamento, FK composta de espaço/moeda, RLS e trigger diferido de soma zero.
- [x] Serviço API transacional com idempotência, unidade de trabalho, realização/cancelamento por versão e operações de compra no cartão/pagamento de fatura.
- [x] Hardening de revisão: todas as operações usam `casei_app` configurável; comandos têm escopos de idempotência distintos; papel/capacidade é validado no servidor; datas civis, fuso, moeda do espaço e categorias arquivadas/incompatíveis são rejeitados; mappers HTTP são camelCase.
- [x] Correções de invariantes: reversão atualiza fatura aberta atomicamente, faturas fechadas/pagas não mudam silenciosamente, recorrência variável não liquida sem confirmação, pagamentos cancelados são rejeitados e eventos/lançamentos publicados permanecem append-only.
- [x] Rotas `/v1/workspaces/:workspaceId/{transactions,categories,cards,recurrences,installments}` e pagamento de fatura, compostas no `createApp` com o actor autenticado e o scope/membership do AUTH-004.
- [x] Testes de domínio/contrato e integração PostgreSQL cobrindo soma zero, parcelas, meses curtos, datas civis, role real e imutabilidade de eventos publicados.
- [x] PLAN-001 backend: liquidação parcial com valor/data efetivos opcionais, `If-Match`, idempotência, transições de estado, delta por evento e reversão de todos os deltas.
- [x] Incremento de fatura: composição ordenada de compras e pagamentos com cursor/limite estável e `hasMore`, reabertura explícita somente para fatura fechada sem pagamentos, conflito otimista com versão atual e recarregar/revisar na interface, além de confirmação acessível.
- [x] FIN-004/FIN-005 base: captura rápida autenticada com defaults, moeda do espaço, feedback e desfazer por reversão; linha do tempo com busca, período, estado/tipo, filtros persistidos na URL, cursor assinado, carregamento incremental, estados e detalhe básico.
- [ ] FIN-005b: histórico auditável detalhado, com eventos, origem, antes/depois sanitizado e consequências relacionadas.

## Limitações rastreáveis

Esta PR entrega o núcleo para destravar os gates financeiros, mas não declara FIN/PLAN/CARD completos. Permanecem tarefas posteriores sem decisão de negócio nova:

- `FIN`: conferência/ajuste de saldo com motivo, edição de metadado/categoria, cancelamento com auditoria pública, histórico auditável detalhado e defaults de categorias.
- `PLAN`: janela móvel materializada por job, pausa/retomada, comandos de edição por escopo e UI de compromissos permanecem; PLAN-001 backend já liquida parcialmente, enquanto a criação já materializa uma janela inicial idempotente e o domínio cobre datas/parcelas.
- `CARD`: movimentação entre faturas abertas permanece; ajuste pós-fechamento, estorno/tarifas e
  crédito excedente já possuem comandos auditáveis, enquanto listagem, fechamento, composição e
  reabertura sem pagamentos já possuem API e interface.
- `GOAL/INSIGHT`: persistência de metas/reservas, projeção/read models e UI ficam em fatias próprias; as funções puras de contribuição/valor seguro não persistem dados.
- A UI financeira recebe `workspaceId` e `role` do shell autenticado; ela não escolhe escopo por `localStorage`, não concede papel padrão e desabilita escrita para `viewer`. Fixtures só ficam disponíveis com `CASEI_UI_FIXTURES=1`; sem origem explícita `NEXT_PUBLIC_CASEI_API_ORIGIN`, os adapters terminam em estado não autenticado.
- A migration `0010_plan_partial_settlement` segue estoque `0008` e auditoria `0009`; se a sequência de migrations mudar antes do merge, ela deve ser renumerada para o próximo número livre sem aplicar duas vezes nem descartar dados.
- O rollback de `0010_plan_partial_settlement` falha explicitamente se já houver múltiplos deltas parciais para a mesma transação; os eventos não são apagados nem mesclados para satisfazer a unicidade antiga. Nesse caso, preserve a migration aplicada ou faça uma migração de compensação explícita.

Esses itens são incompletudes de implementação, não escolhas de produto. Não criar CRUD genérico sobre o ledger: eventos publicados continuam append-only e qualquer correção deve usar reversão/substituição atômica.

## Validação da composição

- `apps/api/test/finance-routes.test.ts` exerce o `createApp` exportado com `options.identity` + `finance`, verifica o actor autenticado e o role resolvido no scope antes de acessar cartões.
- `apps/web/src/lib/finance.test.ts` cobre origem canônica, fixtures explicitamente habilitadas, ausência de origem, roles `owner`/`member`/`viewer`, paginação e itens cancelados.
- `apps/web/src/lib/finance.test.ts` também cobre serialização de filtros, preservação da query de timeline, concatenação de página e reversão usada pelo desfazer da captura rápida.
- `apps/web/src/lib/finance.test.ts` cobre captura em USD, isolamento por workspace, replay idempotente de fixtures, classificação explícita de receita/despesa/transferência/ajuste e descarte de mutação após troca de espaço.
- `apps/web/src/lib/workspaces.test.ts` cobre a falha fechada do adapter de sessão sem origem configurada e a rejeição de sessão sem moeda válida.
- Validações executadas nesta revisão: `pnpm lint`, `pnpm typecheck`, `pnpm test` e `pnpm build` no monorepo. A integração PostgreSQL `identity-service.integration.test.ts` permanece ignorada localmente porque `DATABASE_URL_TEST` não está configurada; CI deve executar o cenário descartável.
