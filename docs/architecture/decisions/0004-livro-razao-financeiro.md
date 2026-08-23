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

O banco deve impor, quando praticável, moeda única por evento, valor diferente de zero, balanceamento e unicidade de referências. O serviço de domínio também valida antes de persistir. Saldo e passivos são somas dos lançamentos; caches são reconstruíveis e não recebem escrita pública.

## Consequências

- Cartão, fatura, empréstimo e ajuste reconciliam por construção, sem regras duplicadas no cliente.
- Auditoria e correção preservam história completa.
- Implementação inicial é mais rigorosa que um CRUD de transações e exige exemplos, property tests e operações por comando.
- Relatórios devem distinguir resultado econômico de fluxo de caixa.
- Migrações futuras podem reconstruir projeções a partir do ledger, mas não podem reescrever eventos publicados sem procedimento formal.

## Alternativas consideradas

- Guardar e atualizar um saldo na carteira: simples no início, mas vulnerável a retries, edições e integrações cruzadas.
- Um registro de valor assinado por transação: atende caixa simples, mas não modela de forma segura passivo, recebível e transferências sem dupla contagem.
- Event sourcing integral de todos os domínios: preserva histórico, porém amplia infraestrutura e curva operacional sem necessidade no MVP.

## Compatibilidade e migração

Ainda não há dados financeiros reais. A primeira migração cria o modelo definitivo e seeds técnicos por espaço. Alterações posteriores seguem expand/backfill/contract e validam reconciliação antes de remover qualquer estrutura anterior.
