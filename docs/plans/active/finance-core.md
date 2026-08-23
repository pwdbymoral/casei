# Plano: núcleo financeiro vertical

- Status: fatia implementada; hardening aplicado; integração/revisão pendentes
- Specs: [finanças](../../specs/financas.md), [cartões](../../specs/cartoes-de-credito.md), [metas e planejamento](../../specs/metas-e-planejamento.md)
- Arquitetura: [modelo de domínio](../../architecture/modelo-de-dominio-mvp.md) e [ADR do ledger](../../architecture/decisions/0004-livro-razao-financeiro.md)

## Entrega desta fatia

- [x] Contratos Zod de Money, transação, categoria, cartão, fatura, recorrência e parcelamento.
- [x] Kernel puro para balanceamento do ledger, distribuição exata de centavos, recorrência em calendário civil, ciclos de cartão, contribuição de meta e valor seguro.
- [x] Migration `0002_finance_core`: contas internas, categorias, transações, eventos/lançamentos imutáveis, recorrências/ocorrências, planos/parcelas, cartão/fatura/pagamento, FK composta de espaço/moeda, RLS e trigger diferido de soma zero.
- [x] Serviço API transacional com idempotência, unidade de trabalho, realização/cancelamento por versão e operações de compra no cartão/pagamento de fatura.
- [x] Hardening de revisão: todas as operações usam `casei_app` configurável; comandos têm escopos de idempotência distintos; papel/capacidade é validado no servidor; datas civis, fuso, moeda do espaço e categorias arquivadas/incompatíveis são rejeitados; mappers HTTP são camelCase.
- [x] Correções de invariantes: reversão atualiza fatura aberta atomicamente, faturas fechadas/pagas não mudam silenciosamente, recorrência variável não liquida sem confirmação, pagamentos cancelados são rejeitados e eventos/lançamentos publicados permanecem append-only.
- [x] Rotas `/v1/workspaces/:workspaceId/{transactions,categories,cards,recurrences,installments}` e pagamento de fatura, aguardando composição com o middleware de sessão/membership.
- [x] Testes de domínio/contrato e integração PostgreSQL cobrindo soma zero, parcelas, meses curtos, datas civis, role real e imutabilidade de eventos publicados.

## Limitações rastreáveis

Esta PR entrega o núcleo para destravar os gates financeiros, mas não declara FIN/PLAN/CARD completos. Permanecem tarefas posteriores sem decisão de negócio nova:

- `FIN`: conferência/ajuste de saldo com motivo, edição de metadado/categoria, cancelamento com auditoria pública, busca/cursor completo, defaults de categorias e UI de captura/linha do tempo.
- `PLAN`: liquidação parcial, janela móvel materializada por job, pausa/retomada e comandos de edição por escopo; a criação já materializa uma janela inicial idempotente e o domínio cobre datas/parcelas.
- `CARD`: listagem/detalhe de faturas, fechamento/reabertura, movimentação entre faturas abertas, estorno/tarifas e crédito excedente com reconciliação visual.
- `GOAL/INSIGHT`: persistência de metas/reservas, projeção/read models e UI ficam em fatias próprias; as funções puras de contribuição/valor seguro não persistem dados.
- UI e composição em `createApp` devem ser feitas depois que AUTH-004 fornecer o resolver de scope; esta PR não altera auth nem shell.

Esses itens são incompletudes de implementação, não escolhas de produto. Não criar CRUD genérico sobre o ledger: eventos publicados continuam append-only e qualquer correção deve usar reversão/substituição atômica.
