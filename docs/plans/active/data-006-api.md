# Plano: DATA-006 — boundary HTTP de intercâmbio

- Status: boundary HTTP, preflight server-side e hardening pós-revisão implementados; export job bootstrap persistente permanece pendente
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
- [x] `review` transporta as linhas aceitas, permite aceitar apenas parte das
  duplicatas sugeridas e registra as demais como ignoradas;
- [x] status do job inclui erros de linhas; retry encaminha e persiste a chave,
  payload e resposta pelo mecanismo de idempotência; storage distingue
  ausente/expirado de indisponibilidade transitória;
- [x] o handler de erros é composto por vertical e não sobrescreve contratos de
  Finance, Stock ou Identity quando DATA-006 está montado;
- [x] datas de filtros usam datas civis reais; IDs e versão de schema das
  exportações Casei permanecem disponíveis no mapeamento da prévia;
- [x] o preflight recebe consulta de fingerprints existentes escopada ao
  workspace e encaminha seleção explícita de planilha XLSX;
- [x] erros acionáveis de validação de storage retornam `422`, enquanto
  indisponibilidade e falhas de cleanup continuam `503`;
- [x] cancelamento e retry da UI enviam chaves de idempotência estáveis;
- [x] cancelamento server-side persiste a chave e o payload para replay/conflito;
- [x] jobs cancelados não exibem retry que o contrato do servidor rejeita;
- [ ] aplicação persistente de export jobs e wiring de produção.
