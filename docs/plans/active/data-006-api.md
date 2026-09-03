# Plano: DATA-006 — boundary HTTP de intercâmbio

- Status: boundary HTTP e preflight server-side implementados; hardening pós-revisão publicado em branch corretiva; export job bootstrap persistente permanece pendente
- Spec: [intercâmbio de dados](../../specs/intercambio-de-dados.md)
- Relacionados: [DATA-001 storage](data-001-storage.md), [DATA-004 importação](data-004-import.md), [DATA-005 exportação](data-005-export.md)

## Objetivo

Expor, no mesmo contrato consumido pela UI DATA-006, as operações server-side de
prévia/upload de importação, criação/consulta de jobs e exportação. O boundary
deve preservar autenticação e escopo do workspace, aceitar multipart apenas na
entrada de arquivo, exigir idempotência nas mutações e não vazar URLs bearer.

## Escopo desta fatia

1. Contratos versionados de prévia e exportação, incluindo metadados necessários
   para confirmar uma prévia sem reprocessamento silencioso.
2. Ports de aplicação e rotas Hono para preview/start/status/retry/cancel e
   export list/create/status/download. O wiring aceita adapters explícitos; não
   inventa credenciais, comandos de domínio, worker ou storage global.
3. Parser/scan server-side por meio de `@casei/data` e `@casei/storage` em uma
   implementação injetável de preview/upload. A aplicação de linhas continua no
   `ImportApplication`/`ImportCommandPort` existente.
4. Testes de contrato, autenticação, limites, idempotência e expiração.

## Fora de escopo

- migrations novas;
- persistência de perfis de mapeamento;
- adapters implícitos para ledger/estoque ou credenciais S3;
- worker de exportação novo;
- URL presignada para download sensível.

## Critérios de aceitação

- [x] arquivo CSV/XLSX válido chega a uma prévia antes de criar job;
- [x] arquivo excessivo/formato rejeitado sem mutação;
- [x] confirmação inclui `previewHash`, manifesto, `sourceHash` e mapping version;
- [x] replay de idempotência com payload divergente permanece no store DATA-004;
- [x] todas as rotas passam por actor + workspace scope;
- [x] download delega ao adapter, que deve revalidar autorização/estado/expiração antes do stream;
- [x] ausência de bootstrap explícito retorna erro operacional claro, não 404;
- [x] rotas de import/export usam o prefixo `/data` consumido pelo adapter web;
- [x] multipart verifica limite anunciado antes do parser, limite agregado de
  arquivos/campos e limite de mapping;
- [x] `review` transporta linhas aceitas e rejeita confirmação que não cubra o
  manifesto de duplicatas;
- [x] status do job inclui erros de linhas; retry encaminha e persiste a chave,
  payload e resposta pelo mecanismo de idempotência; storage distingue
  ausente/expirado de indisponibilidade transitória;
- [ ] aplicação persistente de export jobs e wiring de produção.
