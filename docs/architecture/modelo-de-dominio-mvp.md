# Arquitetura: modelo de domínio do MVP

- Status: vigente; ADRs e contratos necessários à implementação estão aprovados
- Specs relacionadas: [MVP](../specs/mvp-casei.md), [finanças](../specs/financas.md), [cartões](../specs/cartoes-de-credito.md), [metas](../specs/metas-e-planejamento.md), [estoque](../specs/estoque-domestico.md), [intercâmbio](../specs/intercambio-de-dados.md) e [identidade](../specs/identidade-e-administracao.md)

## Objetivo

Definir boundaries, invariantes e contratos suficientes para agentes implementarem fatias verticais sem criar fontes concorrentes de saldo, autorização ou histórico. Nomes físicos podem ser refinados na tarefa de schema, mas relações e invariantes não podem ser alterados sem atualizar a spec e registrar decisão arquitetural quando material.

## Contextos e direção de dependência

| Contexto | Responsabilidade | Pode depender de |
| --- | --- | --- |
| Identity | usuário, sessão e credencial | infraestrutura de autenticação/e-mail |
| Workspace | espaço, membership, convite e preferência | Identity |
| Ledger | lançamentos financeiros, saldo e resultado | Workspace |
| Planning | transação planejada, série, parcela e projeção | Ledger, Workspace |
| Credit | cartão, ciclo, fatura, compra e pagamento | Ledger, Planning |
| Lending | empréstimo, saldo principal e pagamento | Ledger, Planning |
| Goals | meta e reserva virtual | Ledger, Planning |
| Inventory | produto, movimentação e lista | Workspace; vínculo opcional por ID com Ledger |
| Data Exchange | upload, mapeamento, job e export | APIs públicas dos contextos, nunca escrita direta em tabelas internas |
| Admin | operação da plataforma | Identity, Workspace e metadados operacionais |
| Audit | trilha append-only | recebe eventos de todos; nenhum domínio depende dela para calcular estado |

Não há import circular entre pacotes de domínio. Integrações entre contextos usam comandos explícitos dentro da mesma unidade de aplicação ou eventos transacionais/outbox quando assíncronas.

## Modelo financeiro: livro razão como fonte canônica

### Contas internas

Cada espaço possui, no mínimo:

- uma conta de ativo `wallet`;
- uma conta de passivo por cartão;
- uma conta de ativo recebível por empréstimo concedido;
- uma conta de passivo por empréstimo recebido;
- contas de receita e despesa associáveis a categorias;
- uma conta técnica de ajuste/patrimônio.

Essas contas são implementação interna. A interface continua dizendo “carteira”, “cartão”, “empréstimo” e “categoria”. Meta é reserva virtual em subledger próprio, não uma segunda conta de dinheiro.

### Evento financeiro e lançamentos

Uma transação visível descreve a intenção do usuário. Quando realizada/publicada, ela gera um evento financeiro com dois ou mais lançamentos imutáveis cuja soma algébrica é zero na moeda do espaço. O evento e todos os lançamentos são gravados na mesma transação PostgreSQL. Realizar uma compra no cartão publica despesa e passivo sem liquidar caixa; a liquidação de caixa acontece em outro evento, no pagamento da fatura.

| Intenção | Débito interno | Crédito interno | Efeito percebido |
| --- | --- | --- | --- |
| Receita na carteira | wallet | income | aumenta saldo e renda |
| Despesa na carteira | expense | wallet | reduz saldo e resultado |
| Compra no cartão | expense | card liability | aumenta despesa e dívida |
| Pagamento de fatura | card liability | wallet | reduz dívida e carteira |
| Empréstimo concedido | loan receivable | wallet | troca caixa por recebível |
| Reembolso recebido | wallet | loan receivable | reduz recebível |
| Empréstimo tomado | wallet | loan payable | aumenta caixa e dívida |
| Pagamento de principal | loan payable | wallet | reduz caixa e dívida |
| Ajuste positivo | wallet | adjustment equity | reconcilia saldo |

Juros e tarifas usam despesa separada. Estorno e cancelamento após lançamento criam evento reversor vinculado; não apagam nem alteram lançamentos publicados. Uma correção gera reversão e substituição na mesma operação atômica.

### Saldos e projeções

- Saldo atual é soma dos lançamentos publicados na conta wallet até o dia atual do espaço.
- Dívida/recebível é soma da conta correspondente; valores derivados podem ser cacheados somente como projeção reconstruível.
- Planejados não entram no livro razão até serem realizados/publicados, mas alimentam projeção em read model separado.
- Reserva de meta possui movimentações próprias e deve reconciliar com o total reservado exibido.
- Read models e agregados mensais carregam checkpoint/versão da origem e podem ser reconstruídos. Nunca são editados por endpoint público.

## Agregados e invariantes

### Workspace

- Raiz: `Workspace`; filhos: `Membership`, `Invitation`, `WorkspacePreference`.
- Todo agregado de negócio carrega `workspaceId` imutável.
- Referências entre entidades com escopo usam chave composta `(workspace_id, id)` sempre que o banco permitir, impedindo vínculos cruzados.
- Membership e papel são consultados a cada mutação; esconder botão no cliente não autoriza ação.

### Transaction

- Raiz: `Transaction`; versões planejada e efetiva; vínculos opcionais para série, parcela, fatura, empréstimo, meta, import e reversão.
- Instrumento aceita somente wallet ou cartão ativo compatível.
- Estado e lançamentos mudam por comandos de domínio, nunca por `PATCH` genérico de campos.
- `version` aumenta a cada edição e participa de optimistic concurrency.

### Schedule e InstallmentPlan

- A regra é separada das ocorrências materializadas.
- Cada ocorrência possui chave natural `(schedule_id, occurrence_date)` ou `(plan_id, installment_number)` e constraint única.
- Geração é determinística e idempotente. Ocorrência realizada fica destacada da mutabilidade da regra.

### CreditCard e Statement

- Cartão define somente defaults de ciclos futuros.
- Statement persiste início, fechamento e vencimento calculados para preservar história.
- Compra/parcela referencia exatamente um statement aberto/fechado; pagamento referencia um ou mais statements de forma explícita.
- Transições de estado passam por comandos `close`, `reopen`, `pay`, `cancelPayment`, `applyCredit`.

### Loan

- Direção é `lent` ou `borrowed`; principal, saldo e contraparte são obrigatórios.
- Cada pagamento separa principal, juros e tarifa. Principal aplicado não excede saldo.
- Agenda opcional gera ocorrências por Planning, mas saldo é derivado do Ledger.

### Goal

- Movimentações `allocate`, `release` e `spend` formam subledger append-only.
- Total reservado é soma dessas movimentações; `spend` referencia a transação financeira correspondente.
- Operação `spend` grava liberação e evento financeiro atomicamente.

### InventoryProduct

- Produto contém unidade imutável após histórico, preferências de mínimo e marcação manual.
- Quantidade é soma de movimentos ou snapshot reconciliável com movimentos.
- Movimento possui delta, quantidade anterior/posterior e motivo. Constraint impede resultado negativo.
- Shopping item pode referenciar produto ou ser livre; unicidade evita dois itens ativos do mesmo produto.

### ImportJob e ExportJob

- Upload, análise, decisão e aplicação têm estados separados.
- Linha validada vira comando do contexto-alvo; importador não escreve diretamente em ledger, estoque ou cartão.
- Job possui chave idempotente, hash do arquivo, versão do mapeamento, contagens e cursor de lote.
- Job também persiste `actorId`, `workspaceId` e `requiredCapability`; cada lote/transição revalida essa autorização com lock da membership antes de chamar o caso de uso.
- Arquivo temporário reside em armazenamento de objetos compatível com S3 via adapter aprovado e expira, conforme [ADR de objetos](decisions/0007-armazenamento-temporario-de-objetos.md).

## Contratos de aplicação e API

### Camadas

- `packages/contracts`: schemas Zod de request/response/evento público, sem ORM ou React.
- `packages/domain`: value objects, regras puras, comandos e políticas, sem HTTP ou banco.
- `packages/database`: schema Drizzle, migrações e adapters/repositories PostgreSQL.
- `apps/api`: autenticação, autorização, parsing, transação, idempotência, orquestração e representação HTTP.
- `apps/web`: apresentação, estado de formulário/cache e composição de componentes; não recalcula regra financeira canônica.
- `apps/worker`: consome jobs persistidos no PostgreSQL usando os mesmos casos de uso, conforme [ADR de jobs](decisions/0006-jobs-duraveis-no-postgresql.md); o MVP não usa Redis.

### Convenções HTTP aprovadas

- Prefixo `/v1`; recursos aninhados sob `/workspaces/:workspaceId` quando pertencem ao espaço.
- Requests e responses validados por schema compartilhado; dinheiro trafega como string decimal canônica ou inteiro de centavos documentado, nunca float.
- Datas civis usam `YYYY-MM-DD`; instantes usam ISO 8601 UTC.
- Mutação recebe `Idempotency-Key`; edição recebe `If-Match` ou `version` equivalente.
- Erro possui `code`, mensagem segura, `fieldErrors` opcional e `correlationId`; status distingue validação, autenticação, autorização disfarçada como not-found, conflito e indisponibilidade.
- Listas usam cursor opaco, limite máximo e ordenação documentada.

### Unidade transacional

Uma transação de banco cobre qualquer comando que altere mais de um invariante, incluindo:

- transação visível + evento + lançamentos + auditoria/outbox;
- compra + parcela + associação à fatura;
- pagamento + carteira + passivo + estado da fatura;
- gasto de meta + liberação de reserva;
- aceite de convite + membership + consumo do token;
- movimento de estoque + quantidade/snapshot + item da lista quando aplicável.

E-mail, geração de arquivo e projeções pesadas ocorrem depois do commit via outbox/job. Falha assíncrona é observável e repetível sem repetir o comando principal.

## Jobs, relógio e idempotência

- Jobs duráveis ficam no PostgreSQL com estado, tentativas, próxima execução, lease e erro sanitizado.
- Workers adquirem lease atomicamente; conclusão e retry são idempotentes.
- Relógio é injetável no domínio e testes. “Hoje” sempre deriva do fuso do espaço.
- Geração de recorrências, fechamento de faturas, expiração de convites/arquivos e construção de exports possuem chaves naturais únicas.
- Dead-letter operacional aparece no console administrativo com ação segura de retry.

## Autorização e privacidade

- Handlers constroem `RequestActor` e `WorkspaceScope` após validar sessão e membership; repositories scoped não aceitam consulta de entidade doméstica sem `workspaceId`.
- Administração usa middleware, rotas e serviço próprios. Papel de plataforma não satisfaz automaticamente políticas de workspace.
- Logs estruturados incluem correlation ID, ator pseudonimizado, rota, resultado e duração; omitem body sensível.
- Auditoria é append-only e separa eventos domésticos de administrativos. Leitura da auditoria também é autorizada.
- Backups, retenção, exclusão por titular e resposta a incidente precisam de runbook antes de beta público.

## Design da interface

O projeto usa shadcn/ui `base-nova`, Base UI, Tailwind v4, CSS variables e Lucide. A implementação segue `reuse → compose → customize → extend → create`.

### Componentes de domínio previstos

- `QuickAdd`, compondo Dialog em telas amplas e Drawer em telas estreitas, com estado compartilhado e títulos acessíveis;
- `MoneyInput`, baseado em Field/InputGroup, mantendo valor exato em centavos e permitindo paste;
- `TransactionRow`, `StatementSummary`, `GoalProgress`, `StockItem` e `ActionableInsight`, compostos a partir de primitives;
- `DataTable` somente para modo avançado/desktop; em telefone, lista semântica com detalhes expansíveis;
- `StatusBadge` com texto/ícone além de cor;
- `AsyncState` usando Skeleton, Alert e Empty oficiais.

Antes de instalar cada primitive, o agente deve inspecionar componentes instalados, buscar registry oficial e ler documentação da versão atual. Componentes de domínio não pertencem a `components/ui`. Um primitive novo exige justificativa conforme a skill do projeto.

### Contrato responsivo e acessível

- Conteúdo começa em 320 CSS px, reflow sem scroll horizontal global; tabela bidimensional usa região rolável nomeada.
- CTA sticky considera safe areas e teclado virtual e nunca cobre erro/foco.
- Touch targets importantes buscam 44–48 CSS px; teclado e foco seguem ordem visual.
- Overlays preservam rascunho, fecham por Escape conforme o primitive e restauram foco ao gatilho.
- Feedback assíncrono usa estado semântico e live region apenas quando necessário.
- Gráficos sempre têm resumo textual/tabela equivalente e não são o único acesso ao dado.

## Observabilidade e testes arquiteturais

- Métricas: latência/erro por caso de uso, retries, jobs atrasados, falhas de autorização, imports por estado e drift de projeção.
- Alertas não carregam conteúdo financeiro.
- Testes de arquitetura impedem imports proibidos e acesso de database fora de adapters autorizados.
- Testes de propriedade verificam soma zero do ledger, conservação em reversões, soma de parcelas e nunca-negatividade do estoque.
- Testes de integração usam PostgreSQL real para constraints, locks, idempotência e isolamento.
- E2E cobre apenas jornadas críticas; variações combinatórias ficam no domínio/API.

## Decisões aprovadas para implementação

1. [Livro razão de dupla entrada e reversão](decisions/0004-livro-razao-financeiro.md).
2. [Better Auth e e-mail transacional por SMTP](decisions/0005-autenticacao-e-email.md).
3. [Jobs duráveis e outbox no PostgreSQL](decisions/0006-jobs-duraveis-no-postgresql.md).
4. [Armazenamento temporário compatível com S3](decisions/0007-armazenamento-temporario-de-objetos.md).
5. [Isolamento por escopo obrigatório e PostgreSQL RLS](decisions/0008-isolamento-por-espaco-e-rls.md).
6. [Representações e protocolos transversais](contratos-transversais-mvp.md).
