# INSIGHT-002 — projeção de caixa em 12 meses

Status: incremento de API/adaptador concluído; composição visual e E2E permanecem pendentes.

## Requisito

Disponibilizar uma projeção determinística de até doze meses, reconstruída das
fontes canônicas do espaço. Cada ponto mensal deve carregar os eventos que
explicam sua variação; recorrências variáveis sem estimativa permanecem
explícitas como eventos desconhecidos.

## Entrega deste incremento

- `GET /v1/workspaces/{workspaceId}/insights/projection?asOf=YYYY-MM-DD&months=1..12`.
- Transações planejadas de carteira, faturas abertas, empréstimos em aberto,
  parcelas e recorrências são normalizadas em eventos; compras de cartão não
  são subtraídas novamente, apenas a fatura gera saída de caixa.
- Reservas de metas não geram saída de caixa e contribuições futuras só entram
  quando registradas como transação planejada; o domínio atual não persiste um
  calendário separado de contribuições, portanto nenhum valor é inventado.
- O saldo inicial vem do mesmo read model reconstruível do valor seguro.
- O contrato e o adaptador web preservam origem, data, direção, valor nulo e
  contagem de desconhecidos.

## Critérios de aceite

- [x] Cada ponto mensal reconcilia seu saldo com os eventos conhecidos da janela.
- [x] Evento variável sem estimativa aparece com `amount: null` e reduz a confiança;
      nunca é tratado silenciosamente como zero.
- [x] Ausência de evidência de saldo mantém a confiança baixa, mesmo com eventos conhecidos.
- [x] Horizonte é limitado a 12 meses e datas civis inválidas são rejeitadas.
- [ ] Tela de projeção permite abrir a composição de cada ponto em telefone e desktop.
- [ ] Jornada crítica possui validação browser/E2E com dados reais de um espaço.

## Evidência

Testes Vitest cobrem reconciliação, ordenação, desconhecidos, imutabilidade da
entrada, contrato e roteamento. A validação visual permanece pendente até a
composição da tela e disponibilidade do Playwright MCP.
