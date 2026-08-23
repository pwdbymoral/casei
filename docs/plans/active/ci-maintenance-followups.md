# Plano: reduzir warnings e avaliar cache do CI

- Status: ativo
- Spec associada: não aplicável; manutenção operacional acompanhada pela [issue #8](https://github.com/pwdbymoral/casei/issues/8)

## Objetivo

Eliminar ou justificar os warnings de manutenção observados no CI e melhorar o cache somente quando houver benefício mensurável, sem alterar o comportamento da aplicação.

## Estado inicial

- A PR #7 deixou `quality`, `Analyze (javascript-typescript)`, `Dependency review` e `CodeQL` verdes.
- O Biome informa que `linter.rules.recommended` está deprecated.
- O Turbo informa que há tarefas sem outputs declarados para cache.
- O Next.js informa que o build cache não está configurado.
- Esses avisos não quebram o build atual e estão agrupados na [issue #8](https://github.com/pwdbymoral/casei/issues/8).

## Abordagem

Tratar cada aviso separadamente, começando por reproduzir sua origem e preservar o comportamento atual. Alterações de configuração só serão mantidas após validação local e no CI; não serão adicionados outputs ou caches especulativos.

## Etapas

- [ ] Reproduzir os três warnings e registrar os arquivos, tarefas e tempos afetados.
- [ ] Migrar a configuração do Biome para a API vigente e confirmar que as regras efetivas não mudaram.
- [ ] Inspecionar as tarefas do Turbo e declarar somente outputs reais, verificando que o cache não reutiliza artefatos incorretos.
- [ ] Medir o build sem cache e com cache do Next.js; configurar o cache apenas se o ganho justificar a complexidade e não introduzir dados sensíveis.
- [ ] Executar `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` e o workflow `quality`.
- [ ] Atualizar a issue #8 com evidências, fechar o que for resolvido e mover este plano para `completed/` apenas se seu valor histórico justificar retenção.

## Rastreabilidade

Os critérios de aceitação e a ordem de execução estão definidos na [issue #8](https://github.com/pwdbymoral/casei/issues/8). Cada alteração deve remover o warning correspondente ou registrar uma decisão explícita para mantê-lo, com validação de lint, tipos, testes e build.

## Riscos

- Uma migração do Biome pode alterar regras efetivas; comparar a configuração antes/depois e executar o lint completo.
- Outputs incorretos do Turbo podem servir artefatos obsoletos; declarar apenas diretórios produzidos pelas tarefas e validar uma execução limpa.
- Cache de build pode ocultar diferenças de ambiente ou armazenar dados indevidos; medir, revisar as chaves e manter o cache fora do caminho de artefatos de produção.

## Validação

- Os warnings alvo deixam de aparecer ou têm justificativa documentada.
- A instalação permanece reproduzível pelo lockfile.
- Lint, typecheck, testes, build e checks obrigatórios da branch continuam passando.
- Nenhuma permissão de workflow, dependência de produto, arquitetura, CD ou deploy é alterada.

## Decisões durante a implementação

- A issue #8 agrupa os três follow-ups porque são manutenção do mesmo pipeline, mas cada warning será investigado e validado independentemente.
