# Estratégia de testes e validação

Testes fornecem evidência de que requisitos e contratos são satisfeitos. Eles devem ser derivados da spec e validar comportamento, não reproduzir detalhes da implementação.

## TDD

TDD é obrigatório para lógica de negócio, bugs reproduzíveis, APIs, contratos e comportamentos observáveis que possam ser testados automaticamente:

1. derive um cenário dos critérios de aceitação;
2. escreva o teste e execute-o;
3. confirme que ele falha pela razão esperada (**Red**);
4. implemente a menor mudança correta (**Green**);
5. refatore sem alterar contratos e mantenha a suíte verde (**Refactor**);
6. execute a validação completa pertinente.

Um teste novo que já passa pode não exercitar o requisito. Investigue antes de prosseguir.

Para bugs reproduzíveis, confirme o comportamento especificado, reproduza o defeito e capture-o em um teste de regressão falho antes de corrigir. Depois, execute o teste, a suíte relacionada e o fluxo real quando aplicável.

As únicas exceções esperadas são mudanças exclusivamente documentais, alterações sem comportamento testável ou impossibilidade técnica razoavelmente demonstrável. Registre brevemente a razão e use outra validação adequada, como inspeção estrutural, build, type check, logs ou execução manual reproduzível.

## Integridade

Uma falha de teste não autoriza modificar o teste apenas para fazer a implementação passar. Quando teste e implementação divergirem, consulte primeiro a spec vigente:

- se o comportamento desejado mudou, atualize primeiro a spec e depois o teste;
- se a spec não mudou e o teste a representa corretamente, corrija a implementação;
- se o teste não representa a spec, corrija o teste e documente a evidência dessa conclusão.

Prefira testes comportamentais estáveis sob refactors. Use detalhes internos somente quando constituírem um contrato relevante. Não aceite snapshots, mocks ou expectativas atualizadas sem verificar que continuam representando o comportamento desejado.

## Níveis de teste

- Unitário: lógica isolada e combinações relevantes de entrada.
- Integração: contratos reais entre componentes.
- Contrato: boundaries, schemas e APIs.
- End-to-end: jornadas críticas do usuário.

Use o menor nível que forneça evidência suficiente. Não use E2E para tudo. Prefira uma integração real controlada a mocks quando ela aumentar substancialmente a confiança sem custo desproporcional. Playwright MCP auxilia exploração e validação no navegador, mas não substitui regressões automatizadas versionadas.

## Evidência e conclusão

Relate com precisão se algo foi inferido, observado, testado, confirmado em runtime ou documentado externamente. Não declare sucesso somente por inspeção quando uma validação prática estiver disponível. Evidência do estado atual deve revisar hipóteses factuais, mas não substituir a spec vigente sobre o comportamento desejado.

Para mudanças não triviais, deve ser possível relacionar cada requisito relevante ao critério de aceitação, ao teste ou validação que o comprova e à implementação correspondente, sem burocracia obrigatória para mudanças simples.

## Comandos do projeto

Requer Node.js 24 e pnpm 11.3.0. Execute da raiz do repositório:

- `pnpm format`: formata o código com Biome.
- `pnpm lint`: verifica formatação e regras estáticas com Biome.
- `pnpm typecheck`: verifica TypeScript em todos os workspaces.
- `pnpm test`: executa Vitest nos pacotes que possuem testes.
- `pnpm build`: gera a API e o PWA de produção.
- `pnpm check`: executa lint, typecheck, testes e build em sequência.
- `pnpm audit --prod --audit-level=high`: falha quando dependências de produção possuem vulnerabilidades de severidade alta ou crítica conhecidas.

Para validar a base PostgreSQL em um banco descartável, configure `DATABASE_URL_TEST` com uma conexão administrativa a PostgreSQL 18 e execute `pnpm --filter @casei/database test`. Os testes criam bancos temporários, aplicam as migrations, verificam role/RLS, isolamento entre dois espaços, auditoria append-only, unit of work, idempotência (incluindo concorrência), outbox→job e worker com lease/revalidação; o rollback usa o companion `packages/database/drizzle/0000_ambitious_madrox.down.sql`. Cada banco é removido ao terminar. O job `quality` do CI fornece PostgreSQL 18 e configura essa variável automaticamente; sem ela, os testes de integração não alteram nenhum banco local.

O teste `apps/api/test/identity-service.integration.test.ts` usa a mesma variável para validar a jornada AUTH-002–005 contra PostgreSQL real: lock de onboarding com chaves distintas, outbox de convite sem bearer token, RLS do entitlement de recuperação, restauração seletiva de memberships, retry após perda de resposta, cutoff nos dias 29/30, execução do worker e tombstone. O processo `pnpm --filter @casei/api worker:workspace` é um worker standalone durável; o supervisor do deploy deve mantê-lo como processo separado da API.

A infraestrutura de comandos fica em `@casei/database`: `withUnitOfWork` configura o contexto RLS por transação, `executeIdempotent` persiste hash canônico e resposta final, `enqueueOutboxEvent`/`dispatchOutbox` fazem publicação transacional e `PostgresJobWorker` adquire lease com `SKIP LOCKED`, executa lotes em transações separadas, revalida membership/capacidade antes de transições e grava retry/dead-letter por compare-and-set. Handlers devem usar `context.runBatch` para que cada lote adquira novamente o lock de membership; não há promessa de exactly-once.

O bootstrap de migration usa `DATABASE_URL_MIGRATION` (administrativa) quando configurada, separada de `DATABASE_URL` do runtime, para criar/verificar `DATABASE_ROLE` (por padrão `casei_app`) e aplicar migrations. A role de aplicação permanece sem `SUPERUSER`/`BYPASSRLS` e sem propriedade das tabelas. Quando API/worker usam um login separado, configure `DATABASE_ROLE_GRANTEE` para que `ensureApplicationRole` execute um `GRANT` explícito; esse grantee também precisa ser um login não-superusuário sem `BYPASSRLS`. O runtime então pode executar `SET LOCAL ROLE casei_app` por transação sem depender de conexão superusuária. A integração PostgreSQL cobre essa conexão real de runtime.

No GitHub, o workflow `Dependency review` executa em pull requests e bloqueia a adição de dependências com vulnerabilidades conhecidas de severidade alta ou crítica. Ele exige que o recurso **Dependency graph** esteja habilitado nas configurações de segurança do repositório e é obrigatório para merge na `main`.

O workflow `CodeQL` executa o job obrigatório `Analyze (javascript-typescript)`. Além desse gate de execução, o ruleset `CodeQL merge protection` exige resultados de code scanning para a `main` e bloqueia alertas de code scanning classificados como erro ou alertas de segurança `high` ou superiores. O ruleset não possui bypass configurado.

Para PostgreSQL local, execute `docker compose up -d postgres`. A imagem de produção do PWA é construída com `docker build -f Dockerfile.web -t casei-web .`.

## AUTH-002..005

`apps/api/test/identity-routes.test.ts` cobre o boundary de autenticação, a exigência de sessão e a
chave de idempotência do onboarding. `apps/web/src/lib/workspaces.test.ts` cobre o adapter real,
troca somente para espaços autorizados e conversão de sessão expirada em estado não autenticado.
Os cenários que exigem RLS, locks de membership, trigger de owner, expiração de convite e purge
devem rodar no PostgreSQL descartável do CI junto da migration `0003_identity_workspaces.sql`.

## Identidade

Os testes de AUTH-001 executam o handler Better Auth 1.6.22 contra o adapter de memória e um
`CaptureTransactionalEmailPort`; nenhum teste abre conexão SMTP. A integração cobre cadastro,
verificação (inclusive callback relativo padrão), login, logout, recuperação, revogação/listagem
de sessões, callback externo, rate limit, hash de token, falha/recovery e reprocessamento
idempotente da outbox. A API apenas grava a intent/outbox; `pnpm --filter @casei/api worker` é o
processo separado que faz claim com lease, entrega e retry dos e-mails persistidos. Em produção,
`SMTP_HOST`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE=true` e
`BETTER_AUTH_SECRET` são obrigatórios; o adapter Nodemailer exige TLS autenticado e falha no
startup com diagnóstico sanitizado quando a configuração está incompleta. Os testes também
cobrem sink de falha de enqueue (inclusive a rejeição absorvida pelo Better Auth), recuperação
após restart por spool criptografado persistente, transição atômica de intent/outbox, renovação de
lease para todos os itens do lote, rejeição de transições com lease vencido, timeout, backoff,
máximo de tentativas e dead-letter terminal. Também cobrem configuração fail-closed de IP quando
nenhum proxy confiável está declarado e validação de CIDRs configurados. A execução de produção
requer `pnpm --filter @casei/api build` antes de `worker`; para desenvolvimento use `worker:dev`.
