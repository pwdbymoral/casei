# FIN-003 — edição versionada de transações simples

- Status: em implementação
- Spec associada: [finanças](../../specs/financas.md)
- Plano macro: [MVP Casei](mvp-casei.md)

## Escopo desta fatia

Disponibilizar um comando de correção para transações simples da carteira,
com `If-Match`, idempotência e auditoria. A edição é deliberadamente fechada
para compras de cartão e ocorrências geradas por recorrência: esses registros
precisam recalcular uma fatura ou uma série inteira e terão comandos próprios.

Transações planejadas de carteira podem alterar valor, datas, descrição e
categoria. Transações já publicadas aceitam somente metadados (descrição e
categoria); valor e datas não são reescritos depois que eventos imutáveis foram
publicados. A categoria nova deve pertencer ao espaço, estar ativa e ser
compatível com o tipo da transação.

## Critérios de aceitação

- `PATCH /v1/workspaces/:workspaceId/transactions/:id` valida ao menos um
  campo, exige `Idempotency-Key` e `If-Match` e retorna `ETag` da nova versão.
- Retry com a mesma chave reproduz a resposta sem uma segunda auditoria ou
  mutação.
- Uma transação planejada de carteira pode corrigir valor/datas/metadados de
  forma atômica; moeda e datas inválidas são rejeitadas antes do `UPDATE`.
- Uma transação publicada rejeita alteração econômica, preservando o livro
  razão; alteração de metadados continua versionada e auditada.
- Cartão/fatura e recorrência são recusados com orientação explícita, sem
  alterar o registro.
- Parcelas são recusadas para preservar a soma do plano; sua edição terá
  comando próprio.
- Editar metadados de um lançamento histórico não exige reativar a categoria
  arquivada que já está vinculada a ele.
- Auditoria registra `transaction.updated` com snapshots redigidos e escopo
  do workspace.

## Validação

Os contratos, composição HTTP e serviço possuem testes focados para sucesso,
conflito de versão, bloqueio pós-publicação e idempotência. A integração
PostgreSQL existente deve confirmar as constraints e RLS no check completo.
