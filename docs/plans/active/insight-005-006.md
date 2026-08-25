# Plano: INSIGHT-005/006 — relatórios e simulações

- Status: ativo
- Specs: [metas e planejamento](../../specs/metas-e-planejamento.md) e [MVP Casei](../../specs/mvp-casei.md)

## Critérios de aceite

- Relatório mensal e por categoria usa os lançamentos publicados como fonte canônica, aceita os mesmos filtros de período, tipo e categoria e devolve totais reconciliáveis.
- A resposta explicita os filtros que podem ser reutilizados pela exportação de transações; a UI leva o mesmo período para a jornada de exportação.
- Simulações são cópias imutáveis dos dados do relatório: adicionar um evento hipotético altera somente a prévia e não chama mutação.
- Aplicar uma simulação é uma ação explícita e cria um compromisso planejado idempotente; cancelar/recarregar descarta a prévia.
- A interface apresenta estados de carregamento, vazio, erro, permissão e sucesso, funciona por teclado e reflowa em telas estreitas.

## Estratégia

1. Materializar contrato e testes de rota para relatório.
2. Agregar os dados no `InsightService` diretamente das tabelas canônicas, sem cache mutável.
3. Criar adapter e funções puras de simulação com testes de isolamento.
4. Entregar `/app/reports` com filtros na URL, tabelas mensais/categorias e painel de simulação.
5. Validar testes focados, lint, typecheck e build; registrar a limitação de browser se o MCP não estiver disponível.
