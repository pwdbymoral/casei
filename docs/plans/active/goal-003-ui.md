# Plano: GOAL-003 — UI de metas e planejamento simples

- Status: concluído
- Specs: [metas e planejamento](../../specs/metas-e-planejamento.md) e [MVP Casei](../../specs/mvp-casei.md)

## Objetivo

Completar a jornada web de metas com captura rápida, leitura de progresso e ritmo, alerta
explícito de reserva descoberta e simulação de contribuição sem persistência implícita,
consumindo exclusivamente o contrato do adapter de metas existente.

## Estado inicial

A API GOAL-001/002 e o adapter HTTP/fixture já expõem metas, movimentos, cobertura e cálculo
server-side de ritmo. A tela `/app/goals` já tinha a captura e as mutações principais, mas o
ritmo/simulação não possuíam uma camada pura testável, o fluxo tratava apenas 403 como falta de
permissão e não havia rastreabilidade própria para o incremento GOAL-003.

## Abordagem

Extrair os cálculos de apresentação/simulação para funções puras que operam nos campos reais de
`Goal`, mantendo valores em minor units e a regra de prazo do contrato. A tela usará essas funções
para mostrar orientação para prazo vencido, ritmo mensal e cenário temporário; nenhuma simulação
chamará mutação. Os estados assíncronos e o alerta de cobertura continuarão usando os primitives
existentes e os comandos existentes do adapter.

## Etapas

- [x] Definir critérios e funções puras para ritmo, simulação, captura e estado de acesso.
- [x] Implementar Red → Green e integrar a tela `/app/goals` aos helpers/contratos reais.
- [x] Atualizar rastreabilidade do MVP e documentar a limitação de validação em browser, se houver.
- [x] Executar testes, lint, typecheck, build e solicitar revisão independente antes do merge.

## Rastreabilidade

- Captura rápida: `createGoal` do `GoalsAdapter` e formulário de nome, alvo, prazo e prioridade.
- Progresso: `goalProgressPercent`, barra semântica e `Goal.target/reserved`.
- Ritmo: `Goal.contributionPeriodsRemaining/requiredContribution`, com orientação para ausência
  de prazo ou prazo vencido.
- Reserva descoberta: `Goal.uncovered`, confirmação explícita em `allocate` e alerta por meta.
- Simulação: helper puro de contribuição e diálogo sem chamada ao adapter.
- Estados loading/error/offline/permission/empty/success: `AsyncState` e fluxo da tela.

## Riscos

- Duplicar regras de domínio no browser: limitado à apresentação; a fonte do ritmo continua sendo
  a resposta da API e os helpers nunca persistem nem substituem validação server-side.
- Falsa sensação de saldo disponível em reserva descoberta: o alerta usa semântica explícita e não
  exibe o valor descoberto como dinheiro livre.
- Componente sem harness React instalado: testes de comportamento puro cobrem o cálculo e o
  adapter; validação visual/interativa fica dependente do Playwright MCP disponível.

## Validação

- Teste unitário focado em `pnpm --filter web test`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` e `git diff --check` na raiz.
- Browser MCP: tentativa em `http://localhost:3001/app/goals` ficou bloqueada porque a instância
  compartilhada do Chrome já estava em uso (`Browser is already in use`); o servidor foi encerrado
  sem deixar processo ativo.

## Decisões durante a implementação

- A simulação permanece somente uma prévia local: não existe no contrato GOAL-001/002 um endpoint
  de “aplicar contribuição planejada”, portanto o incremento não inventará response ou mutação.
