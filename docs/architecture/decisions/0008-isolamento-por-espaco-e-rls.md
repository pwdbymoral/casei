# ADR: isolamento por espaço com escopo obrigatório e RLS

- Status: aprovada
- Data: 2026-08-23
- Spec ou contexto relacionado: [identidade e administração](../../specs/identidade-e-administracao.md) e [fundação](../../specs/fundacao-do-produto.md)

## Contexto

Filtrar por `workspaceId` apenas por convenção é frágil sob crescimento e trabalho de múltiplos agentes. PostgreSQL oferece Row-Level Security, mas policies mal configuradas, owner bypass e contexto de conexão vazando em pool também criam risco.

## Decisão

Aplicar defesa em camadas:

1. todas as tabelas domésticas carregam `workspace_id NOT NULL` e FKs/uniques compostos impedem referências cruzadas;
2. casos de uso exigem `WorkspaceScope` já autorizado e repositories domésticos não oferecem operação sem escopo;
3. PostgreSQL RLS fica habilitado e forçado nas tabelas domésticas; ausência de policy produz default-deny;
4. cada transação autorizada usa `set_config(..., true)` para definir `app.workspace_id` e `app.actor_id` localmente à transação; policies leem com `current_setting(..., true)` e falham fechado quando ausente/inválido, nunca usando configuração persistente da sessão do pool;
5. role usada pela aplicação não possui `BYPASSRLS`, não é superuser e não é dona das tabelas;
6. migrations usam role separada, fora do caminho de requests;
7. jobs iteram espaços/alvos com escopo explícito e a mesma proteção, salvo rotinas administrativas isoladas e testadas.

Policies filtram `USING` e `WITH CHECK`. Mudança de membership e operação sensível são validadas no caso de uso dentro da mesma transação; policy não faz subconsulta concorrente complexa quando uma claim/contexto já validado pode ser usado. O console administrativo acessa somente views/metadados próprios; não ganha bypass genérico.

## Consequências

- Um handler ou repository defeituoso tende a falhar fechado em vez de vazar outro espaço.
- Testes e migrations ficam mais complexos e precisam exercer role real da aplicação, não somente owner do banco.
- Toda transação deve configurar contexto antes da primeira consulta doméstica; pool deve descartar/rollback corretamente ao terminar.
- Operações globais exigem adapters administrativos estreitos, auditados e sem conteúdo desnecessário.

## Alternativas consideradas

- Somente filtro na aplicação: menor esforço, mas uma omissão simples expõe dados.
- Um schema/banco por espaço: isolamento forte, porém migrations e operação inviáveis para o estágio inicial.
- RLS sem repository scoped: defesa no banco, mas reduz clareza e facilita falhas quando uma conexão privilegiada é usada.

## Compatibilidade e migração

RLS e policies entram na primeira migração de cada tabela doméstica. CI possui testes que executam com role de aplicação, dois espaços e IDs válidos cruzados. Mudança de policy exige teste negativo antes da migration. Referência: [Row Security Policies no PostgreSQL 18](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).
