# Casei

Casei é um PWA para organizar a vida de uma pessoa, casal ou grupo de forma simples e compartilhada. O produto reunirá planejamento financeiro, metas e estoque doméstico em uma experiência segura, responsiva e agradável de usar.

## Código aberto e comunidade

O Casei é um projeto open source construído em comunidade. O código é licenciado sob [GNU AGPL-3.0-or-later](LICENSE): melhorias e versões modificadas oferecidas pela rede devem continuar disponíveis à comunidade sob a mesma licença. Contribuições, discussões e revisões são bem-vindas.

## Estado atual

O repositório contém a fundação técnica do produto:

- PWA em Next.js, TypeScript, Tailwind CSS e shadcn/ui;
- API HTTP em Hono;
- contratos validados com Zod e domínio compartilhável;
- base preparada para PostgreSQL e Drizzle;
- monorepo pnpm com Turborepo, preparado para um futuro app Expo;
- CI no GitHub Actions, análise CodeQL e atualizações por Dependabot;
- imagens OCI e configuração local independentes de plataforma de deploy.

Os módulos de finanças, metas, estoque e autenticação ainda serão especificados e implementados incrementalmente.

## Começar localmente

Requer Node.js 24, pnpm 11.3.0 e Docker para o banco local.

```bash
pnpm install
docker compose up -d postgres
pnpm dev
```

O PWA fica em `http://localhost:3000` e a API em `http://localhost:3001`.

## Qualidade

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Consulte [a estratégia de testes](docs/testing/README.md), [as specs](docs/specs/) e [as decisões arquiteturais](docs/architecture/decisions/) antes de iniciar uma mudança.

## Estrutura

```text
apps/web        PWA
apps/api        API HTTP
packages/*      contratos, domínio e dados compartilháveis
docs/           specs, ADRs, planos e estratégia de testes
.agents/        instruções e skills do projeto para desenvolvimento assistido por agentes
```

## Contribuição

Consulte as [diretrizes de contribuição](CONTRIBUTING.md). A `main` é protegida: mudanças entram por pull request somente após `quality` e `Analyze (javascript-typescript)` passarem. O repositório utiliza squash merge e remove a branch após integração.
