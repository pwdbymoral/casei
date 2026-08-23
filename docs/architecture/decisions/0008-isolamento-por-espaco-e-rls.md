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
7. jobs iteram espaços/alvos com escopo explícito e a mesma proteção, salvo rotinas administrativas isoladas e testadas;
8. toda mutação doméstica bloqueia a linha de `membership` do ator (`FOR UPDATE`) na mesma transação em que revalida papel, estado e capacidade antes de escrever. Remoção, downgrade e transferência de membership usam o mesmo lock. Isso serializa revogação com mutação mesmo sob o isolamento padrão `READ COMMITTED`;
9. jobs persistem `actor_id`, `workspace_id` e `required_capability` e revalidam membership/capacidade, adquirindo o lock, antes de cada lote e transição de estado. Se a autorização deixou de existir, o job para sem aplicar o lote seguinte e registra cancelamento auditável.

Policies filtram `USING` e `WITH CHECK`. A autorização do caso de uso não é considerada válida até a leitura com lock da membership na mesma transação da mutação; o `WorkspaceScope` carrega a versão observada para detectar alterações concorrentes. Policy não faz subconsulta concorrente complexa quando uma claim/contexto já validado pode ser usado. O console administrativo acessa somente views/metadados próprios; não ganha bypass genérico.

## Consequências

- Um handler ou repository defeituoso tende a falhar fechado em vez de vazar outro espaço.
- Testes e migrations ficam mais complexos e precisam exercer role real da aplicação, não somente owner do banco.
- Toda transação deve configurar contexto antes da primeira consulta doméstica; pool deve descartar/rollback corretamente ao terminar.
- Revogação e mutação concorrentes têm ordem determinística pelo lock da membership; testes precisam usar duas conexões e verificar que a operação que perde a autorização não grava.
- Operações globais exigem adapters administrativos estreitos, auditados e sem conteúdo desnecessário.

## Alternativas consideradas

- Somente filtro na aplicação: menor esforço, mas uma omissão simples expõe dados.
- Um schema/banco por espaço: isolamento forte, porém migrations e operação inviáveis para o estágio inicial.
- RLS sem repository scoped: defesa no banco, mas reduz clareza e facilita falhas quando uma conexão privilegiada é usada.

## Compatibilidade e migração

RLS e policies entram na primeira migração de cada tabela doméstica. CI possui testes que executam com role de aplicação, dois espaços e IDs válidos cruzados, além de testes concorrentes de mutação contra remoção/downgrade. Mudança de policy exige teste negativo antes da migration. Referências: [Row Security Policies no PostgreSQL 18](https://www.postgresql.org/docs/18/ddl-rowsecurity.html) e [Transaction Isolation no PostgreSQL 18](https://www.postgresql.org/docs/18/transaction-iso.html).
