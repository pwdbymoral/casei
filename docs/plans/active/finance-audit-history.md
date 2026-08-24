# Plano: histórico auditável financeiro por transação

- Status: ativo
- Spec associada: [financas.md](../../specs/financas.md#captura-rápida-e-linha-do-tempo)

## Objetivo

Entregar uma leitura autenticada, paginada e isolada por espaço do histórico auditável de uma
transação, com detalhe de consequências do livro razão e apresentação acessível no detalhe da
transação.

## Estado inicial

O serviço lista e detalha transações, mas o detalhe não expõe auditoria. `audit_event` registra ação
e contexto, porém não possui snapshots redigidos; o cursor de transação existente não pode ser
reutilizado para ordenar eventos por `occurred_at`.

## Abordagem

Adicionar colunas JSONB para snapshots redigidos, registrar eventos de criação/realização/reversão
com allowlist, criar contratos e endpoints de lista/detalhe usando cursor assinado e escopo de
transação, e consumir ambos os endpoints no diálogo acessível da UI. Consequências serão somente
eventos do livro razão da mesma transação e espaço.

A migration usa o número `0009_finance_audit_history.sql`, após as migrations de identidade
(`0004`/`0005`) e estoque (`0006`–`0008`) na cadeia integrada do MVP. As colunas de snapshot já
são criadas por `0005`; esta migration apenas reforça os grants de auditoria.

## Etapas

- [ ] Atualizar spec/plano e criar testes red antes da implementação.
- [ ] Migrar o schema de auditoria e cobrir grants/colunas em teste estrutural e integração quando disponível.
- [ ] Implementar contratos, persistência, cursores e endpoints autenticados.
- [ ] Implementar adaptador HTTP/fixture e histórico no detalhe acessível da transação.
- [ ] Executar testes focados, lint, typecheck, build e validação de navegador quando disponível.
- [ ] Atualizar documentação vigente, commit, push e PR sem merge.

## Rastreabilidade

O critério de auditoria da spec será coberto pelos testes de cursor/isolamento no serviço e rotas,
pelos testes do adaptador e pelo fluxo do diálogo; o teste de schema confirma os campos redigidos e
a integração valida a leitura sob o role da aplicação quando `DATABASE_URL_TEST` existir.

## Riscos

- Vazamento entre espaços ou transações: toda leitura filtra workspace e target e verifica a transação antes do evento.
- Cursor manipulável: payload inclui ordenação/posição e é assinado com o segredo já usado pela timeline.
- Dados sensíveis em auditoria: snapshots são produzidos por allowlist, sem valor ou descrição.
- Ambiente sem PostgreSQL/browser: manter testes unitários/estruturais e registrar a validação ausente.

## Validação

- Testes Vitest de contratos, serviço, rotas e adaptador.
- Teste Node de migração/role, condicionado a `DATABASE_URL_TEST` para a integração.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` e Playwright para o diálogo, se o MCP estiver disponível.

## Decisões durante a implementação

- O detalhe inclui consequências somente do `ledger_event` vinculado à transação; não inventa uma
  relação com contas ou eventos de outras transações.
