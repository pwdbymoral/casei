# ADR: qualidade e entrega independente de plataforma

- Status: aprovada
- Data: 2026-08-21
- Spec ou contexto relacionado: [fundação do produto](../../specs/fundacao-do-produto.md)

## Contexto

O Casei precisa de ciclos curtos, alterações seguras por pessoas e agentes, e publicação em infraestrutura própria ou equivalente sem dependência de orquestrador específico.

## Decisão

Usar Biome para formatação e lint, Vitest para testes unitários e de integração, Playwright para jornadas web e GitHub Actions para CI. O projeto gera imagens Docker/OCI multi-stage e usa variáveis de ambiente documentadas. Publicações versionadas serão imagens imutáveis em um registro OCI; a infraestrutura de destino as consome externamente.

## Consequências

- Todo pull request executa format/lint, typecheck, testes e build antes de integração.
- Dependências e análise estática recebem atualizações e verificações automatizadas por Dependabot e CodeQL.
- Não haverá workflow que faça deploy diretamente a um fornecedor específico.

## Alternativas consideradas

- Scripts locais sem CI: menor configuração, mas não protege o histórico compartilhado.
- Deploy por SSH dentro do repositório: acopla o código a uma infraestrutura e exige gestão de segredos desnecessária na fundação.
