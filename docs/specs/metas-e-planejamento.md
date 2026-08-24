# Specification: metas, projeção e decisões de gasto

- Status: vigente; subordinada às [decisões de produto do MVP](mvp-casei.md#decisões-de-produto-aprovadas)

## Contexto e objetivo

Registrar o passado não basta: o Casei deve transformar saldo, compromissos e metas em uma visão de futuro compreensível, sem prometer precisão que os dados não sustentam.

## Metas financeiras

Uma meta possui nome, valor-alvo maior que zero, prazo opcional, prioridade, estado e valor reservado. Categoria, nota e imagem são opcionais e não fazem parte do caminho rápido.

- Estados: `active`, `completed`, `paused`, `canceled`.
- Reservar valor move uma parcela virtual da carteira livre para a meta; não altera saldo, receita ou despesa.
- Retirar valor reservado devolve-o à parcela livre; não cria receita.
- A soma reservada pode superar o saldo apenas após confirmação explícita; nesse caso, o painel mostra reserva sem cobertura e não apresenta dinheiro negativo como disponível.
- Completar a meta exige atingir o alvo ou confirmação de encerramento parcial.
- Gastar a reserva cria ou vincula uma despesa/transferência real e libera o valor reservado correspondente atomicamente.
- Excluir meta com histórico não apaga contribuições; cancela e preserva o histórico.

No backend, `allocate`, `release` e `spend` são movimentos append-only. Reservar e retirar exigem
versão e idempotência; a cobertura de uma nova alocação soma as reservas de todas as metas do
espaço e usa o lock do espaço para serializar concorrência. Reservar acima do saldo calculado
exige `allowUncovered: true` e expõe o valor sem cobertura. Gastar exige reserva suficiente e
publica uma despesa `wallet` vinculada à meta junto com o movimento `spend`, na mesma transação.
O saldo reservado é sempre reconstruído pela soma dos movimentos, nunca por um cache mutável.

## Ritmo e sugestão de contribuição

Quando há prazo, o sistema calcula contribuição periódica necessária usando valor restante e períodos restantes. O cálculo é determinístico, mostra fórmula e nunca cria transação automaticamente. Prazo vencido ou valor impossível produz orientação, não erro genérico.

## Projeção financeira

- Horizonte padrão e máximo do MVP: 12 meses.
- Ponto inicial: saldo atual da carteira.
- Entradas: compromissos planejados, ocorrências recorrentes, parcelas, faturas, pagamentos de empréstimo e contribuições de meta planejadas.
- Compra no cartão aparece como despesa na análise e sua fatura como saída de caixa; a projeção de saldo usa apenas a saída da fatura para não duplicar.
- Recorrência variável sem estimativa aparece como evento de valor desconhecido e reduz confiança, sem assumir zero silenciosamente.
- Cada ponto permite abrir os eventos que explicam o total.
- Simulação permite alterar temporariamente valor/data de um evento ou adicionar gasto hipotético; simulação nunca grava dados até ação explícita `Aplicar como planejamento`.

## Valor seguro para gastar

O indicador responde “quanto posso gastar sem consumir reservas ou deixar compromissos descobertos no horizonte?”. O horizonte padrão é 30 dias e pode ser alterado.

`seguro = max(0, saldo atual + entradas planejadas no horizonte − saídas planejadas no horizonte − reservas cobertas − margem de segurança)`

Na resposta, `loanReceivable` está incluído nas entradas planejadas e
`loanPayable` nas saídas planejadas, ambos também apresentados separadamente
para que a explicação não esconda o efeito dos empréstimos.

- Faturas entram como saída; suas compras não entram novamente na fórmula de caixa.
- Compromissos vencidos entram antes dos futuros.
- Reserva coberta é limitada ao saldo disponível para evitar subtração dupla de reserva já descoberta.
- Margem de segurança padrão é zero no onboarding; o usuário pode definir valor fixo. Percentuais ficam fora do MVP.
- O valor bruto negativo também é mostrado na explicação como déficit previsto; o CTA muda de `Ver quanto posso gastar` para `Revisar déficit`.
- O indicador nunca é apresentado quando faltam saldo inicial e eventos suficientes; nesse caso, mostra passos objetivos para aumentar a confiança.
- Empréstimos em aberto com vencimento no horizonte são projetados pelo saldo principal restante reconstruído até `asOf`: pagamentos com data posterior à referência ainda não reduzem o saldo histórico. Um empréstimo concedido aumenta `loanReceivable` e uma obrigação recebida aumenta `loanPayable`. O principal e os pagamentos já publicados no ledger não são somados novamente como receita ou despesa.

No backend do MVP, a leitura reconstruível fica disponível em
`GET /v1/workspaces/{workspaceId}/insights/financial` e o cálculo em
`GET /v1/workspaces/{workspaceId}/insights/safe-to-spend`. Ambos aceitam datas civis
determinísticas; o segundo aceita `horizonDays` entre 1 e 365. A resposta do valor
seguro inclui `gross`, `safe`, `available`, `confidence` e o breakdown de saldo,
entradas, saídas da carteira, faturas, reservas cobertas/descobertas e margem.
O breakdown também expõe `loanReceivable` e `loanPayable`; esses valores já
estão incluídos, respectivamente, em `plannedIncome` e `plannedOutflow`, sem
dupla contagem.
Quando ainda não há evento publicado de abertura ou conferência de saldo para
sustentar o saldo, `available` é `false` e os valores `safe`/`gross` são nulos,
mesmo que o breakdown mostre os dados observados. A UI deve transformar a razão
de baixa confiança em ação objetiva.

### Confiança

- **Alta:** saldo foi conferido recentemente e todos os eventos variáveis do horizonte têm estimativa.
- **Média:** saldo existe, mas há eventos variáveis sem confirmação ou saldo não foi conferido nos últimos 30 dias.
- **Baixa:** saldo inicial nunca foi conferido, há import pendente ou faltam valores materiais.

Confiança é regra determinística e explicável, não inferência de IA.

## Painel “Hoje”

Prioriza ação, não volume de gráficos:

1. saldo e última conferência;
2. valor seguro ou déficit com explicação;
3. contas vencidas e próximas em sete dias;
4. fatura mais próxima;
5. meta que exige ação;
6. itens faltando em casa.

Cards sem dados usam empty state acionável. O usuário pode ocultar um card não aplicável, e restaurá-lo nas configurações. Valores sensíveis podem ser ocultados visualmente por sessão, sem removê-los da árvore acessível de modo enganoso; o controle anuncia o estado.

## Critérios de aceitação

- [x] Reservar e retirar valores não altera saldo nem resultado financeiro (backend/subledger).
- [x] Gastar uma reserva vincula despesa e liberação sem dupla contagem (backend/subledger).
- [ ] Projeção de 12 meses reconcilia cada ponto com seus eventos de origem.
- [ ] Valor seguro trata faturas, atrasos, reservas, margem, déficit e dados desconhecidos conforme a fórmula.
- [ ] Nível de confiança muda por regras verificáveis e sua causa fica visível.
- [ ] Simulação não persiste sem confirmação explícita.
- [ ] O painel apresenta primeiro os itens que exigem ação e funciona sem depender de gráficos.
