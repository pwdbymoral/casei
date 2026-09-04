# Plano: MVP operacional do Casei

- Status: ativo — Gate 0 concluído; pronto para iniciar o Marco 1
- Spec associada: [MVP Casei](../../specs/mvp-casei.md)
- Arquitetura: [modelo de domínio do MVP](../../architecture/modelo-de-dominio-mvp.md)

## Objetivo

Entregar, em fatias verticais verificáveis, o núcleo doméstico e financeiro descrito nas specs do MVP, preservando isolamento, auditabilidade, ausência de dupla contagem e captura cotidiana de baixo atrito.

## Estado inicial

- Monorepo, PWA, API, contratos, pacote de domínio, boundary de banco, CI e imagens OCI existem.
- Há apenas contrato inicial de papéis `owner/member`; `viewer` e permissões completas ainda não existem.
- Banco, autenticação, módulos de negócio, jobs e jornadas autenticadas ainda não foram implementados.
- A homepage é uma apresentação estática de fundação; não há design system de produto validado no navegador.
- A spec de fundação ainda possui decisões abertas de autenticação/e-mail que este plano propõe resolver.

## Regra de execução por agentes

Cada item abaixo é uma unidade de PR por padrão. Um agente deve:

1. ler `AGENTS.md`, a spec vinculada, este plano e somente a arquitetura relevante;
2. declarar critério de aceite, arquivos previstos e dependências antes de editar;
3. atualizar primeiro spec/ADR quando descobrir decisão ausente; não decidir silenciosamente no código;
4. para comportamento testável, demonstrar Red pela razão esperada, implementar o mínimo e manter Green;
5. não alterar contratos de outra fatia sem coordenar com seu responsável;
6. executar teste focado, lint, typecheck e testes completos pertinentes; build/check segue as regras de ambiente do repositório;
7. registrar no PR requisitos atendidos, evidência, migração, impacto de segurança, screenshots/browser e limitações.

### Coordenação paralela

- Somente um agente por vez é dono de migrações em `packages/database`; os demais propõem contratos e aguardam a migração-base ou trabalham em write sets independentes.
- Mudanças em `packages/contracts/src/index.ts`, shell/navegação global, tokens CSS e configuração de autenticação exigem dono explícito para evitar merge concorrente.
- UI pode avançar com fixtures tipadas depois de contratos aprovados, mas não inventa responses. API pode avançar contra os mesmos contratos.
- Fatias do mesmo grupo paralelo só começam depois dos gates indicados e devem integrar uma por vez com `pnpm check` entre merges.
- Nenhuma tarefa posterior “corrige” regra de domínio por cálculo no cliente.

## Gate 0 — aprovação e decisões

- [x] **MVP-000 Aprovar produto:** revisar e confirmar as oito [decisões de produto](../../specs/mvp-casei.md#decisões-de-produto-aprovadas), terminologia, escopo e non-goals.
- [x] **MVP-001 Resolver drift documental:** marcar specs como vigentes, encerrar questões substituídas na spec de fundação e atualizar README/mapa de documentação.
- [x] **MVP-002 ADR ledger:** aprovar dupla entrada, reconhecimento, reversão e projeções; incluir exemplos canônicos e invariantes SQL com FK composta de moeda, checks e constraint trigger `DEFERRABLE INITIALLY DEFERRED` de soma zero.
- [x] **MVP-003 ADR operação:** decidir e-mail (`better-auth@1.6.22`, `nodemailer@9.0.5`), objeto temporário, executor de jobs e RLS/defesa em profundidade com versões, revalidação de jobs/downloads e documentação oficial.
- [x] **MVP-004 Mapa de jornadas:** produzir [wireflows de baixa fidelidade](../../ux/wireflows-mvp.md) para onboarding, captura rápida, fatura, import, lista de compras e admin; revisar por tarefa, não por estética.
- [x] **MVP-005 Contratos transversais:** aprovar [IDs, Money, datas civis, erro HTTP, paginação, idempotência, optimistic concurrency e eventos de auditoria](../../architecture/contratos-transversais-mvp.md).

**Saída do gate:** nenhum requisito material aberto; ADRs aprovadas; contratos e wireflows definidos; tarefas seguintes podem ser atribuídas sem decisão de produto local.

Gate concluído documentalmente em 2026-08-23, com as decisões de concorrência, revogação, outbox e invariantes SQL explicitadas nesta revisão. Os contratos serão materializados e testados em PLAT-001–004; ainda não há evidência de runtime nesta etapa exclusivamente documental.

## Marco 1 — plataforma segura e espaço compartilhado

Executar schema/base antes das fatias paralelas.

- [x] **PLAT-001 Schema base:** users/auth tables conforme `better-auth@1.6.22`, workspaces, memberships, preferences, audit, idempotency, `auth_email_intent`, outbox/jobs e constraints de escopo. Migration up/down, isolamento/RLS, auditoria append-only, role segura e versões pinadas são exercitados no teste PostgreSQL descartável do CI.
- [x] **PLAT-002 Kernel de domínio:** tipos opacos de ID, Money inteiro, LocalDate/fuso, relógio injetável, Result/errors e testes de propriedade. `packages/domain/src` implementa UUIDv7/ULID/UserId opacos, `Money` em `bigint` com JSON canônico e largest remainder, datas civis/fuso IANA/instante UTC com `Clock`, além de `Result`/erros seguros; `packages/domain/test/kernel.test.ts` cobre propriedades de conservação, round trip e rejeições de contrato.
- [x] **PLAT-003 Boundary HTTP:** `/v1` versionado, parsing Zod, envelopes de erro seguros, correlation ID ULID, auth actor/workspace scope, cursor opaco assinado e precondições de versão estão implementados em `apps/api/src/http/` e `packages/contracts/src/index.ts`; `apps/api/test/http-boundary.test.ts` cobre os status/envelopes, paginação e propagação de contexto.
- [x] **PLAT-004 Infra de comandos:** `@casei/database` fornece unit-of-work com contexto RLS, idempotência por hash canônico e chave escopada (incluindo replay de resposta `null`), outbox→job transacional e `PostgresJobWorker` com `FOR UPDATE SKIP LOCKED`, lease/compare-and-set, fencing antes/depois de cada lote/transição, backoff, retry/dead-letter e handlers em lotes transacionais. `job` preserva ator, espaço, capacidade e correlation ID; cada lote e transição bloqueia/revalida membership e capacidade. O bootstrap aceita `DATABASE_ROLE_GRANTEE` para conceder o role de aplicação a um login runtime não-superusuário. `packages/database/test/command-infra.test.ts` cobre replay, conflito, concorrência, outbox, role runtime, lease expirado/fencing e execução autorizada; a integração PostgreSQL do CI cobre locks/RLS e cenários descartáveis.
- [x] **AUTH-001 Identidade:** cadastro, verificação, login, logout, recuperação e sessões com testes de enumeração/rate limit; handler Better Auth 1.6.22 em `/api/auth/*`, CORS/trusted origins explícitos, port de e-mail capturável e adapter SMTP Nodemailer, intents/outbox criptografados com idempotência, callback allowlist, recovery de reset, expiração configurada, spool de recuperação persistente após falha de enqueue, leases renováveis com CAS, rate limit com proxies confiáveis e testes HTTP sem SMTP real cobrindo as jornadas críticas.
- [x] **AUTH-002 Onboarding:** criação idempotente de espaço/owner, moeda/fuso/saldo inicial opcional e retomada após falha. `IdentityService.createOnboarding` usa `executeIdempotent`, lock transacional estável por ator e a migration `0003_identity_workspaces` persiste o contexto do onboarding. FIN-002 materializa o saldo inicial imediatamente e de forma idempotente no ledger; nenhum cálculo financeiro lê a preferência diretamente.
- [x] **AUTH-003 Memberships:** convite com token armazenado somente como hash, reenvio que revoga o token anterior, expiração, aceite com e-mail correspondente, remoção e transferência de propriedade. A gestão PWA em Configurações lista membros/convites, cria/reenvia/revoga e entrega link copiável; toda criação grava intenção e `auth_email_outbox` criptografados na mesma transação, sem token/URL/e-mail em claro no armazenamento ou logs.
- [x] **AUTH-004 Autorização:** matriz owner/member/viewer, escopo server-side por `workspaceId`, membership lock em mutações, política RLS para memberships próprios e entitlement owner de recuperação; rotas não autorizadas não confiam no ID fornecido pelo cliente. Remoção, transferência, papel e desativação exigem `If-Match` e retornam `ETag`/412 em conflito.
- [x] **AUTH-005 Desativação do espaço:** confirmação do owner com autenticação recente, estado `deletion_pending`, entitlement de recuperação alcançável na sessão e PWA sem leitura de domínio, preservação/restauração seletiva de memberships, cancelamento de jobs/outbox, purge durável por workspace no dia 30, tombstone pseudonimizado com limite verificável de backup em 35 dias e retenção auditável até o dia 365. O worker standalone executa o reaper idempotente de tombstones e auditoria detached; `apps/api/test/identity-service.integration.test.ts` cobre concorrência de onboarding, outbox, retry, cutoff 29/30, guards de backup/restore e execução do worker no cutoff 365 quando `DATABASE_URL_TEST` está disponível.
- [x] **AUTH-006 Perfil e preferências:** API e PWA para editar nome/locale (`pt-BR` no MVP)/ocultação de valores e iniciar os fluxos nativos Better Auth de senha/e-mail com reverificação; owner edita nome, fuso IANA e margem de segurança do espaço com `If-Match`, prévia e bloqueio server-side de mudança de moeda após movimentos, carteira já materializada ou compromissos `planned`/`partially_settled`. Migrations `0004_profile_preferences` e `0005_audit_redacted_fields` têm companions down; contratos, RLS/autorização cruzada, locks de moeda/perfil, auditoria `before_redacted`/`after_redacted`, estados loading/error/offline/conflito e testes focados estão cobertos em `identity-routes`, `identity-service.integration`, `settings.test` e `database/test/schema` (a integração PostgreSQL roda quando `DATABASE_URL_TEST` está disponível).
- [x] **WEB-001 App shell:** layouts separados para experiência doméstica e administração, `WorkspaceAdapter` explícito, default de produção negando sessão, troca de espaço com reset de escopo, navegação mobile/desktop e estados loading/error/offline/permission/empty. A composição autenticada só é renderizada após guard server-side; AUTH-002..005 fornece agora o adapter real de sessão/troca/logout.
- [x] **WEB-002 Design primitives:** primitives oficiais Base UI/shadcn (Alert, Empty, Field, Input, Label, Dialog, Separator e Skeleton) e componentes de domínio `MoneyInput`, `StatusBadge` e `AsyncState`; parsing/caret monetário e estados de acesso cobertos por Vitest.
- [x] **WEB-003 Onboarding UI:** fluxo responsivo em três passos, moeda BRL/fuso visíveis, saldo opcional, retomada de rascunho local, validação com foco no resumo do primeiro erro e retry sem perder dados. O submit agora chama `/v1/onboarding` com chave de idempotência e preserva o rascunho em falhas.

Implementação web publicada no PR #16. O guard de produção não usa fixtures: sem um `WorkspaceAdapter` autenticado ou papel `platform_admin`, `/app` e `/admin` exibem somente estado de acesso negado. Fixtures permanecem disponíveis apenas para testes/componentes isolados.

A sessão autenticada propaga a moeda configurada em cada resumo de espaço até a captura e a apresentação financeira; sessões sem código válido falham fechadas. A troca de espaço invalida carregamentos e mutações pendentes, e fixtures financeiras particionam estado por workspace com replay de chave de criação.

AUTH-002..005 também conectam o guard server-side ao endpoint `/v1/me/workspaces`, o adapter de troca/logout ao boundary Better Auth e o onboarding ao comando idempotente `/v1/onboarding`. A validação de banco continua dependente do job PostgreSQL descartável do CI quando `DATABASE_URL_TEST` não estiver configurado localmente.

**Gate 1:** usuário autenticado cria/troca espaço; permissões são comprovadas no servidor; shell passa teclado, 320 px, tablet e desktop; nenhum dado cruza espaços.

## Marco 2 — carteira e transação simples

- [ ] **FIN-001 Ledger schema e domínio:** accounts, user transactions, events, entries, categorias, constraints de soma/escopo e guards de imutabilidade de evento publicado conforme ADR; testar insert/update/delete, alteração de cabeçalho e unpublish.
- [x] **FIN-002 Carteira:** saldo inicial materializado no onboarding, saldo atual canônico do ledger e conferência por saldo observado com prévia, motivo, idempotência, versão e auditoria. O ajuste publica somente o delta assinado entre `wallet` e `adjustment`; testes unitários, HTTP e PostgreSQL real cobrem conservação, replay e concorrência.
- [x] **FIN-003 CRUD transação simples API:** criar, listar, detalhar, editar por comando, liquidar, cancelar/reverter; idempotência e version conflict.
- [x] **FIN-004 Captura rápida UI:** despesa/receita com somente valor obrigatório, defaults explícitos, detalhes progressivos, feedback e desfazer por reversão auditável.
- [x] **FIN-005 Linha do tempo — base:** busca, período, filtros em URL, paginação incremental, detalhe básico e estados de carregamento/vazio/erro.
- [ ] **FIN-005b Histórico auditável:** detalhe com eventos de auditoria, origem, antes/depois sanitizado e consequências relacionadas.
- [ ] **FIN-006 Categorias:** defaults, criar/editar/arquivar e reclassificação em lote com prévia.

O PR #19 entrega o núcleo de ledger/contas, criação e listagem de transações, liquidação/reversão
auditável, categorias, idempotência, isolamento por papel e moeda, além dos contratos e guards
necessários. A fatia FIN-004/FIN-005 acrescenta captura rápida e linha do tempo autenticadas, com
filtros/cursor no contrato HTTP e desfazer por reversão. O FIN-002 materializa ajustes por saldo
observado com prévia, idempotência, concorrência e auditoria; o FIN-003 acrescenta edição e
cancelamento versionados, com bloqueios por origem e replay idempotente. Permanece pendente o
FIN-005b (histórico auditável detalhado) e a validação E2E do Gate 2.

**Gate 2:** saldo e resultado reconciliam com lançamentos; captura simples cumpre o caminho mínimo; editar/cancelar não perde histórico; E2E cobre receita, despesa, falha/retry e conflito.

## Marco 3 — compromissos, recorrências e parcelas

- [x] **PLAN-001 Planejado/liquidação parcial (backend):** vencimento, valor planejado/efetivo, atraso derivado e múltiplas liquidações com idempotência, versão e delta no ledger. A UI de compromissos permanece em PLAN-005.
- [x] **PLAN-002 Recurrence engine:** semanal/mensal/anual, variável/fixa, janela civil de 12 meses, meses curtos, pausa inclusiva, cancelamento auditável e job idempotente.
- [x] **PLAN-003 Edição de série:** somente esta, esta e futuras, futuras não liquidadas; preservar liquidadas e tratar exceções. Implementação consolidada em `origin/main` por `0857813`, com hardenings de `ca93488` já presentes na árvore vigente.
- [x] **PLAN-004 Installment engine:** distribuição exata de centavos, preview, edição e cancelamento futuro. Implementação consolidada em `origin/main` por `0857813`, com hardenings de `ca93488` já presentes na árvore vigente.
- [ ] **PLAN-005 UI de compromissos:** próximos, vencidos, confirmar valor variável, pagar/receber parcial e editar escopo.

**Gate 3:** relógio/fuso determinísticos; geração repetida não duplica; soma de parcelas é exata; histórico liquidado é imutável.

## Marco 4 — cartões e faturas

- [ ] **CARD-001 Cartão e ciclos:** cadastro, arquivamento, cálculo persistido de ciclos e limites de mês.
- [ ] **CARD-002 Compra/cartão:** compra à vista/parcelada gera despesa/passivo e associação idempotente à fatura sugerida.
- [x] **CARD-003 Fatura:** abrir, fechar, reabrir com confirmação, ajuste pós-fechamento, total e estados.
- [x] **CARD-004 Pagamento:** total, parcial, excedente/crédito e cancelamento como transferência ledger.
- [x] **CARD-005 Estorno/tarifas:** parcial/total e juros/tarifas manuais vinculados.
- [ ] **CARD-006 UI cartões/fatura:** visão por ciclo, composição explicável, ações frequentes e correção de fatura.

O mesmo PR entrega cadastro de cartão, compra, associação à fatura aberta, pagamento total/parcial,
parcelamento exato e recorrência com bloqueio explícito de ocorrência variável não confirmada. Fechamento,
reabertura, estorno em fatura fechada e as telas de cartão permanecem nas tarefas seguintes.

Uma fatia posterior acrescentou a composição explicável por compras/pagamentos e a reabertura explícita,
versionada e restrita a faturas fechadas sem pagamentos. A fatia CARD-003/005 agora também registra
ajustes pós-fechamento, tarifas/juros e estornos parciais ou totais vinculados à compra original,
preservando o lançamento original e emitindo reversão assinada no ledger. `CARD-006` permanece aberto
somente para a validação final de browser da visão completa por ciclo.

CARD-004 persiste cada pagamento com a parcela aplicada à fatura e, quando confirmado com
`allowCredit`, o excedente em `card_credit`. Créditos são consumidos atomicamente, em ordem FIFO,
por compras posteriores e ficam expostos na composição da fatura; a reversão de uma compra
restaura o crédito aplicado, e a reversão do pagamento cancela sua fonte e todas as aplicações,
reverte os lançamentos do ledger e registra auditoria; o saldo pago da fatura nunca inclui o excedente.

**Gate 4:** cenários compra → fechamento → pagamento reconciliam carteira, resultado e passivo sem dupla contagem; bordas de calendário, concorrência e estorno têm testes.

## Marco 5 — empréstimos e metas

Podem ser desenvolvidos em paralelo após Gate 2, desde que migrations sejam seriadas.

- [x] **LOAN-001 Empréstimo concedido/recebido (IOU simples):** contrato, contraparte, principal, data, vencimento opcional e eventos ledger sem renda/despesa.
- [x] **LOAN-002 Pagamentos (IOU simples):** pagamentos de principal parciais/totais, saldo/status, idempotência, versão e excedente rejeitado; juros, tarifas, baixa e perdão ficam fora do MVP.
- [x] **LOAN-003 UI empréstimos:** resumo de saldo, cronograma, registrar pagamento, histórico e previsão de quitação. A cobertura de componente valida saldo/cronograma/previsão/progresso/ação, histórico, permissões e vencimento ausente.
- [x] **GOAL-001 Subledger de reservas:** criar/editar/pausar/cancelar, allocate/release e cobertura (backend/API).
- [x] **GOAL-002 Gasto de meta:** transação vinculada e liberação atômica; completar parcial/total (backend/API).
- [x] **GOAL-003 UI metas:** captura simples, progresso, ritmo, reserva descoberta e simulação de contribuição.

**Gate 5:** empréstimo nunca vira renda/despesa de principal; meta nunca altera saldo por reservar; gastos vinculados reconciliam atomicamente.

## Marco 6 — estoque e compras domésticas

Pode iniciar após Gate 1 em contratos/UI, integrando vínculo financeiro somente após Gate 2.

- [x] **STOCK-001 Produto e unidade:** schema, nome normalizado, criação mínima, detalhes progressivos, arquivamento/restauração e regra de unidade.
- [x] **STOCK-002 Movimentações:** entrada/consumo/correção/descarte, não-negatividade, concorrência com lock/If-Match e histórico append-only.
- [x] **STOCK-003 Lista de compras:** derivação por mínimo/marcação, itens livres, deduplicação e colaboração.
  `shopping_auto` permite preferência por produto; a lista é materializada com unicidade parcial e
  eventos append-only na migration `0007_stock_shopping`. A API exige idempotência + `If-Match` para
  concluir item e só cria entrada no estoque quando `addToStock: true` é confirmado por item. A PWA
  oferece chips Lista/Faltando/Todos, itens livres e revisão de quantidade antes da confirmação.
  A fatia **STOCK-003a** substitui a paginação efetivamente limitada dos endpoints de
  produtos/movimentações por cursor opaco assinado, com teste de continuidade, limite e rejeição de
  cursor adulterado; a ordenação e o envelope publicados permanecem compatíveis.
- [x] **STOCK-004 Cadastro em lote:** parser de linhas/colagem, preview, modo válidas/tudo ou nada.
- [x] **STOCK-005 UI estoque:** busca, filtro de arquivados, lista touch, quick actions, histórico e estados loading/error/permission responsivos; modo avançado em tabela permanece para STOCK-004.
- [x] **STOCK-006 Concluir compra:** atualização explícita do estoque e vínculo opcional com despesa, sem automação oculta.
  `expenseTransactionId` referencia explicitamente uma despesa existente do mesmo espaço; não cria,
  escolhe nem distribui lançamentos financeiros automaticamente.

**Gate 6:** quantidade e histórico reconciliam; concorrência não duplica lista; jornada no mercado passa em telefone e teclado.

## Marco 7 — intercâmbio de dados

- [x] **DATA-001 ADR e adapters de arquivo:** `@casei/storage` define `ObjectStoragePort` e `FileScanPort`, implementa adapter S3-compatible com upload/download bounded em stream, SHA-256, expiração lógica até 24 horas, SSE-S3, chaves opacas geradas por namespace+UUID+random, MIME/magic validation e scanner de malware injetável; configuração `CASEI_OBJECT_STORAGE_*` é explícita (região obrigatória em produção), não publica credenciais ou URL bearer e sinaliza falha de cleanup para retry/reaper.
- [x] **DATA-002 Parser/mapeamento:** CSV/XLSX, encoding/locale, sugestão editável e perfis salvos. O pacote `@casei/data` oferece representação tabular comum, parser XLSX limitado e sem macros/links externos, mapeamento editável e perfil serializável sem arquivo original.
- [x] **DATA-003 Validação/preflight:** resultado por linha, fingerprints, política de duplicata e conflito de versão. O preflight aceita CSV/XLSX, mantém linhas físicas e classifica válidas, duplicatas sugeridas e erros antes da aplicação; conflito de versão permanece responsabilidade da aplicação DATA-004.
- [x] **DATA-004 Aplicação:** `ImportApplication` transforma linhas do preflight em comandos de domínio por meio de `ImportCommandPort`, com job versionado `data.import:1`, lotes transacionais, revalidação de ator/capacidade e expiração antes de cada lote, atomicidade por linha em `valid_only`, transação única do job em `all_or_nothing`, manifesto/digests revalidados contra a fonte, retry por chave estável, cancelamento cooperativo, resultados paginados e reversão auditável por linha. `PostgresImportStore` persiste cursor, contagens e resultados e `createImportWorker` registra o handler durável; storage binário e adapters de domínio permanecem injetados por DATA-001/FIN/STOCK.
- [x] **DATA-005 Export:** CSVs versionados, ZIP/manifesto/checksum, formula injection e streaming/proxy autorizado no download, sem URL presignada para export sensível. `@casei/data` oferece CSV e ZIP streaming com manifesto/checksum; jobs, storage e proxy permanecem no boundary de aplicação.
- [ ] **DATA-006 UI import/export:** a jornada web está implementada em PR separado; o boundary expõe contratos/rotas, preflight server-side e bootstrap persistente de export jobs/adapters de produção. A validação final da jornada web e a configuração operacional de storage/upload permanecem neste item.

**Gate 7:** arquivos maliciosos/maiores são rejeitados; reimport não duplica; export reimporta; acesso expirado ou de outro espaço falha sem vazamento.

## Marco 8 — painel, projeção e relatórios

- [ ] **INSIGHT-001 Read models:** agregados reconstruíveis de saldo, resultado, compromissos, faturas, reservas e estoque.
- [ ] **INSIGHT-002 Projeção 12 meses:** timeline de caixa com decomposição por eventos e desconhecidos explícitos.
- [ ] **INSIGHT-003 Valor seguro:** fórmula de 30 dias, margem, déficit, cobertura de reservas e níveis de confiança.
- [ ] **INSIGHT-004 Painel Hoje:** prioridade acionável, personalização, ocultar valores e deep links para origem.
  O incremento web atual já consome os read models de finanças/valor seguro, compromissos e fatura
  da janela de sete dias, metas e lista de compras; possui estados loading/error/offline/permission,
  ocultação visual de valores por sessão e links para a origem. Permanecem a persistência da
  personalização de cards e a composição de projeção/relatórios, que não fazem parte desta fatia.
- [ ] **INSIGHT-005 Relatórios:** mensal/categorias com tabela equivalente, filtros compartilhados e reconciliação com export.
- [ ] **INSIGHT-006 Simulações:** mudanças temporárias isoladas e aplicação explícita como planejamento.

**Gate 8:** todo total abre sua composição; read models podem ser reconstruídos; nenhuma compra/fatura ou reserva/saldo é contada duas vezes; baixa confiança é honesta.

## Marco 9 — administração e prontidão de beta

- [ ] **ADMIN-001 Papéis de plataforma/bootstrap:** primeiro admin por procedimento único, promoção posterior no console, proteção do último admin.
- [ ] **ADMIN-002 Console de contas:** busca e metadados mínimos, suspensão/reativação, sessões e reenvios.
- [ ] **ADMIN-003 Operação de jobs:** saúde, dead-letter, retry idempotente e correlation IDs sem conteúdo sensível.
- [ ] **ADMIN-004 Auditoria administrativa:** motivo obrigatório, filtros, retenção e step-up para ações críticas.
- [ ] **SEC-001 Threat model:** autenticação, isolamento, import, admin, PWA cache, logs e supply chain; resolver riscos altos.
- [ ] **SEC-002 Privacidade/operação:** termos aprovados quando aplicável, operacionalizar a política de retenção já aprovada (30/35/365 dias), exportação/exclusão do titular, backup/restore testado e runbooks.
- [ ] **QA-001 Matriz E2E:** jornadas críticas em mobile/desktop, dois usuários/dois espaços, calendário, falhas de rede e concorrência.
- [ ] **QA-002 Acessibilidade:** axe quando útil + teclado/foco/reflow/zoom/contraste/leitor de tela proporcional ao risco.
- [ ] **QA-003 Performance:** budgets aprovados para shell, listas, captura e dashboard; carga representativa de 50 mil linhas/import.
- [ ] **QA-004 Observabilidade:** dashboards/alertas sanitizados, SLO inicial e teste de falha/recovery de jobs.

**Gate 9 / Go-live:** `pnpm check`, build OCI, migração/rollback ensaiados, browser matrix aprovada, backup restaurado, nenhum risco alto aberto e specs/README/runbooks sincronizados.

## Matriz de rastreabilidade resumida

| Resultado | Tarefas principais | Evidência mínima |
| --- | --- | --- |
| Captura simples | FIN-003/004 | domínio + API + E2E cronometrado/contagem de passos |
| Isolamento e papéis | AUTH-003/004 | matriz de integração com IDs de outro espaço |
| Sem dupla contagem | FIN-001, CARD-002/004, GOAL-001/002 | property tests + reconciliação de cenários |
| Recorrência/parcelas | PLAN-002/003/004 | relógio controlado + calendários/property tests |
| Estoque simples | STOCK-001/002/003/005 | domínio + concorrência + browser mobile |
| Import/export | DATA-002–006 | corpus de arquivos + segurança + round trip |
| Decisão de gasto | INSIGHT-001–006 | fixtures reconciliadas + explicação E2E |
| Administração segura | ADMIN-001–004 | autorização negativa + auditoria + step-up |

## Riscos e mitigação

- **Escopo grande para um MVP:** gates entregam valor utilizável; beta interno pode iniciar no Gate 4 enquanto demais módulos avançam, sem chamar o produto inteiro de concluído.
- **Complexidade contábil oculta:** ledger imutável, exemplos canônicos, property tests e um único serviço de cálculo.
- **Datas e ciclos:** LocalDate/fuso no kernel, relógio injetável e corpus de fim de mês/ano bissexto/DST.
- **Concorrência de agentes:** donos explícitos de arquivos centrais, migrations seriadas e contratos integrados antes de UI/API paralelas.
- **Importação insegura:** storage temporário, prévia, limites, jobs idempotentes e aplicação pelos casos de uso.
- **Admin excessivamente poderoso:** metadados mínimos, separação de papéis, step-up e nenhum acesso implícito ao espaço.
- **Interface “simples” que esconde consequências:** progressive disclosure preserva defaults e prévias; ações compostas explicam efeito antes de confirmar.
- **Projeção com falsa precisão:** desconhecidos e confiança aparecem junto do valor; fórmula é aberta e navegável.

## Validação do planejamento

- Revisão cruzada de cada regra entre spec, modelo arquitetural e tarefa.
- Busca por termos conflitantes (`conta`, `carteira`, `saldo`, `pagamento`, `owner/member/viewer`).
- Verificação de todos os links Markdown.
- Revisão do diff para garantir que este trabalho alterou apenas documentação de planejamento.
- TDD não se aplica nesta etapa exclusivamente documental; a implementação seguirá o ciclo obrigatório descrito no repositório.

## Decisões durante o planejamento

- O responsável do produto aprovou integralmente as decisões propostas e as specs foram promovidas a vigentes em 2026-08-23.
- Carteira é única na experiência, enquanto contas contábeis internas preservam os invariantes.
- Compra de cartão reconhece despesa; pagamento de fatura é transferência.
- Metas são reservas virtuais, não carteiras adicionais.
- Estoque e finanças têm integração explícita e opcional, sem inferir itens a partir do valor de uma compra.
- Administração usa o mesmo PWA com boundary separado para reduzir operação sem misturar privilégios.
