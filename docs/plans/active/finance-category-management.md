# Plano: gerenciamento de categorias financeiras

- Status: FIN-006 implementado; revisão independente pendente
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
- Reclassificação em lote oferece prévia sem mutação e confirmação atômica em
  `POST /transactions/reclassify`, com hash da prévia, `If-Match` da categoria,
  idempotência e auditoria sanitizada por transação. A prévia marca conflitos de
  versão, categoria inativa/incompatível, transações de cartão, recorrência,
  parcelamento, canceladas ou de outro espaço antes da confirmação.

## Tarefas

- [x] Contratos e rotas de atualização/arquivamento/restauração e reclassificação em lote.
- [x] Serviço transacional com auditoria e testes de domínio/integração.
- [x] Adapter e UI de categorias com edição progressiva e prévia da reclassificação.
- [ ] Validar suíte, typecheck, lint e build; revisão independente pendente.
