# Plano: hardening pós-revisão do estoque

## Requisitos

- Revalidar membership ativa e papel dentro de cada unidade de trabalho do `StockService`, com lock da linha de membership, sem confiar no papel resolvido antes da transação.
- Revogar explicitamente DML herdado nas tabelas de estoque antes dos grants mínimos e provar isso em testes de migration/integração.
- Fazer a chave de idempotência ser escopo da operação do cliente, permitindo que o mesmo comando seja repetido após perda de resposta sem criar outro efeito.
- Permitir consulta do último snapshot doméstico no modo offline, indicar o estado em cache e rejeitar mutações offline com `offline_required`; limpar snapshots na troca de espaço/logout.
- Padronizar a ordem de locks entre estoque e identidade: todas as memberships envolvidas em ordem determinística antes do workspace, inclusive em transferência de ownership e desativação.

## Critérios e validação

- Teste de serviço comprova lock/revalidação em leituras e mutações; integração PostgreSQL cobre papel revogado/trocado e corrida serializada quando `DATABASE_URL_TEST` estiver disponível.
- Teste estrutural e integração PostgreSQL demonstram `REVOKE DELETE, INSERT, UPDATE ON stock_product` e `REVOKE DELETE, INSERT, UPDATE ON stock_movement` antes dos grants mínimos, e que a role não consegue DELETE nem DML não concedido.
- Teste do adapter envia a mesma chave explícita em duas tentativas da mesma operação.
- Testes do adapter/UI cobrem snapshot cacheado, estado offline, mutação offline e limpeza de snapshot.
- Testes unitários verificam a ordem SQL membership → workspace; integração PostgreSQL exerce concorrência entre a operação de estoque e transferência/desativação quando `DATABASE_URL_TEST` estiver disponível.

Paginação, UI de detalhe de produto e o refinamento visual do rótulo da unidade `outra` permanecem fora desta correção e serão follow-up da fatia STOCK-005.

## Execução

1. Escrever regressões de autorização, grants, idempotência e offline.
2. Implementar as menores mudanças nos serviços, migration, adapter e tela.
3. Rodar testes focados, typecheck/lint e integração PostgreSQL quando configurada.
