# Plano: STOCK-004 cadastro em lote

- Status: em andamento
- Spec: [estoque doméstico](../specs/estoque-domestico.md)
- Escopo: parser de linhas/colagem tabular, prévia e aplicação transacional pela API.

## Critérios de aceitação

- Uma linha simples representa um produto pelo nome; colagem tabular reconhece
  cabeçalho e os campos de produto suportados, preservando número da linha.
- A prévia classifica cada linha como `new`, `update`, `duplicate` ou `invalid`,
  incluindo erros acionáveis e mudanças previstas.
- Linhas duplicadas dentro do lote ou sem mudança efetiva não são aplicadas.
- `valid_only` aplica apenas novas/atualizações válidas; `all_or_nothing` não
  altera o estoque se existir qualquer erro ou duplicata.
- Atualizações de quantidade geram movimentação de correção append-only na
  mesma transação; criação com quantidade gera movimentação de entrada.
- Preview e confirmação são operações distintas; a confirmação exige o hash do
  conteúdo revisado, idempotência e revalida os produtos sob lock.

## Estratégia de validação

1. Testes de domínio começam em Red para parsing/classificação/políticas.
2. Testes de serviço usam pool controlado para verificar transação, histórico e
   separação de modos.
3. Testes de contrato HTTP verificam preview, hash, idempotência e resposta
   sem aplicação silenciosa de inválidos.
