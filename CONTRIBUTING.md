# Contribuindo para o Casei

Obrigado por contribuir. O Casei é desenvolvido com requisitos, contratos e validações versionados; mudanças devem preservar essa rastreabilidade.

## Antes de começar

1. Leia [AGENTS.md](AGENTS.md).
2. Leia a spec em [docs/specs/](docs/specs/) relacionada à mudança e as ADRs aplicáveis.
3. Para trabalho não trivial, consulte ou crie um plano em `docs/plans/active/`.
4. Instale as dependências com `pnpm install`.

## Fluxo de mudança

1. Atualize a spec quando o requisito ou comportamento observável mudar.
2. Crie uma branch curta e descritiva a partir de `main`, por exemplo `feat/financial-goals` ou `fix/inventory-quantity`.
3. Para comportamento testável, escreva o teste antes da implementação e confirme o estado Red.
4. Implemente a menor mudança que satisfaz a spec; mantenha documentação, contratos e exemplos sincronizados.
5. Execute `pnpm check` antes de abrir o pull request.
6. Abra um pull request com contexto, mudança observável, evidência de validação e limitações conhecidas.

## Pull requests

- Mantenha cada PR focado em um único resultado.
- Não envie segredos, variáveis de ambiente reais ou artefatos locais.
- Resolva todas as conversas antes do merge.
- Atualize testes e documentação que forem afetados.
- Use títulos objetivos, preferencialmente no formato Conventional Commits, como `feat: criar metas financeiras` ou `fix: validar quantidade de estoque`.

## Regras da `main`

A `main` não aceita pushes diretos, force-pushes ou deleção. Pull requests precisam estar atualizados com a base e concluir com sucesso:

- `quality`: auditoria de dependências, lint, typecheck, testes e build;
- `Analyze (javascript-typescript)`: análise de segurança CodeQL;
- `Dependency review`: bloqueia novas dependências com vulnerabilidades conhecidas de severidade alta ou crítica.

O merge é exclusivamente por squash e a branch é apagada após a integração.
