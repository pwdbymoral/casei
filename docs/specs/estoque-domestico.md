# Specification: estoque doméstico e lista de compras

- Status: vigente; subordinada às [decisões de produto do MVP](mvp-casei.md#decisões-de-produto-aprovadas)

## Contexto e objetivo

O estoque deve responder rapidamente “tem em casa?” e “o que falta comprar?” sem exigir controle industrial, unidade perfeita ou vínculo obrigatório com cada despesa.

## Produto e quantidade

Campos mínimos para criar: nome. Quantidade atual, unidade e mínimo desejado são opcionais no caminho simples.

- Nome é único entre produtos ativos do espaço após normalização de caixa e espaços; homônimos exigem qualificador explícito.
- Unidades MVP: unidade, pacote, caixa, kg, g, L, ml e `outra` com rótulo. Conversão automática entre unidades fica fora do MVP.
- Quantidades aceitam até três casas decimais e não ficam negativas. Tentativa de consumo maior que o estoque oferece ajustar para zero ou cancelar.
- Produto pode ser marcado manualmente como `Faltando` mesmo sem controle de quantidade.
- Estado derivado: `unknown` sem quantidade/marcação, `ok` acima do mínimo, `low` acima de zero e no/below mínimo, `missing` em zero ou marcado como faltando.
- Arquivar remove das listas ativas e preserva histórico; produto pode ser restaurado.

## Movimentações

Tipos: entrada, consumo, correção e descarte. Toda mudança de quantidade cria movimentação com autor, instante, quantidade anterior e posterior. Edição de movimentação recalcula a sequência de forma segura ou cria correção compensatória quando já houver eventos posteriores; nunca altera histórico silenciosamente.

Fluxo rápido em um produto oferece `+`, `−`, `Repor` e `Marcar faltando`, com alternativa textual e teclado. Quantidades frequentes podem usar defaults, sempre visíveis e reversíveis.

## Cadastro único, em lote e modo avançado

- Cadastro único começa por nome e oferece detalhes progressivos: quantidade, unidade, mínimo, categoria, local e nota.
- Cadastro em lote aceita uma linha por produto e também colagem tabular. A prévia separa novos, atualizações, duplicatas e erros antes de confirmar.
- O núcleo aceita nomes em linhas simples ou colagem TAB/semicolons com cabeçalho; a confirmação usa `POST /v1/workspaces/:workspaceId/stock/products/bulk` com `valid_only` ou `all_or_nothing` e o hash da prévia. Linhas inválidas nunca são aplicadas silenciosamente.
- Modo avançado usa tabela editável com navegação por teclado, seleção em lote, filtros e ações explícitas; nenhuma ação essencial depende de drag.
- Atualização em lote exige prévia quando altera quantidades ou arquiva produtos.

## Lista de compras

- Produtos `missing` ou `low` podem entrar automaticamente na lista conforme preferência do produto.
- Quantidade sugerida = máximo entre zero e mínimo desejado − quantidade atual; sem mínimo, a sugestão fica vazia.
- Itens livres que não existem no estoque são permitidos.
- Marcar item como comprado não altera estoque imediatamente sem confirmação; a ação oferece `Adicionar ao estoque` com quantidades editáveis.
- Uma despesa financeira pode ser vinculada a uma compra concluída, mas o vínculo é opcional e não distribui valor por produto no MVP.
- Várias pessoas podem marcar itens; alterações concorrentes não criam duplicatas e exibem autoria recente.

### Contrato da implementação STOCK-003

`GET /v1/workspaces/:workspaceId/stock/shopping` é uma leitura pura: não insere itens nem eventos,
inclusive para `viewer`. A leitura combina itens livres e automáticos materializados com uma projeção
dos produtos automáticos atualmente `missing` ou `low` que ainda não possuem uma linha em
`shopping_item`; essa projeção é somente leitura e usa o ID/version do produto para manter o
contrato de compra/`If-Match`. Entradas automáticas também são sincronizadas por comandos de escrita
que alteram o estado do produto, sem duplicar uma projeção já ativa. A chave normalizada do nome
possui unicidade parcial por espaço enquanto o item não estiver comprado; uma colisão concorrente
retorna o item já existente. `POST /stock/shopping/:itemId/purchased` exige `If-Match` e
`Idempotency-Key`. Seu corpo sempre explicita `addToStock`; somente `true` cria uma movimentação
`entry`, com quantidade positiva editável, na mesma transação que marca o item comprado e reprocessa
a sincronização automática. Quando um item automático é concluído com `addToStock: false`, ele não
reaparece enquanto não houver uma nova movimentação real no produto relacionado. Itens livres podem
ser concluídos, mas não podem criar movimentação de estoque. A migration `0007`
mantém eventos de lista append-only, RLS por espaço e constraints de fonte, unidade, quantidade e
estado comprado. Se um item livre já existente tiver o mesmo nome de um produto que se torna
`low`/`missing`, o comando do produto o reconcilia em uma única linha automática, preservando ID,
histórico e versão; enquanto o produto não for candidato, o item livre continua visível. Eventos
somente são removidos por cascade quando o workspace inteiro é purgado após a janela de recuperação.
Quando um produto é editado, uma linha automática ativa acompanha seu nome normalizado, unidade,
rótulo e versão. Se o novo nome colidir com um item livre ativo, a edição retorna conflito
recuperável antes de alterar o produto, pois o MVP não possui merge silencioso de linhas.

## Busca e uso no mercado

- Busca por nome tolera caixa e acentos e retorna primeiro faltantes/itens da lista.
- A lista de compras é operável com uma mão, preserva itens marcados durante a sessão e mantém controles com alvos confortáveis.
- O app informa claramente quando mostra dados em cache offline. Consulta pode funcionar com o último snapshot; adicionar ou marcar comprado exige conexão no MVP.

## Edge cases

- Unidade de produto com histórico não muda sem conversão explícita; no MVP, a alternativa é criar novo produto ou zerar e reiniciar com confirmação.
- Quantidade importada não substitui silenciosamente valor mais recente alterado depois do início do import.
- Duplicatas encontradas após concorrência retornam conflito recuperável.
- Arquivar categoria não arquiva produtos.
- Produto na lista continua acessível se for arquivado, com orientação para remover ou restaurar.
- Renomear um produto não pode criar duas entradas ativas para a mesma solicitação de compra:
  se o novo nome já estiver em um item livre ativo, a alteração é rejeitada com conflito
  recuperável; o usuário deve concluir/remover o item livre antes de renomear o produto.

## Critérios de aceitação

- [x] Produto pode ser criado somente com nome e enriquecido depois.
- [x] Toda alteração de quantidade possui histórico append-only e o estoque não fica negativo.
- [x] Estados de falta/baixo/ok correspondem às regras e não dependem só de cor.
- [ ] Cadastro em lote mostra prévia e não aplica linhas inválidas silenciosamente.
- [x] Lista automática e item livre convivem sem duplicação.
- [x] Concluir compra só altera estoque após confirmação explícita.
- [x] A leitura autenticada da lista não muta dados; compra automática sem entrada não reaparece até uma movimentação real.
- [x] Busca e lista permanecem utilizáveis em telefone e teclado, com alvos de toque e reflow responsivo; o modo avançado tabular fica para STOCK-004.
