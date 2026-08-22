# ADR: monorepo e plataformas

- Status: aprovada
- Data: 2026-08-21
- Spec ou contexto relacionado: [fundação do produto](../../specs/fundacao-do-produto.md)

## Contexto

O Casei inicia como PWA e terá aplicativo móvel nativo futuramente. O domínio, os contratos e os tokens visuais devem ser reutilizáveis, sem acoplar telas web a React Native.

## Decisão

Usar `pnpm workspaces` como gerenciador e estrutura de monorepo, com Turborepo para orquestrar e armazenar em cache tarefas. O PWA fica em `apps/web` e um futuro aplicativo Expo em `apps/mobile`. Pacotes de domínio, contratos, banco e tokens vivem em `packages/`.

## Consequências

- Um único repositório preserva contratos e regras de negócio entre plataformas.
- As interfaces web e nativa permanecem específicas à plataforma; não haverá tentativa prematura de compartilhar componentes shadcn.
- Turborepo impõe a declaração explícita de entradas, saídas e dependências das tarefas.

## Alternativas consideradas

- Repositórios independentes: reduz a complexidade inicial, mas duplica contratos e dificulta a evolução para mobile.
- Nx: fornece mais geração e governança, mas adiciona uma camada maior que não é necessária no estágio inicial.
