# Contratos transversais do MVP

- Status: vigente
- Specs relacionadas: [MVP](../specs/mvp-casei.md) e [identidade](../specs/identidade-e-administracao.md)
- Decisões relacionadas: [ledger](decisions/0004-livro-razao-financeiro.md), [jobs](decisions/0006-jobs-duraveis-no-postgresql.md) e [isolamento](decisions/0008-isolamento-por-espaco-e-rls.md)

## Objetivo

Fixar representações e comportamentos usados por todos os domínios para que API, web, worker, banco e testes não inventem formatos incompatíveis. Alteração neste documento é mudança de contrato e exige revisar consumidores, schemas Zod, migrations, exemplos e testes.

## Identificadores

- Entidades de domínio criadas pelo Casei usam UUIDv7 em lowercase e trafegam como string.
- `UserId` gerenciado pelo Better Auth é string opaca e não é validado como UUID pelo domínio.
- `CorrelationId` usa ULID em uppercase, gerado na primeira borda confiável e propagado por request, outbox, job e log.
- IDs nunca carregam autorização ou informação semântica.
- `workspaceId` pertence à rota e ao `WorkspaceScope`; se também vier no body, deve coincidir ou o request é rejeitado. Preferir omiti-lo do body.
- O cliente pode gerar `clientMutationId` UUID para correlação, mas isso não substitui `Idempotency-Key`.

O banco PostgreSQL 18 gera UUIDv7 quando a aplicação não precisa conhecer o ID antes do insert. Fixtures e comandos que exigem ID antecipado usam gerador compatível testado.

## Dinheiro

Representação JSON canônica:

```json
{
  "currency": "BRL",
  "minor": "12345"
}
```

- `minor` é string decimal inteira para evitar perda de precisão em JSON/JavaScript.
- Commands de valor digitado aceitam somente valor positivo entre `1` e `999999999999999` unidades menores. Saldos/responses derivados podem ser zero ou negativos dentro do mesmo limite absoluto.
- Domínio converte para `bigint`; PostgreSQL usa `bigint`; nenhum cálculo monetário usa `number`, float ou locale.
- O parser de UI converte texto localizado para centavos; formatação usa `Intl.NumberFormat` somente na borda de apresentação.
- Moeda faz parte de cada Money mesmo sendo única por espaço, impedindo soma acidental entre moedas.
- Arredondamento de divisão usa largest remainder determinístico: quociente base em todas as partes e centavos restantes nas primeiras posições ordenadas.

## Quantidade de estoque

Quantidade usa string decimal canônica com até três casas e limite absoluto `999999999999.999`. Domínio usa inteiro escalado pela precisão da unidade/movimento, nunca float. Quantidade e unidade viajam juntas quando fora do contexto de um produto.

## Datas, instantes e fuso

- `LocalDate`: string estrita `YYYY-MM-DD`, validada como data real; não é convertida para meia-noite UTC.
- `Instant`: ISO 8601 UTC com sufixo `Z` e precisão de milissegundos em responses.
- `TimeZone`: nome IANA validado no runtime; offsets como `-03:00` não são persistidos como fuso.
- “Hoje” é calculado pelo relógio injetado e fuso do espaço.
- Jobs guardam instantes UTC; regras mensais e vencimentos operam em LocalDate/fuso.
- `createdAt`/`updatedAt` são informativos; regras de concorrência usam `version`.

## Estados e enums

- Códigos canônicos usam `snake_case` em inglês e são estáveis no contrato.
- A UI traduz para linguagem natural em pt-BR e nunca exibe o código cru.
- Estado derivado, como `overdue`, é identificado no schema como derivado e não possui endpoint de escrita.
- Enum novo pode ser aditivo somente quando clientes antigos conseguem tratá-lo como `unknown`; caso contrário, exige versão de contrato.

## Envelope de sucesso

Recursos individuais retornam diretamente o recurso tipado. Listas retornam:

```json
{
  "items": [],
  "page": {
    "nextCursor": null,
    "hasMore": false
  }
}
```

- Cursor é opaco, assinado ou resistente a adulteração e inclui ordenação/posição, nunca autorização.
- Limite padrão é 50 e máximo 100; import/export usa jobs, não paginação pública de 50 mil itens.
- Ordenação possui desempate por ID e permanece estável durante a paginação dentro das limitações documentadas.

## Envelope de erro

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Revise os campos indicados.",
    "fieldErrors": {
      "amount.minor": ["Informe um valor maior que zero."]
    },
    "correlationId": "01..."
  }
}
```

- `message` é segura e localizada pela API para o locale solicitado quando houver catálogo; `code` dirige comportamento do cliente.
- `fieldErrors` usa paths do contrato e só aparece para erro de entrada.
- Nunca retorna stack, SQL, token, existência de conta ou detalhe de autorização.
- Códigos mínimos: `validation_failed`, `unauthenticated`, `not_found`, `permission_denied` somente quando não enumera recurso, `precondition_required`, `version_conflict`, `idempotency_conflict`, `rate_limited`, `offline_required`, `job_not_ready`, `internal_error`.

Mapeamento HTTP:

| Situação | Status |
| --- | --- |
| JSON/header malformado | 400 |
| Schema de campos ou regra de entrada inválida | 422 |
| Sem sessão | 401 |
| Recurso doméstico inexistente ou fora do espaço | 404 |
| Capacidade conhecida, mas papel insuficiente sem enumeração | 403 |
| `If-Match` obrigatório ausente | 428 |
| Versão diferente | 412 |
| Conflito de regra/estado atual | 409 |
| Rate limit | 429 com `Retry-After` |
| Falha inesperada | 500 com correlation ID |

## Idempotência

- Toda criação, realização, pagamento, reversão, convite, movimento, import e retry administrativo aceita `Idempotency-Key` ASCII entre 16 e 128 caracteres.
- Escopo da chave: ator + workspace quando aplicável + método + rota lógica.
- Servidor persiste hash canônico do request e response/status final por no mínimo 24 horas; mesma chave/request repete response, mesma chave/request diferente retorna `409 idempotency_conflict`.
- Requests concorrentes com a mesma chave aguardam/observam o mesmo resultado; não executam em paralelo.
- Constraints naturais protegem efeitos cuja vida supera a retenção da chave, como ocorrência de série e parcela.
- Erro de validação anterior à mutação não precisa ser cacheado; resultado ambíguo após início transacional precisa.

## Concorrência e precondições

- Recursos mutáveis expõem `version` inteiro crescente e `ETag: "v{version}"`.
- Editar, cancelar, arquivar e transições relevantes exigem `If-Match`; ausência retorna 428, divergência retorna 412 com representação atual segura.
- A UI oferece recarregar/revisar e preserva a intenção local; não repete automaticamente edição não comutativa.
- Incrementos comutativos ainda usam comando idempotente e lock/constraint; não fazem read-modify-write no cliente.
- Operações compostas usam uma transação; efeitos externos usam outbox depois do commit.

## Contrato de comando

Não existe `PATCH` irrestrito para agregados financeiros. Rotas expressam intenção, por exemplo:

- `POST /v1/workspaces/:workspaceId/transactions`
- `POST /v1/workspaces/:workspaceId/transactions/:id/post`
- `POST /v1/workspaces/:workspaceId/transactions/:id/reverse`
- `POST /v1/workspaces/:workspaceId/statements/:id/payments`
- `POST /v1/workspaces/:workspaceId/goals/:id/allocations`

Updates de metadados sem efeito composto podem usar `PATCH` com allowlist e `If-Match`. Nomes definitivos de rota são definidos na spec da fatia, mantendo estes verbos e invariantes.

## Eventos e jobs

Envelope interno versionado:

```json
{
  "eventId": "uuid-v7",
  "eventType": "transaction.posted.v1",
  "occurredAt": "2026-08-23T12:00:00.000Z",
  "workspaceId": "uuid-v7",
  "actorId": "opaque-user-id",
  "correlationId": "01...",
  "payload": {}
}
```

- Payload contém IDs e dados mínimos; não replica entidade inteira por conveniência.
- Consumidor desconhecido não pode descartar silenciosamente versão obrigatória.
- Job referencia evento/entidade e busca estado atual autorizado quando necessário.
- Evento de auditoria e evento de integração são conceitos separados, mesmo quando nascem do mesmo comando.

## Auditoria

Campos mínimos: ID, categoria doméstica/administrativa, ação, actor, workspace opcional, alvo/tipo, instante, origem, correlation ID, resultado e motivo quando obrigatório.

- Antes/depois guarda somente campos aprovados e redigidos; dinheiro, descrição, produto, e-mail completo, token e arquivo não entram por padrão.
- Autoria histórica usa ID e snapshot mínimo de nome; remoção do membro não apaga atribuição.
- Auditoria é append-only para a role da aplicação.

## Cache e offline

- Responses privadas usam política que impeça cache compartilhado; service worker não armazena payload financeiro por padrão.
- Shell e assets versionados podem ser cacheados.
- Snapshot doméstico offline, quando implementado na fatia de estoque, é explicitamente classificado, criptografado quando viável no storage do cliente e removido ao logout/troca de espaço.
- Mutação offline retorna estado local `not_saved`; não fabrica sucesso da API.

## Testes obrigatórios do contrato

- round trip de Money máximo, zero derivado, negativo derivado e rejeição de float;
- datas inválidas, fevereiro bissexto, fuso e virada civil;
- isolamento entre `UserId` opaco e UUIDs de domínio;
- mesma/diferente idempotency key sob concorrência;
- 428/412/409 com intenção local preservável;
- cursor adulterado e paginação com itens de mesmo timestamp;
- redaction de erro, log, evento, job e auditoria;
- compatibilidade de schema entre API e web em CI.

## Materialização no boundary HTTP

O boundary inicial da API está em `apps/api/src/http/` e é montado sob `/v1` por
`createApp`. Ele fornece parsing Zod de body/query, envelope seguro de erro,
`X-Correlation-ID` com ULID uppercase, resolução injetável de actor e
`WorkspaceScope`, cursores assinados e helpers de `If-Match`/`ETag`. A resolução
de sessão e membership permanece fora desta fatia: AUTH-001 injeta os
resolvers sem permitir que handlers escolham o actor ou o espaço a partir do
body. Rotas de workspace devem usar o ID da rota e podem chamar
`assertWorkspaceIdMatch` quando um contrato legado repetir esse campo.
