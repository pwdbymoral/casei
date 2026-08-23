# ADR: livro razão financeiro de dupla entrada

- Status: aprovada
- Data: 2026-08-23
- Spec ou contexto relacionado: [finanças](../../specs/financas.md), [cartões](../../specs/cartoes-de-credito.md) e [modelo de domínio](../modelo-de-dominio-mvp.md)

## Contexto

A carteira única precisa conviver com cartão, fatura, metas, empréstimos, ajustes e projeções. Atualizar saldos independentes por feature permitiria dupla contagem e drift difícil de reparar, especialmente sob edição, retry e concorrência.

## Decisão

Usar um livro razão interno de dupla entrada como fonte canônica dos fatos financeiros. Cada evento publicado produz dois ou mais lançamentos imutáveis, em centavos e na moeda do espaço, cuja soma é zero. A transação percebida pelo usuário referencia o evento, mas não substitui os lançamentos.

- Receita na carteira debita wallet e credita income.
- Despesa na carteira debita expense e credita wallet.
- Compra no cartão debita expense e credita o passivo do cartão.
- Pagamento de fatura debita o passivo e credita wallet.
- Principal de empréstimo movimenta wallet contra recebível ou obrigação, sem income/expense.
- Meta usa subledger de reserva e não cria uma conta adicional de dinheiro.

Eventos publicados nunca são alterados ou removidos. Cancelamento cria reversão vinculada; edição de efeito financeiro cria reversão e evento substituto na mesma transação PostgreSQL. Eventos planejados ficam fora do ledger até serem realizados, mas alimentam read models de projeção.

O banco impõe moeda única por evento, valor diferente de zero, balanceamento e unicidade de referências. O cabeçalho do evento possui `currency_code` e uma chave única `(event_id, currency_code)`; cada lançamento referencia essa chave composta e, portanto, não pode introduzir outra moeda. `amount_minor <> 0` é `CHECK` no lançamento. Um constraint trigger PostgreSQL `DEFERRABLE INITIALLY DEFERRED`, disparado em `INSERT`, `UPDATE` e `DELETE` de lançamentos e ao publicar o evento, exige pelo menos dois lançamentos e soma zero antes do commit; evento que falha permanece fora de `published`. Triggers `BEFORE UPDATE/DELETE` rejeitam qualquer alteração de lançamento publicado e qualquer alteração de seus campos imutáveis no cabeçalho; publicado não volta a `draft` nem é apagado. O serviço de domínio também valida antes de persistir, mas não substitui essas garantias. Saldo e passivos são somas dos lançamentos; caches são reconstruíveis e não recebem escrita pública.

## Consequências

- Cartão, fatura, empréstimo e ajuste reconciliam por construção, sem regras duplicadas no cliente.
- Auditoria e correção preservam história completa.
- Implementação inicial é mais rigorosa que um CRUD de transações e exige exemplos, property tests, operações por comando e testes de falha do constraint trigger/rollback.
- Relatórios devem distinguir resultado econômico de fluxo de caixa.
- Migrações futuras podem reconstruir projeções a partir do ledger, mas não podem reescrever eventos publicados sem procedimento formal.

## Alternativas consideradas

- Guardar e atualizar um saldo na carteira: simples no início, mas vulnerável a retries, edições e integrações cruzadas.
- Um registro de valor assinado por transação: atende caixa simples, mas não modela de forma segura passivo, recebível e transferências sem dupla contagem.
- Event sourcing integral de todos os domínios: preserva histórico, porém amplia infraestrutura e curva operacional sem necessidade no MVP.

## Compatibilidade e migração

Ainda não há dados financeiros reais. A primeira migração cria o modelo definitivo, a FK composta de moeda, os checks, o constraint trigger e os guards de imutabilidade, além de seeds técnicos por espaço. A suíte de integração tenta publicar evento desequilibrado, de moeda divergente, com valor zero e com referência repetida; tenta apagar todos os lançamentos, reescrever valores mantendo soma zero, alterar moeda/cabeçalho, apagar o evento e desfazer publicação; cada caso deve falhar sem linhas parcialmente publicadas. Alterações posteriores seguem expand/backfill/contract e validam reconciliação antes de remover qualquer estrutura anterior.
