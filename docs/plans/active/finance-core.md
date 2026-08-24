# Plano: núcleo financeiro vertical

- Status: fatia implementada; hardening aplicado; composição autenticada e revisão de integração em andamento
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
- [x] Incremento de fatura: composição ordenada de compras e pagamentos com cursor/limite estável e `hasMore`, reabertura explícita somente para fatura fechada sem pagamentos, conflito otimista com versão atual e recarregar/revisar na interface, além de confirmação acessível.

## Limitações rastreáveis

Esta PR entrega o núcleo para destravar os gates financeiros, mas não declara FIN/PLAN/CARD completos. Permanecem tarefas posteriores sem decisão de negócio nova:

- `FIN`: conferência/ajuste de saldo com motivo, edição de metadado/categoria, cancelamento com auditoria pública, busca/cursor completo, defaults de categorias e UI de captura/linha do tempo.
- `PLAN`: liquidação parcial, janela móvel materializada por job, pausa/retomada e comandos de edição por escopo; a criação já materializa uma janela inicial idempotente e o domínio cobre datas/parcelas.
- `CARD`: movimentação entre faturas abertas, ajuste pós-fechamento, estorno/tarifas e crédito excedente ainda permanecem; listagem, fechamento, composição e reabertura sem pagamentos já possuem API e interface.
- `GOAL/INSIGHT`: persistência de metas/reservas, projeção/read models e UI ficam em fatias próprias; as funções puras de contribuição/valor seguro não persistem dados.
- A UI financeira recebe `workspaceId` e `role` do shell autenticado; ela não escolhe escopo por `localStorage`, não concede papel padrão e desabilita escrita para `viewer`. Fixtures só ficam disponíveis com `CASEI_UI_FIXTURES=1`; sem origem explícita `NEXT_PUBLIC_CASEI_API_ORIGIN`, os adapters terminam em estado não autenticado.

Esses itens são incompletudes de implementação, não escolhas de produto. Não criar CRUD genérico sobre o ledger: eventos publicados continuam append-only e qualquer correção deve usar reversão/substituição atômica.

## Validação da composição

- `apps/api/test/finance-routes.test.ts` exerce o `createApp` exportado com `options.identity` + `finance`, verifica o actor autenticado e o role resolvido no scope antes de acessar cartões.
- `apps/web/src/lib/finance.test.ts` cobre origem canônica, fixtures explicitamente habilitadas, ausência de origem, roles `owner`/`member`/`viewer`, paginação e itens cancelados.
- `apps/web/src/lib/workspaces.test.ts` cobre a falha fechada do adapter de sessão sem origem configurada.
- Validações executadas nesta revisão: `pnpm test -- finance-routes.test.ts` em `apps/api`; `pnpm typecheck` em `apps/api`; `pnpm test -- finance.test.ts workspaces.test.ts` em `apps/web`; `pnpm typecheck` em `apps/web`.
