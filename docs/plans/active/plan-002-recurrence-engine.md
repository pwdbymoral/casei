# Plano: PLAN-002 motor de recorrências

- Status: concluído
- Spec associada: [finanças](../../specs/financas.md)
- Plano macro: [MVP Casei](mvp-casei.md)

## Objetivo

Materializar regras semanais, mensais e anuais em compromissos planejados de forma
determinística, idempotente e recuperável por job, sem reescrever ocorrências já
liquidadas.

## Critérios de aceitação

- A geração respeita frequência e intervalo e usa o dia original como âncora; quando
  o mês destino não possui o dia, usa o último dia desse mês sem derivar drift no mês
  seguinte.
- A criação e a expansão materializam ocorrências a partir do início da regra até o
  horizonte civil de hoje + 12 meses no fuso do espaço, respeitando `endOn`,
  `maxOccurrences` e pausa.
- Repetir o comando, o job ou a execução concorrente não cria outra transação nem
  outra ocorrência para a mesma regra/data.
- Recorrência fixa replica o valor planejado; variável conserva a estimativa opcional
  e continua exigindo valor efetivo no comando de liquidação já existente.
- Pausar grava a primeira data bloqueada e impede novas ocorrências a partir dela;
  retomar permite expansão futura sem recriar ocorrências canceladas.
- O relógio da aplicação é injetável; o job persiste a data civil de referência para
  que retry reproduza o mesmo resultado.
- A expansão roda como job durável de sistema, com lease/fencing e chave natural por
  espaço/data; uma falha é reprocessável sem duplicação.
- A migration arquiva explicitamente regras legadas sem ocorrência-fonte, com motivo
  verificável, e não as expõe ao motor ativo. A migration também semeia um job por
  espaço com regra ativa; o scheduler redescobre regras diretamente como reparo caso
  o job histórico esteja ausente.

## Estratégia

1. Especificar helpers de calendário civil e janela no pacote de domínio, com testes
   de frequência, meses curtos, ano bissexto, limite de janela e clock fixo.
2. Ajustar o contrato de recorrência e comandos de pausa/retomada.
3. Adicionar a constraint natural de transação por regra/data, mantendo a migration
   seriada após `0011_goals` e seu companion down.
4. Implementar a expansão transacional no `FinanceService` e o worker durável de
   recorrências, reutilizando `PostgresJobWorker` com autorização de sistema.
5. Atualizar rotas, testes de contrato/serviço/integração, documentação e plano macro.

## Validação

Além dos testes unitários, o CI deve executar a integração PostgreSQL com dois
workers/reties e comprovar a constraint natural, RLS e a expansão do horizonte.

## Evidência da entrega

- Domínio: testes de datas civis, âncoras mensais e ano bissexto.
- Contratos/API: criação, pausa, retomada, `If-Match`, idempotência e ETag.
- Banco: migration `0012_recurrence_engine`, constraint natural parcial,
  backfill da fonte da regra, arquivamento de legado inválido, política RLS para
  jobs de sistema e job inicial por espaço.
- Integração PostgreSQL: expansão de 12 ocorrências, retry idempotente, meses
  curtos, pausa inclusiva e cancelamento de ocorrências planejadas.
