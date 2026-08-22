# ADR: aplicação, API e dados

- Status: aprovada
- Data: 2026-08-21
- Spec ou contexto relacionado: [fundação do produto](../../specs/fundacao-do-produto.md)

## Contexto

O produto precisa oferecer uma experiência PWA rápida e acessível, uma API consumível pelo futuro aplicativo nativo e persistência relacional segura para dados compartilhados.

## Decisão

Usar Next.js, React, TypeScript estrito, Tailwind CSS e shadcn/ui no PWA. Usar Hono como API HTTP independente, PostgreSQL como banco relacional, Drizzle ORM para schema e migrações, Zod para validação de contratos e Better Auth para autenticação auto-hospedada. O PWA usa manifest e Serwist; a primeira versão não enfileira mutações offline.

## Consequências

- A API não depende de rotas internas do Next e pode servir clientes móveis.
- Schema e migrações são código versionado e aplicados explicitamente.
- Cada consulta e mutação protegida deve validar sessão e escopo do espaço compartilhado no servidor.
- Offline-first completo permanece uma iniciativa futura, com desenho de sincronização e conflitos próprio.

## Alternativas consideradas

- API exclusivamente em route handlers do Next: é menor inicialmente, mas mistura o boundary público com o cliente web.
- Prisma: boa produtividade, mas Drizzle oferece schema e SQL mais diretos para uma base enxuta.
- BaaS gerenciado: acelera o início, porém introduz dependência de plataforma que não é necessária nesta fundação.
