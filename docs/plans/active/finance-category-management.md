# Plano: gerenciamento de categorias financeiras

- Status: ativo
- Specs: [finanças](../../specs/financas.md#categorias)

## Objetivo

Entregar categorias iniciais e a manutenção segura das categorias do espaço, sem apagar
histórico: criar, editar nome/tipo e arquivar/restaurar com `If-Match`, idempotência,
isolamento por workspace e auditoria de comando.

## Critérios de aceite

- Categoria ativa possui nome único no espaço e só pode ser usada por lançamentos compatíveis.
- Editar preserva o histórico e rejeita conflito de versão ou nome duplicado.
- Arquivar impede novos usos, mas mantém lançamentos existentes; restaurar exige nome livre.
- Toda mutação exige papel `owner`/`member`, chave de idempotência e `If-Match`.
- API e UI expõem estados de erro, conflito, vazio e permissão sem vazar outro espaço.

## Tarefas

- [ ] Contratos e rotas de atualização/arquivamento/restauração.
- [ ] Serviço transacional com auditoria e testes de domínio/integração.
- [ ] Adapter e UI de categorias com edição progressiva.
- [ ] Validar suíte, typecheck, lint e build; atualizar rastreabilidade do MVP.

