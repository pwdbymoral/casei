# Plano: INSIGHT-004 — painel Hoje acionável

- Status: concluído
- Spec associada: [metas e planejamento](../../specs/metas-e-planejamento.md)

## Objetivo

Manter o painel Hoje como ponto de decisão diário: mostrar saldo, valor seguro
ou déficit, compromissos, metas e itens faltantes com estados honestos e links
para a origem. Este incremento também cobre a interpretação do valor bruto
negativo retornado pelo read model.

## Estado inicial

`origin/main` já continha a composição web entregue no PR #54, incluindo
loading/error/offline/permission, dados parciais, ocultação de valores por
sessão e links de origem. A cobertura do componente não exercitava a renderização
dos estados de baixa confiança, déficit, ocultação e vazio/parcial.

## Abordagem

- Reutilizar `FinancialReadModel`, `SafeToSpendView`, adapters e helpers
  existentes; não criar uma segunda fonte de cálculo.
- Quando `available` é verdadeiro e `gross` é negativo, exibir o valor seguro
  (normalmente zero), explicar o déficit bruto e trocar o CTA para `Revisar
  déficit`.
- Preservar a ocultação visual por sessão também na explicação do déficit,
  mantendo nome acessível e valor disponível para tecnologia assistiva.
- Cobrir o componente com renderização estática, sem acoplar os testes a hooks
  ou detalhes de implementação.

## Etapas

- [x] Auditar a implementação existente e evitar reaplicar branches antigos.
- [x] Adicionar estado acionável para déficit projetado.
- [x] Testar baixa confiança, déficit, links, ocultação e dados parciais/vazios.
- [x] Atualizar o registro do plano e validar checks web.

## Rastreabilidade

O critério de que o painel prioriza itens acionáveis é exercitado pelos
compromissos e metas na composição existente e por `today-dashboard.test.ts`.
O cenário de déficit e a troca de CTA são cobertos em `app/page.test.tsx`,
assim como links para finanças, metas e estoque, ocultação acessível e estados
parcial/vazio. A implementação está em `apps/web/src/app/app/page.tsx`.

Persistência da personalização de cards e a tela de composição da projeção
continuam fora deste incremento, conforme a delimitação vigente da spec.

## Riscos

- Uma alteração futura no contrato pode confundir `safe` e `gross`; o teste
  mantém explícito que déficit é detectado somente pelo `gross` negativo.
- A validação browser/E2E depende de ambiente autenticado e permanece pendente
  quando o serviço não está disponível; a renderização estática reduz o risco
  de regressão sem alegar evidência de runtime.

## Validação

- `vitest run src/app/app/page.test.tsx`: 3 testes passaram.
- `git diff --check`: deve passar antes do commit.
- Lint, typecheck e build web devem ser executados na validação da branch/CI.

## Decisões durante a implementação

- O valor negativo foi tratado como déficit explicável, não como estado
  indisponível: o contrato separa `safe` (valor utilizável) de `gross` (resultado
  bruto), e a spec exige mostrar o déficit previsto.
