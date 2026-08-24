# Specification: carteira, transações e compromissos financeiros

- Status: vigente; subordinada às [decisões de produto do MVP](mvp-casei.md#decisões-de-produto-aprovadas)

## Contexto e objetivo

O Casei precisa representar dinheiro que entrou, saiu ou ainda está comprometido sem exigir conhecimento contábil do usuário e sem perder consistência entre carteira, cartões, metas e relatórios.

O objetivo é oferecer uma carteira única por espaço, uma linha do tempo financeira completa e captura simples para movimentos únicos, recorrentes, parcelados, emprestados e de ajuste.

## Vocabulário do usuário

- **Carteira:** único caixa do espaço; agrega dinheiro disponível, independentemente de onde esteja fisicamente.
- **Transação:** evento que o usuário reconhece, como receita, despesa, compra no cartão, pagamento ou ajuste.
- **Compromisso:** ocorrência futura ou vencida ainda não liquidada.
- **Liquidação:** momento em que dinheiro efetivamente entra ou sai da carteira.
- **Recorrência:** regra que cria ocorrências independentes ao longo do tempo.
- **Parcelamento:** plano finito de ocorrências ligadas a uma mesma origem.
- **Empréstimo:** contrato simples que gera recebível ou obrigação, sem virar receita/despesa indevidamente.

## Modelo comportamental

### Estado da transação

- `planned`: esperada, ainda sem evento financeiro publicado;
- `partially_settled`: compromisso cumprido apenas em parte;
- `posted`: fato econômico realizado e publicado no livro razão;
- `overdue`: apresentação derivada quando planejada ou parcial, vencida e ainda com valor em aberto;
- `canceled`: sem efeito futuro, preservada no histórico.

`overdue` é uma apresentação derivada, não um estado gravado que possa divergir do relógio. Transação cancelada não pode ser realizada sem restauração explícita. Na interface, `posted` usa o termo adequado ao caso — `Paga`, `Recebida`, `Comprada` ou `Realizada` — e não expõe jargão contábil.

### Classificação econômica

- `income`: aumenta resultado e, quando realizada na carteira, o saldo;
- `expense`: reduz resultado e, quando realizada na carteira, o saldo;
- `transfer`: move valor entre caixa e ativo/passivo/reserva sem criar renda ou despesa;
- `adjustment`: reconcilia saldo observado e saldo calculado, com justificativa obrigatória.

Compra no cartão é `expense` na data da compra e aumenta o passivo do cartão; não move a carteira. Pagamento de fatura é `transfer` da carteira para o passivo. Empréstimos e contribuições de meta também usam transferências internas conforme suas specs.

### Valores e datas

- Valor deve ser maior que zero; direção e natureza determinam o sinal internamente.
- O usuário nunca digita sinal negativo para indicar despesa.
- Valor planejado e valor liquidado podem diferir; ambos permanecem disponíveis para comparação.
- `occurredOn` representa quando o fato econômico aconteceu; `dueOn`, quando deve ser cumprido; `postedOn`, quando foi publicado; `cashSettledOn`, quando efetivamente moveu a carteira, se aplicável.
- Em uma transação simples da carteira realizada imediatamente, essas datas assumem o dia atual e detalhes ficam recolhidos. Compra no cartão não possui `cashSettledOn`; a saída de caixa pertence ao pagamento da fatura.
- Datas são civis no fuso do espaço, evitando deslocamento de dia por UTC.

## Fluxos principais

### Receita ou despesa simples

1. A ação escolhida define receita ou despesa.
2. O usuário informa valor; data atual, carteira e estado realizado aparecem como defaults.
3. Descrição, categoria, pessoa responsável, vencimento e nota ficam em `Mais detalhes`.
4. Salvar atualiza saldo e linha do tempo de forma atômica.
5. A confirmação permite desfazer por curto período; desfazer cria cancelamento/reversão auditável.

Sem descrição, a UI usa rótulo neutro como `Despesa sem descrição`, sem inventar categoria.

### Captura rápida e linha do tempo

- A captura rápida exige somente valor, mostra carteira/estado realizado como defaults e preserva os
  detalhes opcionais recolhidos. Após uma gravação realizada, a confirmação oferece desfazer por
  curto período; desfazer usa o comando de reversão auditável, não apaga o histórico.
- `GET /v1/workspaces/:workspaceId/transactions` aceita `search`, `from`, `to`, `state`, `kind`,
  `cardId`, `limit` e cursor. A ordenação é civil decrescente por `occurredOn`, instante de criação
  decrescente e ID decrescente; o cursor é opaco e assinado. A lista retorna envelope `items/page`.
- A UI mantém os filtros da linha do tempo na URL, distingue vazio inicial de vazio filtrado e
  permite carregar a próxima página sem substituir os itens já visíveis.
- Cada item oferece detalhe básico com estado, valor, data e versão. O histórico completo de
  auditoria é autenticado e pode ser consultado por `GET /v1/workspaces/:workspaceId/transactions/:id/audit`,
  com paginação por cursor opaco e assinado, ordenada por instante e ID decrescentes.
- `GET /v1/workspaces/:workspaceId/transactions/:id/audit/:auditId` retorna o evento individual e
  suas consequências relacionadas no livro razão, sem permitir cruzar transações ou espaços.
- Eventos expõem categoria, ação, autor, instante, origem, correlação, resultado e motivo. Os
  campos `before` e `after` contêm somente uma allowlist sanitizada de estado e referências; valor,
  descrição, e-mail, token e outros dados sensíveis não entram no snapshot padrão.

### Conta a pagar ou receber

O usuário muda o estado para `Planejada` e informa vencimento. A ocorrência aparece em próximos compromissos, não no saldo atual. Ao marcar como paga/recebida, informa ou aceita data e valor efetivos. Pagamento parcial registra cumprimento parcial e mantém o restante planejado.

Na API, a realização usa `POST /v1/workspaces/:workspaceId/transactions/:id/post` com
`Idempotency-Key`, `If-Match: "v<version>"` e, opcionalmente, `{ amount, occurredOn }`. Sem
`amount`, o sistema liquida somente o saldo restante; com `amount`, a moeda deve ser a da
transação e o valor não pode exceder esse saldo. Cada aceite publica apenas o delta informado
como evento do livro razão, incrementa a versão e faz a transição
`planned → partially_settled → posted`; uma tentativa repetida com a mesma chave reproduz a
resposta sem publicar outro delta. `occurredOn` é a data civil efetiva do delta e, quando omitida,
usa o dia atual no fuso do espaço. O estado parcial e suas liquidações permanecem no histórico e
uma reversão estorna todos os deltas publicados atomicamente.

### Recorrência

- Frequências MVP: semanal, mensal e anual; intervalo configurável; início obrigatório e fim opcional por data ou quantidade.
- Regra fixa replica o valor planejado. Regra variável pode usar valor estimado opcional e exige confirmação do valor efetivo antes da liquidação.
- O sistema materializa ocorrências em janela móvel de 12 meses, de modo idempotente, e amplia a janela por job seguro.
- Editar oferece escopo `Somente esta`, `Esta e futuras` ou `Toda a série ainda não liquidada`.
- Ocorrências realizadas nunca são reescritas por edição da regra.
- Pausar impede novas ocorrências após a data efetiva; retomar não recria ocorrências canceladas sem confirmação.
- Para dia mensal inexistente, usa-se o último dia do mês e a UI explica a regra.

### Parcelamento

- Número de parcelas é inteiro entre 2 e 999; soma das parcelas deve ser exatamente igual ao total.
- Diferenças de arredondamento em centavos são distribuídas deterministicamente nas primeiras parcelas.
- O usuário vê total, quantidade, primeiro vencimento e prévia completa antes de salvar.
- Editar o plano afeta somente parcelas futuras não realizadas; uma parcela pode ser editada isoladamente.
- Cancelar o restante preserva parcelas realizadas e cancela apenas futuras.
- Parcelamento no cartão segue também [cartões de crédito](cartoes-de-credito.md).

### Empréstimo concedido

Ao emprestar, a carteira diminui e nasce um recebível; não há despesa. Reembolsos aumentam a carteira e reduzem o recebível; não são receita. O cadastro exige contraparte identificável por nome livre, principal, data e plano de pagamento opcional.

### Empréstimo recebido

Ao tomar emprestado, a carteira aumenta e nasce uma obrigação; não há receita. Pagamentos diminuem carteira e obrigação; não são despesa. Juros ou tarifas, quando existirem, são despesas separadas vinculadas ao empréstimo.

Pagamentos podem ser parciais. Saldo do contrato nunca fica negativo; excedente exige correção ou registro separado. Perdão/baixa exige confirmação e gera receita ou despesa explícita conforme a direção.

### Ajuste de saldo

O usuário informa o saldo observado; o sistema mostra a diferença antes de confirmar e cria ajuste somente pela diferença. Motivo é obrigatório. Ajuste não pode ser recorrente, parcelado, categorizado como consumo ou usado para ocultar pagamento de fatura. Apenas owner e member podem ajustar.

### Edição e cancelamento

- Edição mostra consequências em saldo, projeção, fatura, meta ou empréstimo antes de salvar.
- Trocar uma transação entre carteira e cartão executa uma operação de domínio atômica, recalculando ambos os lados.
- Registros importados e gerados mantêm vínculo com origem.
- Cancelamento de transação com dependentes exige tratar os dependentes na mesma operação ou bloqueia com orientação.
- Alterações relevantes geram evento de auditoria com antes/depois sanitizado, autor e origem.

## Cálculos canônicos

- **Saldo atual da carteira** = saldo inicial + eventos publicados de entrada na carteira − eventos publicados de saída da carteira.
- **Resultado do período** = receitas reconhecidas − despesas reconhecidas no período; transferências e ajustes ficam apresentados separadamente.
- **Comprometido** = saídas planejadas vencidas ou futuras dentro do horizonte, incluindo faturas, sem repetir compras de cartão.
- **A receber** e **a pagar** incluem compromissos e saldos de empréstimos em seções distintas para não sugerir que já compõem o saldo.

Todos os totais são calculados no servidor a partir de lançamentos canônicos. Cards e relatórios não mantêm cópias mutáveis desses valores.

## Categorias

- O sistema fornece categorias iniciais editáveis e uma opção `Sem categoria`.
- Categoria pertence ao espaço, tem nome único entre ativas e pode ser de receita, despesa ou ambas.
- Arquivar categoria impede novos usos, preservando histórico.
- Reclassificação em lote é permitida com prévia e auditoria.
- Categorias não controlam autorização.

## Edge cases e falhas

- Retry, duplo toque ou refresh não duplica gravação.
- Valor zero, moeda diferente da carteira ou data inválida são rejeitados antes de mutação.
- Falha após parte de uma operação composta reverte a transação de banco inteira.
- Mudança de fuso não altera datas civis já registradas.
- Exclusão de categoria, cartão, membro ou recorrência referenciada preserva os registros históricos.
- Saldo pode ficar negativo; o sistema alerta, mas não falsifica nem bloqueia um fato ocorrido.
- Liquidação futura é permitida somente com confirmação clara, pois altera projeção e não saldo de hoje.
- Listas usam desempate estável por instante de criação e ID.

## Critérios de aceitação

- [ ] Receita e despesa simples podem ser salvas só com valor, usando defaults visíveis.
- [ ] Planejado não altera saldo atual; realização na carteira altera uma única vez, inclusive sob retry.
- [ ] Liquidação parcial aceita múltiplos deltas idempotentes, rejeita moeda/excedente/duplicação e só publica o delta efetivo; a última liquidação transita para `posted`.
- [ ] Edição e cancelamento corrigem totais relacionados e preservam auditoria.
- [ ] Recorrência fixa e variável respeita janela, escopo de edição, meses curtos, pausa e idempotência.
- [ ] Parcelas somam exatamente o total e histórico realizado não muda ao editar futuras.
- [ ] Empréstimos alteram carteira e recebível/obrigação sem contaminar renda/despesa.
- [ ] Ajuste cria somente a diferença mostrada e exige motivo.
- [ ] Testes baseados em propriedades cobrem soma de parcelas e conservação dos lançamentos.
- [ ] Histórico de cada transação lista eventos auditáveis com cursor seguro e detalhe de
  consequências relacionadas, preservando snapshots antes/depois sanitizados.
