# Constituição de engenharia

Este arquivo é o mapa operacional do repositório. Leia apenas o contexto necessário e mantenha os detalhes nas fontes especializadas em [`docs/`](docs/README.md).

## Ordem de trabalho

1. Leia este arquivo.
2. Leia a specification relacionada em `docs/specs/`.
3. Consulte somente a arquitetura e as decisões diretamente relevantes.
4. Para trabalho não trivial, leia ou crie o plano ativo correspondente.
5. Inspecione testes e código afetados.
6. Siga `Requirement → Spec → Plan → Tasks → Tests → Implementation → Validation → Documentation`.

Não use `Prompt → Code → documentação retroativa`. Resolva ambiguidades capazes de alterar comportamento, contrato público, segurança, arquitetura ou dados antes de implementar.

## Fonte de verdade e drift

Uma solicitação explícita do usuário altera o comportamento desejado. Incorpore-a primeiro à spec vigente; então a spec passa a ser a fonte canônica para implementação e testes.

Após essa incorporação, use esta precedência:

1. specification vigente;
2. decisões arquiteturais aprovadas;
3. contratos públicos, schemas e interfaces;
4. testes automatizados válidos;
5. implementação;
6. documentação auxiliar e comentários.

Quando essas camadas divergirem, identifique o drift e corrija a fonte apropriada; não escolha silenciosamente a camada mais conveniente. Código, teste ou documentação existente não é automaticamente correto.

## Independência analítica e evidência

**A intenção do usuário é autoridade sobre o produto; as hipóteses do usuário não são autoridade sobre a realidade técnica.** Trate instruções sobre comportamento desejado como requisitos e explicações técnicas como hipóteses a investigar.

Runtime, testes, logs, browser e código existente evidenciam o que o sistema faz agora; documentação oficial evidencia dependências e plataformas. Essa evidência deve derrubar hipóteses factuais, não requisitos aprovados. Quando contrariar a hipótese ou o plano inicial, revise-os em vez de racionalizar a evidência. Diferencie claramente o que foi especificado, observado, testado, inferido, assumido ou permanece desconhecido.

Uma validação bem-sucedida não invalida silenciosamente uma falha anterior em outro ambiente. Investigue evidências conflitantes entre local, CI, runtime, testes ou browser; identifique e resolva a diferença quando prático ou registre a incerteza residual, o risco e o próximo meio de investigação. A evidência mais conveniente não substitui a contraditória.

## Specs, planos e rastreabilidade

Specs definem comportamento observável e critérios objetivos de aceitação; não descrevem retrospectivamente o código. Use [`docs/specs/_template.md`](docs/specs/_template.md) sem preencher seções inaplicáveis ou inventar requisitos.

Mudanças pequenas podem usar um plano breve. Para trabalho complexo, multi-arquivo, arquitetural, arriscado ou longo, mantenha um plano em `docs/plans/active/` com base no [`template`](docs/plans/_template.md); mova-o para `completed/` somente quando seu valor histórico justificar retenção.

Em alterações não triviais, preserve a ligação conceitual `Requirement → Acceptance Criterion → Test → Implementation`. IDs formais são opcionais; a evidência que valida cada requisito relevante deve permanecer clara.

## Desenvolvimento e testes

Para comportamento testável, siga `Spec → Acceptance Criteria → Failing Test → Minimal Implementation → Passing Test → Refactor → Full Validation`.

TDD é obrigatório para lógica de negócio, bugs reproduzíveis, APIs, contratos e comportamentos observáveis que possam ser testados automaticamente. Confirme o Red pela razão esperada, implemente o mínimo correto no Green e refatore mantendo os testes verdes.

As exceções limitam-se a mudanças exclusivamente documentais, ausência de comportamento testável ou impossibilidade técnica razoavelmente demonstrável. Registre brevemente a razão e execute outra validação adequada.

Uma falha não autoriza modificar um teste válido apenas para fazer a implementação passar. Consulte primeiro a spec: se ela mudou, atualize spec e teste; caso contrário, corrija a implementação. Consulte a estratégia completa em [`docs/testing/README.md`](docs/testing/README.md).

## Revisão agêntica

Antes do merge de mudança produzida por agente, use um agente que não tenha sido o autor para executar a skill [`agentic-code-review`](.agents/skills/agentic-code-review/SKILL.md). A revisão é inicialmente read-only e realiza duas passagens: conformidade entre requisito, spec, testes, implementação e documentação; depois análise adversarial independente. O revisor registra achados priorizados e evidenciados, sem corrigir a própria revisão, aprovar ou fazer merge salvo autorização separada.

## Validação, ferramentas e documentação

Não declare algo corrigido, funcionando, implementado ou concluído por mera inspeção quando houver validação prática. Execute testes, lint, type check, build, browser, logs ou outra verificação pertinente e relate somente o que a ferramenta realmente confirmou.

- Use Context7 proativamente para documentação atual e específica de versão de bibliotecas, frameworks, SDKs, APIs, CLIs e serviços externos. Confirme biblioteca e versão e faça consultas focadas antes de adotar dependências ou APIs relevantes. Context7 não define requisitos do produto.
- Use Playwright MCP para reproduzir e validar comportamentos que existam no navegador. Ele fornece evidência interativa de runtime, mas jornadas críticas repetíveis devem também ter testes versionados quando apropriado.
- **Ambiente de execução:** faça inspeção local (`rg`, `git status`, `git diff`, `git log`) e as validações que não dependem de processos externos no sandbox. Neste projeto, `pnpm lint`, `pnpm typecheck` e `pnpm test` podem ser executados ali. Execute `pnpm build` ou `pnpm check` fora do sandbox restrito (com acesso externo autorizado): o Next.js inicia `tsc --showConfig` como processo filho, e esse sandbox pode devolver stdout vazio mesmo com o processo indicando sucesso, causando uma falha que não reproduz no terminal normal nem no CI. Não altere `tsconfig` ou a aplicação para contornar essa limitação ambiental. Comandos que dependem de GitHub, registries, `git push`, serviços externos ou um daemon Docker também devem usar acesso externo autorizado quando o sandbox não oferecer esses recursos. Validações de navegador devem usar o Playwright MCP, não uma tentativa equivalente no shell.
- Antes de tornar um novo check de CI obrigatório em branch protegida, configure seus pré-requisitos e obtenha uma execução representativa bem-sucedida; só então o torne obrigatório. Um check que encontra um problema real pode bloquear merge, mas um check que falha por configuração incompleta não deve bloquear deliberadamente a branch padrão. Sem permissão para configurar o pré-requisito, registre-o e aguarde a habilitação por usuário/admin antes de tornar o check obrigatório.
- Atualize no mesmo trabalho toda documentação afetada por comportamento, contrato, arquitetura, configuração, workflow, dependência, interface, requisito ou operação.
- Documente o estado vigente de forma direta. Remova descrições, comentários e exemplos obsoletos; preserve histórico apenas em ADRs, Git, planos concluídos, changelog, issues ou notas de migração quando ele tiver valor.
- Não crie um documento se uma fonte canônica existente puder receber a informação sem perder clareza. Use links em vez de duplicar regras.

## Definition of Done

Uma tarefa só está concluída quando, entre todos os artefatos aplicáveis à mudança:

- a spec representa o comportamento desejado e os critérios de aceitação estão satisfeitos;
- testes relevantes foram criados ou atualizados, com Red demonstrado quando TDD era obrigatório;
- suítes, lint, type check, build, contratos e validação em browser pertinentes passam;
- documentação, comentários, exemplos e diagramas estão sincronizados, sem conteúdo obsoleto;
- não há drift conhecido entre requisito, spec, testes, implementação e documentação;
- as validações executadas e quaisquer exceções ao TDD estão registradas com precisão.

Os comandos de test, lint, type check e build ainda não existem. Assim que a stack for definida por spec ou decisão técnica aprovada, registre os comandos canônicos em [`docs/testing/README.md`](docs/testing/README.md) e mantenha aqui apenas o encaminhamento.
