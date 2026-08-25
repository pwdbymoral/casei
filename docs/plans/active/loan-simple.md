# Plano: LOAN-001/002 IOU simples

- Status: em andamento — histórico persistente LOAN-003
- Spec associada: [finanças](../../specs/financas.md)
- Plano macro: [MVP Casei](mvp-casei.md)

## Objetivo

Representar empréstimos pessoais concedidos ou recebidos como contratos de
principal, sem classificar o principal como renda ou despesa e sem duplicar o
efeito de caixa no ledger.

## Critérios de aceitação

- Criar contrato exige direção, contraparte, principal, data e vencimento
  opcional; moeda deve ser a do espaço e o contrato inicia `open`.
- Conceder publica `wallet → loan receivable`; receber publica
  `loan payable → wallet`; nenhum evento usa contas de receita/despesa.
- Pagamento parcial ou total exige valor positivo, não excede o saldo e publica
  somente o principal efetivo na direção inversa.
- O último pagamento deixa saldo zero e status `settled`; saldo nunca fica
  negativo.
- Criação e pagamento são idempotentes; pagamento usa `If-Match`/versão e
  locks para serializar concorrência.
- Auditoria registra origem, autor, correlação e snapshots sanitizados do
  contrato/pagamento.
- Juros, tarifas, baixa e perdão não têm campos nem comandos nesta fatia.
- O purge de um espaço chama uma rotina `SECURITY DEFINER` que seleciona apenas
  eventos de empréstimos daquele espaço, remove entradas antes dos eventos e
  mantém a auditoria detached. A rotina valida tipo `loan.*`, workspace e
  ausência de `transaction_id` antes de apagar. O role de runtime não pode
  atualizar/apagar pagamentos, eventos ou lançamentos históricos diretamente;
  referências de eventos também são imutáveis.

## Estratégia

1. Atualizar contratos e helpers puros de postings com testes Red/Green.
2. Criar tabelas de contrato/pagamento, constraints, FKs compostas, RLS e
   migration serializada após a base atual.
3. Implementar comandos transacionais no `FinanceService`, rotas e testes de
   isolamento/idempotência/ledger.
4. Atualizar documentação e checklist do MVP; UI ficará para LOAN-003.

## Validação

Domain/contratos, testes de schema e integração PostgreSQL devem cobrir as duas
direções, pagamentos parciais/totais, excedente, retry, concorrência, moeda,
RLS e ausência de contas income/expense nos eventos.

## Evidência da entrega

- Helpers de postings puros cobrem principal e pagamento nas duas direções.
- API cobre criação, listagem, detalhe e pagamento com idempotência/versão.
- PostgreSQL cobre migration `0013_loans`, FKs compostas, RLS, ledger,
  auditoria, retry, excedente e concorrência.
- A jornada visual foi adicionada em LOAN-003 depois da estabilização do
  contrato; a limitação de leitura detalhada do histórico está registrada
  abaixo.

## LOAN-003 — incremento web

O incremento web foi implementado na rota `/app/loans` com:

- adapter HTTP/fixture tipado para listar contratos, criar empréstimo com
  idempotência e registrar pagamento com `If-Match`/versão;
- resumo separado de valores a receber, a pagar e contratos em aberto;
- cadastro curto de contraparte, principal, data e vencimento opcional;
- confirmação de pagamento parcial ou total, atualização de saldo/status e
  tratamento de conflito, erro, offline, permissão e espaço vazio;
- cronograma baseado somente no vencimento informado e previsão explícita sem
  presumir parcelas, juros ou tarifas;
- histórico visual do contrato e dos pagamentos carregado pela leitura
  persistente do contrato; o fixture implementa o mesmo contrato para o
  desenvolvimento local.

### Histórico persistente de pagamentos

- `GET /v1/workspaces/:workspaceId/loans/:loanId/payments` retorna os pagamentos
  persistidos em páginas com cursor opaco e assinado, ordenados por data civil e
  ID decrescentes.
- Serviço, rota e adapter validam contrato e workspace antes da leitura; um ID
  pertencente a outro espaço se comporta como não encontrado.
- A UI carrega todas as páginas do histórico real ao abrir o espaço e mantém o
  novo pagamento na ordem civil canônica, sem duplicá-lo sob retry.
- Testes cobrem paginação, cursor inválido, isolamento entre espaços, contrato
  inexistente e mapeamento HTTP/fixture.

Validação local desta extensão: o ciclo Red confirmou ausência de schema,
serviço e rota; depois do Green, as suítes da API (129 testes) e web (103
testes), typecheck de API/web/contracts e builds de API/web passaram. A rota
`/app/loans` foi validada no navegador com fixtures após recarregamento, em
390 px e 1440 px, sem overflow horizontal nem erro de console. Os testes
PostgreSQL de paginação e isolamento ficam condicionados a `DATABASE_URL_TEST`
e foram coletados, mas pulados no ambiente local sem esse serviço. A
revalidação browser desta correção ficou indisponível porque a sessão
Playwright compartilhada estava em uso; a ordenação retroativa foi coberta
pela suíte unitária do adapter.
