# Plano: DATA-001 — storage temporário e validação de arquivos

- Status: implementação concluída; revisão independente pendente
- Spec associada: [intercâmbio de dados](../../specs/intercambio-de-dados.md)
- ADR: [armazenamento temporário compatível com S3](../../architecture/decisions/0007-armazenamento-temporario-de-objetos.md)
- Arquitetura: [núcleo de intercâmbio](../../architecture/intercambio-de-dados-csv.md)

## Objetivo

Entregar um port de object storage e um adapter S3-compatible que mantenham
arquivos temporários fora do PostgreSQL, transfiram upload/download em stream,
limitem o tamanho, validem hash e expiração e nunca emitam credenciais ou URL
bearer para o browser. A camada também oferece um port de varredura para que o
deploy injete um scanner de malware; o scanner de formato padrão rejeita MIME,
assinatura e bytes incompatíveis antes da confirmação do upload.

## Escopo e decisões já aprovadas

- O primeiro provider é o SDK oficial `@aws-sdk/client-s3`; endpoint, região,
  bucket, credenciais e `forcePathStyle` vêm de configuração explícita do
  ambiente, sem provider ou segredo inventado no código.
- A chave de objeto é opaca e validada, sem nome original, e o adapter grava
  apenas metadados operacionais mínimos (`sha256`, tamanho, formato e expiração).
  `createOpaqueStorageKey` gera `ambiente/workspace-uuid/job-uuid/random-uuid.ext`
  e chaves fora dessa gramática são rejeitadas, impedindo PII na chave.
- O TTL máximo é 24 horas, com expiração lógica revalidada em `head`/`get` e
  lifecycle de bucket permanecendo responsabilidade do deploy.
- O adapter aplica SSE-S3 (`AES256`) no upload e `Cache-Control: no-store`; o
  proxy autorizado e a revalidação de sessão/membership/job continuam no
  boundary DATA-004/DATA-006.
- Não há implementação de antivírus externo neste slice. `FileScanPort` é uma
  dependência explícita; o `FormatFileScanPort` apenas valida o formato seguro
  conhecido e não declara um arquivo limpo contra malware. A validação de XLSX
  reconhece a assinatura ZIP antes de considerar bytes NUL, que são normais em
  conteúdo binário.
- Falha ao remover um upload parcial não é absorvida: `cleanup_failed` sinaliza
  uma operação retryable e requer reaper/limpeza posterior.

## Etapas e rastreabilidade

- [x] Escrever testes Red para contrato, limites, hash, expiração, streaming,
  MIME/magic e falha do scanner.
- [x] Implementar `ObjectStoragePort`, `FileScanPort`, scanner de formato,
  adapter S3 e configuração de ambiente.
- [x] Documentar configuração operacional e manter DATA-004/DATA-006 sem
  adapter implícito.
- [x] Validar pacote e monorepo, abrir PR e solicitar revisão independente.

## Critérios de aceitação

- Upload aceita apenas chave/metadata válidos, tamanho até 10 MB (configurável),
  stream completo e hash SHA-256 correspondente; falha remove objeto parcial.
- Download retorna `ReadableStream` sem acumular o objeto, rejeita expirados e
  interrompe a entrega se o TTL expirar durante o consumo.
- Content-Type/formato e assinatura mínima são validados; scanner injetado pode
  rejeitar o objeto e o conteúdo não é confirmado.
- `head`, `get` e `delete` usam a mesma chave opaca e não retornam URL assinada.
- Configuração de produção exige bucket/região e credencial parcialmente
  preenchida é rejeitada; desenvolvimento pode usar região padrão, endpoint
  S3-compatible e `forcePathStyle` explicitamente.

## Validação

- `pnpm --filter @casei/storage test`
- `pnpm --filter @casei/storage typecheck`
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` e `git diff --check`
