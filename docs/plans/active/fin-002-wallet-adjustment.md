# Plano ativo: FIN-002 carteira e ajuste de saldo

- Spec: [finanças](../../specs/financas.md#ajuste-de-saldo)
- Arquitetura: [modelo de domínio](../../architecture/modelo-de-dominio-mvp.md) e
  [ADR do ledger](../../architecture/decisions/0004-livro-razao-financeiro.md)
- Marco: `FIN-002` em [MVP Casei](mvp-casei.md)

## Objetivo e critérios

Entregar a carteira como leitura canônica do ledger e permitir que owner/member reconciliem um
saldo observado sem fabricar renda ou despesa.

- Saldo inicial positivo vira abertura idempotente; zero apenas conclui a inicialização.
- Saldo e diferença da conferência são calculados no servidor.
- Confirmação exige motivo, idempotência e a mesma versão apresentada na prévia.
- O ajuste publica somente o delta assinado entre `wallet` e `adjustment`, sem vínculos de consumo,
  cartão, recorrência ou parcela.
- Viewer não ajusta; workspace, moeda, lock, auditoria e retry permanecem isolados.
- A UI apresenta saldo calculado, saldo observado, diferença e consequência antes da confirmação.

## Entrega

1. Contratos de carteira, prévia e confirmação, mais regra pura de lançamentos do delta.
2. Versão da conta wallet derivada de lançamentos e materialização idempotente da abertura.
3. Serviço e rotas com lock, `If-Match`, idempotência, auditoria e isolamento.
4. Adapter e fluxo acessível/responsivo na tela de Finanças.
5. Testes de contrato, domínio, serviço, rota, adapter e schema; validações canônicas do repositório.

Hardening posterior: a migração `0018_wallet_publish_version` também versiona a carteira quando
um evento com lançamentos já existentes transita de `draft` para `published`; eventos inseridos já
publicados continuam usando o gatilho por lançamento da 0017, sem contar lançamentos `draft`.

## Evidência esperada

- Testes demonstram delta positivo e negativo, diferença zero, moeda incompatível, replay,
  versão concorrente, viewer e ausência de income/expense.
- Migration cobre marcador da abertura e avanço da versão da wallet.
- Browser percorre prévia, confirmação, erro e atualização do saldo em contexto estreito e amplo,
  ou a indisponibilidade concreta é registrada com validação alternativa.

## Evidência executada

- `pnpm lint`, `pnpm typecheck`, `pnpm test` e `pnpm build` passaram no worktree sincronizado.
- O teste `finance-wallet.integration.test.ts` passou contra PostgreSQL real isolado, incluindo
  abertura imediata, replay idempotente e duas confirmações concorrentes na mesma versão.
- Playwright percorreu diferenças negativa, positiva e zero, motivo obrigatório, confirmação e
  atualização do saldo em 390 × 844 e desktop; o console não apresentou erros da aplicação.
