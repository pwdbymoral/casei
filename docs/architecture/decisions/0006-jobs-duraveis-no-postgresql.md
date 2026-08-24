# ADR: jobs duráveis e outbox no PostgreSQL

- Status: aprovada
- Data: 2026-08-23
- Spec ou contexto relacionado: [modelo de domínio](../modelo-de-dominio-mvp.md) e [plano do MVP](../../plans/active/mvp-casei.md)

## Contexto

Recorrências, fechamento de faturas, e-mails, imports, exports e expiração de arquivos precisam sobreviver a restart e admitir retry sem duplicar efeitos. Redis ou broker dedicado aumentaria operação antes de existir volume que o justifique.

## Decisão

Persistir outbox e fila de jobs no PostgreSQL 18. Processos standalone produzidos no mesmo monorepo e imagem própria executam handlers compartilhados com a API (por exemplo, `worker:workspace` e `worker:recurrence`). A API nunca depende de worker no mesmo processo.

Cada job possui tipo versionado, payload mínimo, chave idempotente, estado, prioridade, tentativas, `availableAt`, lease com expiração, correlation ID e erro sanitizado. Workers selecionam jobs elegíveis em transação curta com row lock e `FOR UPDATE SKIP LOCKED`, registram lease e processam fora da transação de aquisição. Conclusão, retry e dead-letter usam compare-and-set do lease.

Backoff exponencial com jitter e máximo por tipo evita tempestade. Handlers são idempotentes e usam constraints naturais; “exactly once” não é prometido. Jobs mortos aparecem no console administrativo e só podem ser reexecutados após checagem de pré-condições.

O worker de e-mail aplica a mesma política: renova o lease em entregas longas, impõe timeout e move falhas que excedem o máximo para dead-letter. Enquanto PLAT-004 não puder adicionar um estado `dead` à tabela existente, o dead-letter de `auth_email_outbox` é representado por `state = 'failed'`, `last_error` sanitizado com prefixo operacional e `available_at` terminal; a reivindicação filtra esse sentinel, evitando reprocessamento infinito sem alterar migration.

Outbox é gravada na mesma transação do evento de domínio. Um dispatcher idempotente converte outbox em job e marca publicação. Limpeza e retenção preservam metadados necessários à auditoria, removendo payload sensível conforme política.

## Consequências

- Não há serviço adicional no MVP além do PostgreSQL e dos processos API/worker.
- Locks, tentativas e observabilidade precisam de testes de integração concorrentes em PostgreSQL real.
- Jobs longos devem renovar lease e processar em lotes limitados.
- Se volume/latência exceder a capacidade medida, o contrato de handler permite migrar o executor sem alterar domínios.

## Alternativas consideradas

- Timer no processo da API: perde trabalho em restart e duplica em múltiplas réplicas.
- Redis/BullMQ: bom ecossistema de filas, mas adiciona serviço e sincronização transacional com PostgreSQL.
- Broker externo: robusto em grande escala, porém custo operacional prematuro.
- Extensão PostgreSQL específica: reduz código, mas limita portabilidade e disponibilidade em instalações.

## Compatibilidade e migração

Tipos e payloads de job carregam versão. Deploy deve manter handlers compatíveis com jobs já persistidos durante a janela de rollout. Mudança incompatível exige migrador ou drenagem explícita. Referência: [locking explícito no PostgreSQL 18](https://www.postgresql.org/docs/18/explicit-locking.html).
