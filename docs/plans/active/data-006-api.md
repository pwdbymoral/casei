# Plano: DATA-006 — boundary HTTP de intercâmbio

- Status: boundary HTTP, preflight server-side e exportação persistente implementados; rollout depende de configurar storage compatível com S3 e do worker de exportação
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
   export list/create/status/download. O wiring aceita adapters explícitos e o
   processo padrão compõe o adapter PostgreSQL + storage S3 quando a configuração
   de deploy existe.
3. Parser/scan server-side por meio de `@casei/data` e `@casei/storage` em uma
   implementação injetável de preview/upload. A aplicação de linhas continua no
   `ImportApplication`/`ImportCommandPort` existente.
4. Testes de contrato, autenticação, limites, idempotência e expiração.

## Fora de escopo

- persistência de perfis de mapeamento;
- adapters de aplicação para outros domínios além das projeções mínimas de transações e produtos;
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
- [x] aplicação persistente de export jobs, projeções mínimas de transações/produtos, worker e wiring de produção;
  download registra auditoria, revalida escopo/estado/expiração e remove objetos quando o job expira ou é revogado.

## Operação

O processo HTTP compõe a exportação padrão apenas quando
`CASEI_OBJECT_STORAGE_BUCKET` está definido; em produção também exige
`CASEI_OBJECT_STORAGE_REGION`. O worker dedicado é executado com
`pnpm --filter @casei/api worker:export` (ou `worker:export:dev`) e usa as mesmas
variáveis `DATABASE_URL_WORKER`, `DATABASE_ROLE` e `CASEI_OBJECT_STORAGE_*`.
Sem storage configurado o endpoint responde `503` operacionalmente, evitando
que o processo suba com um adapter sem destino.
