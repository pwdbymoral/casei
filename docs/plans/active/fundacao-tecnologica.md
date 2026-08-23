# Plano: fundação tecnológica do Casei

- Status: ativo
- Spec associada: [fundação do produto](../../specs/fundacao-do-produto.md)

## Objetivo

Decidir, registrar e implantar a base independente de plataforma para desenvolver e entregar o PWA Casei, preparada para futuros aplicativos nativos.

## Estado inicial

- O diretório contém apenas a documentação-base e `shadcn` como dependência de desenvolvimento.
- Ainda não há repositório Git inicializado, remoto GitHub, comandos canônicos de qualidade nem aplicação executável.

## Abordagem

Registrar os requisitos do produto, aprovar as decisões tecnológicas materiais em ADRs e criar o monorepo com contratos e automações verificáveis antes dos módulos de negócio.

## Etapas

- [x] Registrar os requisitos conhecidos e as decisões que ainda dependem de aprovação.
- [x] Aprovar a stack e registrar as decisões arquiteturais.
- [x] Inicializar Git, convenções de colaboração e configuração do monorepo.
- [x] Criar o PWA, os pacotes compartilháveis, a API e a camada de dados mínima.
- [x] Configurar testes, análise estática, CI, imagens OCI, configuração de ambiente e documentação operacional.
- [x] Executar as validações canônicas e registrar a evidência.
- [x] Fixar as Actions por SHA completo e bloquear em pull requests a introdução de dependências com vulnerabilidades altas ou críticas.
- [x] Atualizar o Dependency Review para o runtime Node 24 e reconciliar a divergência observada entre build local e CI.

## Rastreabilidade

- Os critérios de aceitação da spec serão comprovados pela estrutura de workspaces, testes de contratos, builds OCI e workflow de CI.

## Riscos

- Offline-first aumenta significativamente sincronização, conflitos e superfície de segurança; decidir o escopo antes de implementar persistência local.
- Misturar UI web e nativa prematuramente cria abstrações frágeis; compartilhar domínio, contratos e tokens, mantendo as telas específicas por plataforma quando necessário.

## Validação

- Instalação limpa de dependências, lint, typecheck, testes, build do PWA, build de imagem OCI e execução com variáveis de ambiente documentadas.

## Evidência de validação

- Fora do sandbox restrito, `pnpm check` passou em 2026-08-23, cobrindo lint, typecheck, testes e build.
- As Actions dos workflows de CI e CodeQL foram fixadas por SHA completo, mantendo o comentário da versão para o Dependabot atualizá-las; o workflow `Dependency review` bloqueia novas dependências com vulnerabilidades altas ou críticas, e o ruleset `CodeQL merge protection` exige resultados CodeQL na `main`, bloqueando erros de code scanning e alertas de segurança `high` ou superiores sem bypass.
- A `actions/dependency-review-action` usa a release `v5.0.0`, fixada por SHA completo, cujo runtime é Node 24 e cujo requisito mínimo de runner é `2.327.1`; o runner hospedado que validou a PR está na versão `2.336.0`.
- O build do PWA passa no GitHub Actions com Node `24.19.0`, pnpm `11.3.0`, instalação limpa pelo lockfile e sem cache de build. No sandbox restrito, o `stdout` de processos-filho iniciados por Node é vazio mesmo com exit code zero; como o Next chama `tsc --showConfig` desse modo, ele falha ao interpretar a saída. A chamada direta ao TypeScript emite JSON válido. Fora do sandbox restrito, o mesmo `pnpm build` e o `pnpm check` passam; a divergência é uma limitação do ambiente de execução do agente, não do projeto, e nenhuma alteração na aplicação foi necessária.
- O teste de autorização foi executado em Red por módulo ausente e passou em Green após a implementação.
- O build Next gerou `sw.js` e `manifest.webmanifest`.
- A validação interativa no navegador não foi executada: o ambiente não expõe ferramenta de navegador e o processo de desenvolvimento não permaneceu acessível após o comando. O primeiro fluxo de interface deverá receber validação Playwright/browser antes de ser declarado concluído como feature.

## Decisões durante a implementação

- Nenhuma decisão tecnológica material foi aprovada ainda.
