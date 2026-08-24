# INSIGHT-001/003 — read model financeiro e valor seguro

Status: em implementação

## Requisito

Entregar um read model financeiro reconstruível a partir das fontes canônicas do
workspace e um endpoint determinístico de valor seguro para gastar. A leitura
deve permanecer escopada ao workspace/ator e não pode depender de snapshot,
cache ou uma nova tabela de projeção.

## Critérios de aceitação

- Cada resposta reconstrói saldo, resultado, compromissos, faturas, reservas e
  sinais básicos de estoque dentro de uma única transação de leitura.
- A resposta é determinística para `asOf`, moeda e janela informados; o relógio
  e o fuso do workspace definem o `asOf` padrão.
- O valor seguro usa exatamente `max(0, saldo + entradas planejadas - saídas
  planejadas - reservas cobertas - margem de segurança)` e expõe o breakdown,
  o valor bruto e a confiança.
- Despesas de cartão não são subtraídas duas vezes: o cálculo usa somente o
  saldo aberto das faturas na janela como saída de caixa futura.
- Empréstimos em aberto com vencimento dentro da janela entram pelo saldo
  principal restante: concedidos aparecem como `loanReceivable`/entrada e
  recebidos como `loanPayable`/saída. O principal já lançado no ledger não é
  contado novamente como receita ou despesa.
- Reservas cobertas são limitadas ao saldo disponível e movimentos de reserva
  são agregados como append-only; dados inconsistentes não são mascarados.
- Ausência de evidência de saldo torna o indicador indisponível e explica uma
  ação; variáveis sem estimativa reduzem a confiança sem alterar silenciosamente
  a fórmula.
- Rotas protegidas ficam disponíveis em `/insights/financial` e
  `/insights/safe-to-spend`, com contratos versionáveis e datas civis.

## Dependências e limites

Esta fatia usa apenas colunas já presentes em `origin/main` e não cria
migration. Os PRs de recorrência (44) e cartões (46) não são necessários para o
contrato: recorrências são observadas por suas transações e faturas já possuem
saldo em aberto. Se um deles entrar antes da integração desta branch, a
sincronização deve ser um merge normal, preservando os dois conjuntos de
alterações.

A UI do indicador fica para a fatia de composição; esta entrega deixa o
contrato e a API prontos para um adaptador web.

## Rastreabilidade e validação

Os testes cobrem a fórmula, moeda/data, isolamento por workspace, reconstrução
sem dupla contagem de cartão, reservas, confiança e o contrato HTTP. Ao final
devem passar testes focados, lint e typecheck; a PR deve ser revisada por um
agente independente antes de qualquer merge.
