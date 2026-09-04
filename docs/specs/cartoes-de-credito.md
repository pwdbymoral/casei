# Specification: cartões de crédito e faturas

- Status: vigente; subordinada às [decisões de produto do MVP](mvp-casei.md#decisões-de-produto-aprovadas)

## Contexto e objetivo

Cartão de crédito adia a saída da carteira e agrupa compras em ciclos. O Casei deve representar compra, dívida, fechamento e pagamento sem dupla contagem e permitir correções compatíveis com a realidade do emissor.

## Cadastro do cartão

Campos obrigatórios: nome, dia de fechamento, dia de vencimento e titular em texto livre ou membro do espaço. Campos opcionais: limite, quatro últimos dígitos, bandeira e cor sem significado semântico.

- Dias aceitos: 1 a 31. Em mês curto, usa-se o último dia.
- Limite ausente significa desconhecido, não ilimitado.
- Cartão arquivado não aceita novas compras, mas mantém faturas e pagamentos.
- Edição de fechamento/vencimento vale para ciclos futuros ainda sem compra ou fatura fechada. Ciclos existentes mantêm as datas que possuíam; alteração retroativa exige ajuste manual explícito.

## Compra e parcelamento

- Uma compra cria despesa na data da compra e aumenta o passivo do cartão.
- Data padrão é hoje; cartão é obrigatório e pode usar o último cartão selecionado como default visível.
- Compra pode ser à vista ou parcelada. Cada parcela pertence exatamente a uma fatura.
- O sistema sugere a fatura pela data da compra e regra de fechamento. Como o processamento do emissor pode divergir, o usuário pode mover uma compra ou parcela para fatura aberta adjacente.
- Compra após o fechamento pertence ao ciclo seguinte. Compra no próprio dia do fechamento também é sugerida para o ciclo seguinte, com possibilidade de correção manual.
- Estorno reduz despesa e passivo na data do estorno; não apaga a compra original. Estorno parcial é permitido até o saldo da compra.

## Ciclo e fatura

Faturas possuem `open`, `closed`, `partially_paid`, `paid`, `overdue` derivado e `canceled` apenas quando vazias ou substituídas por correção auditada.

- Fatura aberta recebe compras e ajustes.
- Fechamento congela período, vencimento e total naquele instante; lançamentos posteriores entram como ajuste explícito ou em ciclo aberto conforme escolha do usuário.
- Total da fatura = compras e tarifas − estornos − créditos vinculados.
- Valor em aberto = total da fatura − pagamentos vinculados.
- Uma fatura paga não volta a aberta silenciosamente quando uma compra é editada; a operação apresenta a diferença e exige ajuste ou reabertura explícita.
- Fechamento automático por job é idempotente; o usuário também pode fechar manualmente após conferir.

## Pagamento

- Pagamento reduz carteira e passivo do cartão como transferência; não entra novamente como despesa.
- Pagamento total usa o valor em aberto como default. Pagamento parcial mantém o restante visível.
- Pagamento acima do valor em aberto exige confirmação e cria crédito do cartão, nunca despesa negativa oculta.
- Cancelar pagamento restaura carteira e passivo na mesma operação auditada.
- Tarifas, multa e juros são despesas separadas vinculadas à fatura. O MVP não calcula rotativo automaticamente.

## Limite e disponibilidade

Quando o limite for conhecido:

- limite utilizado = passivo de compras ainda não compensadas por pagamentos ou créditos;
- limite disponível = limite − utilizado;
- valor negativo é exibido como limite excedido, sem truncar em zero.

O cálculo é informativo e pode divergir do emissor por autorizações pendentes, câmbio ou regras externas; a interface declara essa limitação.

## Interface

- Lista de cartões mostra fatura atual, vencimento, estado e limite disponível quando conhecido.
- Detalhe do cartão organiza por faturas, não por uma lista infinita de compras.
- Fatura mostra composição, pagamentos, diferença e origem de cada item.
- Ações frequentes: `Adicionar compra`, `Pagar fatura`, `Fechar fatura` e `Mover para outra fatura`.
- Totais usam texto e não dependem apenas de cor. Fatura vencida traz ação direta e consequência clara.

## Edge cases

- Fechamento 31 e vencimento 5 atravessam meses corretamente, inclusive fevereiro e ano bissexto.
- Vencimento anterior ao fechamento representa o mês seguinte.
- Alterar data de compra recalcula somente fatura aberta; fatura fechada exige confirmação.
- Excluir/arquivar cartão com saldo ou fatura aberta é bloqueado; arquivamento permanece disponível após quitar ou transferir os vínculos.
- Duas compras de mesmo valor/data não são duplicatas por si só.
- Pagamento e fechamento concorrentes usam lock/versionamento para não produzir saldo incorreto.
- Estorno e tarifa/juros vinculados à fatura não podem ser revertidos pelo comando genérico da
  linha do tempo; a correção deve ser registrada na composição da fatura para preservar a origem e
  a auditoria.
- Estornos concorrentes da mesma compra usam o lançamento original como lock canônico e nunca
  podem superar o saldo ainda não estornado.

## Critérios de aceitação

- [ ] Compra afeta despesa e passivo, mas não saldo da carteira.
- [ ] Pagamento afeta carteira e passivo, mas não despesa.
- [ ] Regra de ciclo funciona em limites de mês e permite correção manual auditada.
- [ ] Parcelas pertencem a faturas corretas e somam exatamente o total da compra.
- [x] Pagamentos parciais, excedentes, cancelamentos e estornos preservam os invariantes.
- [ ] Editar configuração não reescreve ciclos históricos.
- [ ] Cartão não pode desaparecer enquanto houver vínculos relevantes.
