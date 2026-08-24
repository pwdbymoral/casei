# Plano: edição e arquivamento de cartões de crédito

- Status: ativo
- Spec associada: [cartões de crédito](../../specs/cartoes-de-credito.md)

## Objetivo

Permitir que owner/member editem a configuração de um cartão existente com `If-Match` e
arquivem cartões sem saldo ou fatura aberta, preservando versionamento e impedindo novas compras.
Integrar ações mínimas à tela de finanças e manter fixtures e adapter HTTP coerentes.

## Estado inicial

O backend já cadastra/lista cartões e mantém `credit_card.archived`/`version`; a UI já cadastra e
lista cartões/faturas. Não existe comando de edição/arquivamento nem contrato de PATCH para cartão.

## Abordagem

- Estender contratos com atualização parcial e comando de arquivamento.
- Implementar comandos transacionais no `FinanceService`, bloqueando a linha do cartão, validando
  versão/moeda e recusando arquivamento com fatura aberta ou saldo pendente.
- Expor `PATCH /cards/:cardId` e `POST /cards/:cardId/archive`, ambos idempotentes e versionados.
- Atualizar adapter HTTP/fixture e integrar edição/arquivamento com dialog acessível na tela
  `/app/finances`, incluindo loading, erro de conflito, sucesso e permissão de viewer.

## Etapas

- [x] Contratos e testes Red para PATCH/arquivamento e invariantes de saldo.
- [x] Serviço/API com `If-Match`, idempotência, moeda e bloqueio de arquivamento.
- [x] Adapter/fixture e testes de integração da UI mínima.
- [ ] Validação de browser, responsividade, teclado, lint, typecheck, testes e build.

## Rastreabilidade

- Edição preserva campos omitidos e aceita `null` nos opcionais: contrato, serviço e adapter.
- Versão stale retorna `412`: rota e teste de API.
- Arquivamento com saldo/fatura aberta retorna conflito; sem vínculos relevantes incrementa versão:
  serviço e testes de API.
- Cartão arquivado deixa de ser opção de nova compra e aparece claramente arquivado: UI/fixture.

## Riscos

- Alterar datas pode afetar ciclos futuros; o comando altera somente a configuração do cartão, sem
  reescrever faturas existentes, conforme a spec.
- Corridas entre editar/arquivar e compra usam `FOR UPDATE` na linha do cartão e o fluxo existente
  de compra já bloqueia cartões arquivados.
- A tabela atual não possui os campos opcionais de marca/cor previstos na spec; esta fatia edita
  apenas os campos já persistidos (nome, datas, titular, últimos quatro e limite), sem criar
  migration fora do escopo.

## Validação

- Red→Green nos testes de contratos, serviço e rotas.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Browser em `/app/finances` com fixture: editar, erro de versão, arquivar bloqueado e arquivar
  permitido; teclado e larguras estreita/ampla.

## Decisões durante a implementação

- <A preencher somente se a evidência exigir refinamento da abordagem.>
