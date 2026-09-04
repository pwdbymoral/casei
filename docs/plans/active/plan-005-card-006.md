# Plano: PLAN-005/CARD-006 — compromissos e visão de faturas

- Status: ativo
- Spec associada: [finanças](../../specs/financas.md) e [cartões de crédito](../../specs/cartoes-de-credito.md)

## Objetivo

Substituir o placeholder de planejamento da tela de finanças por um fluxo mínimo
para revisar compromissos próximos/vencidos, liquidar valores parciais ou totais,
confirmar valores efetivos e criar recorrências ou parcelamentos com prévia.
Completar também o caminho de pagamento parcial de faturas sem alterar o backend
ou duplicar seus lançamentos canônicos.

## Estado inicial

A API já expõe `POST /transactions/:id/post`, criação de recorrências,
parcelamentos e pagamento de fatura. O adapter web expõe apenas criação e
pagamento total; a seção de planejamento ainda informa que a tela seria criada
depois. A tela de cartões já lista faturas e composição, mas não oferece valor
parcial informado pelo usuário.

## Abordagem

- estender o adapter HTTP/fixture com liquidação versionada (`If-Match` e
  `Idempotency-Key`) e manter os campos de moeda/data no contrato;
- derivar compromissos da lista paginada de transações, separando próximos e
  vencidos sem incluir fatos já publicados ou cancelados;
- executar uma consulta própria sem filtros da timeline, percorrendo todos os
  cursores, para compor saldo da carteira e compromissos sem depender da página
  ou dos filtros atualmente visíveis;
- compor dialogs acessíveis para liquidação, recorrência e parcelamento, com
  valores e prévia visíveis antes da confirmação;
- adicionar pagamento parcial de fatura usando o endpoint existente;
- manter cada ação isolada por workspace, respeitar viewer e preservar os
  estados de loading, erro, sucesso e conflito.

## Etapas

- [x] Definir contrato do adapter e testes Red→Green para liquidação e pagamento parcial.
- [x] Implementar compromissos e diálogos de captura/settlement na tela de finanças.
- [x] Implementar criação de recorrência e parcelamento com prévia local.
- [x] Completar pagamento parcial e composição explicável de faturas.
- [x] Conectar IDs de origem e editar recorrências por escopo e planos de parcelas pela tela de finanças.
- [ ] Validar browser responsivo/acessível, testes, typecheck e abrir PR para revisão.

## Rastreabilidade

- Conta a pagar/receber: `finance.ts`, `finances/page.tsx` e testes do adapter cobrem
  `planned`/`partially_settled`, valor efetivo, `If-Match` e idempotência.
- Recorrência/parcelamento: dialogs enviam os contratos existentes e exibem a
  prévia antes de confirmar; o servidor continua autoridade sobre datas e centavos.
- Fatura: pagamento parcial usa `payStatement` e atualiza o saldo aberto retornado
  pelo servidor; a composição continua no endpoint de itens.

## Riscos

- A consulta sem filtros percorre todos os cursores para manter o saldo e os
  compromissos completos; uma rota agregada/read model do servidor poderá
  substituir essa leitura em fatia posterior sem mudar o fluxo.
- O shell fornece o fuso IANA do workspace ao browser, e os defaults de data
  usam esse calendário civil (não o fuso local do dispositivo).
- A API expõe `recurrenceId` e `installmentPlanId` quando disponíveis. Os campos são opcionais
  para manter compatibilidade com respostas legadas; a validação de recorrência variável continua
  no servidor.

## Validação

- `pnpm --filter web test`
- `pnpm --filter web typecheck`
- `pnpm lint`
- validação manual no browser em largura móvel e desktop, incluindo teclado,
  dialog de erro, viewer e pagamento parcial.

## Decisões durante a implementação

- A prévia de parcelas usa a distribuição determinística disponível no domínio
  visualmente antes do submit; o valor retornado pela API continua a fonte de
  verdade e a tela recarrega após sucesso.
- A edição de recorrência exige ocorrência materializada e oferece os três escopos do contrato.
  Edição de parcela só habilita itens planejados e mantém o total por redistribuição das futuras.
