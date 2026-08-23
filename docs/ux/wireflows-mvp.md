# Wireflows de baixa fidelidade do MVP

- Status: vigente como contrato de fluxo; aparência visual ainda não foi desenhada
- Specs relacionadas: [MVP](../specs/mvp-casei.md) e specs de domínio em `docs/specs/`

## Objetivo e limites

Este documento define tarefa, informação, ação, estados e mudança responsiva das jornadas críticas. Ele não define marca, ilustração, token final ou pixel. Agentes podem compor as telas a partir destes fluxos, mas qualquer mudança de consequência, campo obrigatório ou hierarquia exige primeiro atualizar a spec.

## Shell e navegação

### Telefone

```text
┌──────────────────────────────┐
│ Casei          [espaço] [•••]│
│ conteúdo rolável             │
│                              │
│                       [+]    │  ação Adicionar, acima da safe area
├──────────────────────────────┤
│ Hoje  Finanças  Metas  Casa  │
│              [Mais]          │
└──────────────────────────────┘
```

`Mais` contém Relatórios, Configurações, Ajuda e sair. A área ativa é anunciada e não depende só de cor. Troca de espaço limpa caches e volta a `Hoje` no novo escopo após confirmação visual.

### Tablet

Navegação pode virar rail lateral compacto quando isso reduzir scroll sem estreitar o conteúdo. Formulários mantêm largura de leitura e detalhes podem ocupar painel lateral. Não usar simplesmente grid desktop comprimido.

### Desktop

Sidebar persistente contém espaço ativo, áreas e perfil. Header contextual contém título, filtros principais e ação primária. Conteúdo usa largura máxima adequada; listas podem dividir mestre/detalhe quando a URL representa a seleção.

### Estados do shell

- sessão carregando: shell skeleton sem mostrar dados de outro espaço;
- sessão expirada: preservar rascunho local, pedir login e retomar somente após validar o mesmo usuário/espaço;
- offline: banner persistente não modal, timestamp do conteúdo e mutações desabilitadas com explicação;
- permissão removida: limpar dados do espaço e encaminhar para seletor, sem manter tela sensível;
- nenhum espaço: onboarding ou aceite de convite, nunca dashboard vazio quebrado.

## Jornada 1 — cadastro e onboarding

```text
Criar conta
  → e-mail + senha + nome
  → confirmação “Verifique seu e-mail” [Reenviar]
  → link verificado
  → Criar espaço: nome + fuso/moeda sugeridos e visíveis
  → Saldo inicial? [Informar agora] [Pular]
  → Hoje com checklist inicial curto
```

- Ação principal por etapa: `Criar conta`, `Criar meu espaço`, `Começar`.
- Nome, e-mail e senha possuem labels persistentes/autocomplete; não bloquear paste.
- Fuso/moeda aparecem como defaults editáveis, não em detalhes escondidos.
- `Pular saldo` explica que projeções começarão com confiança baixa.
- Refresh retoma a etapa concluída; retry não cria segundo espaço.
- E-mail já usado recebe resposta não enumerável e caminho de login/recuperação sem confirmar cadastro.
- Convite abre fluxo equivalente, mas após autenticar mostra espaço, emissor e papel antes de `Entrar no espaço`.

## Jornada 2 — captura rápida financeira

### Entrada

`Adicionar` abre escolhas grandes: `Despesa`, `Receita`, `Compra no cartão`, `Conta futura`, `Movimentar estoque`, `Produto`. Atalho contextual, como `Adicionar despesa`, pula essa escolha.

### Despesa/receita simples

```text
Drawer (estreito) / Dialog (amplo)
  Título: Nova despesa
  [R$ 0,00] ← autofocus, teclado numérico apropriado
  Hoje • Carteira • Realizada  [alterar]
  [Mais detalhes ▾]
  [Salvar despesa]
```

- Somente valor é obrigatório; botão descreve o resultado.
- `Mais detalhes`: descrição, categoria, data, estado/vencimento, responsável e nota.
- Salvar mostra busy, bloqueia duplo submit e mantém Escape indisponível apenas durante o commit curto.
- Sucesso fecha, restaura foco e anuncia `Despesa de R$ X salva`, com `Desfazer` quando seguro.
- Erro de campo mantém overlay e foca primeiro erro; falha de rede preserva tudo e oferece `Tentar novamente` com mesma chave.
- Fechar com dados alterados oferece descartar ou continuar; sem alterações fecha diretamente.

### Compra no cartão

Mesmo fluxo, acrescentando cartão obrigatório abaixo do valor. Mostra fatura sugerida e `1x`; `Parcelar` expande quantidade e preview. Alterar fatura é detalhe avançado, mas a sugestão permanece visível antes de salvar.

## Jornada 3 — linha do tempo e edição

```text
Finanças
  saldo + conferir/ajustar
  [Buscar] [Período] [Filtros]
  grupos por data
    transação: nome, estado, meio, valor
  selecionar → detalhe em página/painel com URL
```

- Mobile navega para detalhe; desktop pode abrir painel sem perder lista.
- Detalhe mostra efeito: `Carteira −R$ X`, `Despesa +R$ X`, `Fatura Y`.
- `Editar` abre formulário preenchido e consequências. `Cancelar/reverter` usa AlertDialog apenas quando o custo justifica.
- Conflito 412 mostra `Esta transação mudou desde que você abriu`, valores atuais e ações `Recarregar`/`Revisar minha alteração`.
- Filtros vazios mostram `Nenhuma transação com estes filtros` e `Limpar filtros`; vazio inicial explica captura.

## Jornada 4 — recorrência e parcelas

```text
Mais detalhes → [Tornar recorrente] ou [Parcelar]
  regra/quantidade
  início e fim
  preview das próximas ocorrências
  [Salvar série/plano]

Editar ocorrência ligada
  O que deseja alterar?
  ( ) Só esta
  ( ) Esta e futuras
  ( ) Todas as futuras ainda não realizadas
  resumo da consequência
  [Aplicar alteração]
```

Opções usam RadioGroup/FieldSet, não botões soltos. Valores variáveis recebem `Confirmar valor` no painel Hoje; não há liquidação silenciosa pela estimativa.

## Jornada 5 — cartão, fatura e pagamento

```text
Finanças → Cartões
  cartões: fatura atual, vence, estado, limite se conhecido
  → Cartão
     seletor de faturas
     resumo: total, pago, aberto, vencimento
     lista agrupada de compras/estornos/tarifas
     [Adicionar compra] [Pagar fatura]
```

`Pagar fatura` abre valor em aberto como default, carteira e data. Antes de confirmar, mostra `Sua carteira diminuirá R$ X; suas despesas não mudarão`. Pagamento excedente troca o resumo para `Gerará crédito de R$ Y` e exige confirmação consciente.

Fatura vencida prioriza pagar e revisar. Fechar/reabrir fatura fica secundário e mostra itens afetados. Mover compra oferece somente faturas adjacentes válidas, com preview.

## Jornada 6 — empréstimo e meta

### Empréstimo

Escolher `Emprestei dinheiro` ou `Peguei emprestado` antes do formulário elimina sinais negativos. Resumo sempre separa principal, juros/tarifas e previsão de quitação. Registrar pagamento mostra efeitos em carteira e saldo da dívida/recebível.

### Meta

```text
Metas → Nova meta
  nome + valor alvo
  [Mais detalhes: prazo, prioridade]
  [Criar meta]

Meta → [Reservar] [Usar valor] [Retirar reserva]
```

Reservar mostra `Seu saldo total não muda; R$ X ficará separado do valor livre`. Reserva sem cobertura pede confirmação. Usar valor conduz à transação real e mostra a liberação conjunta antes de salvar.

## Jornada 7 — estoque e mercado

```text
Casa
  busca
  chips: Lista de compras | Faltando | Todos
  item: nome, quantidade/estado, [−] [+] [•••]
  [+ Produto]
```

- Criar produto pede apenas nome; detalhes ficam recolhidos.
- `−` nunca reduz abaixo de zero e anuncia nova quantidade.
- Ações por gesto, se adicionadas, repetem-se em menu/botão visível.
- Lista de compras mantém item marcado na sessão e oferece `Finalizar compra`.
- Finalizar abre revisão de quantidades: `Adicionar estes itens ao estoque` marcado por item, nunca global oculto; vínculo com despesa é opcional depois.
- Offline permite consultar snapshot com horário, mas controles de mutação explicam que precisam de conexão.

### Cadastro em lote

Entrada simples é textarea `Um produto por linha`, aceitando paste. `Modo avançado` abre grid editável com cabeçalhos persistentes e teclado. Ambos passam por preview `Novos / Atualizações / Duplicatas / Erros` antes de aplicar.

## Jornada 8 — importação/exportação

```text
Configurações → Importar dados
  1. domínio + arquivo
  2. detecção/mapeamento
  3. preview e política de duplicata
  4. confirmação
  5. progresso em background
  6. resultado + baixar erros
```

- Stepper comunica posição por texto e semântica; voltar preserva decisões.
- Upload informa formatos/limites antes de escolher arquivo.
- Mapping usa selects nomeados e amostra de valores; colunas obrigatórias ausentes aparecem junto do campo.
- Preview prioriza contagens e erros acionáveis; tabela completa fica em região rolável nomeada.
- O usuário escolhe `Somente linhas válidas` ou `Tudo ou nada` antes de confirmar.
- Sair durante processamento não cancela; o job aparece no centro de atividades. Cancelar explica que lotes já aplicados permanecem.

Exportar usa filtros atuais por default, resume conteúdo e período, e informa expiração antes de `Gerar arquivo`.

## Jornada 9 — painel Hoje e valor seguro

```text
Hoje
  Saudação curta + espaço
  Saldo atual [ocultar]
  Pode gastar / Déficit previsto [Entender cálculo]
  Precisa de atenção: vencidas, próximos 7 dias
  Fatura mais próxima
  Meta em risco
  Itens faltando
```

Cards ausentes não viram zeros enganadores. `Entender cálculo` abre decomposição navegável: saldo, entradas, compromissos, reservas, margem e confiança. Cada linha abre a origem. Déficit usa texto/ícone além de cor e CTA `Revisar déficit`.

## Jornada 10 — administração

Admin usa layout visualmente distinto e banner persistente `Administração da plataforma`, sem botão para entrar em espaço.

```text
Admin → Contas
  busca por ID/e-mail
  resultado com metadados mínimos
  → detalhe
     status, sessões, espaços (nome/ID/contagens), auditoria
     [Revogar sessões] [Suspender acesso]
```

Ação crítica abre Dialog com consequência, motivo obrigatório e step-up TOTP. Confirmação nomeia a ação (`Suspender acesso`), não `Confirmar`. Sucesso mostra correlation ID; falha preserva motivo sem expor conteúdo. Support não vê ações sem permissão.

## Matriz de estados por superfície

| Superfície | Loading | Empty | Error | Offline | Permission/conflict |
| --- | --- | --- | --- | --- | --- |
| Hoje | skeleton por card | checklist inicial | retry por card/global conforme falha | timestamp e somente cache permitido | remove conteúdo ao perder membership |
| Listas | skeleton de linhas | inicial ou por filtro distintos | retry sem perder filtros | snapshot quando aprovado | 404/sem enumeração |
| Formulário | estado inicial imediato | não aplicável | campos + resumo/retry | rascunho não salvo | 412 com revisão |
| Job | progresso indeterminado/determinado | histórico vazio | resultado parcial + retry seguro | último estado, sem controlar | download revalida permissão |
| Admin | skeleton sem dado doméstico | nenhum resultado | correlation ID | indisponível | 403 sem renderizar shell admin |

## Componentes e política de composição

- Instalar somente via registry oficial e após consultar a CLI/docs da versão: Sidebar, Drawer, Dialog, Field, InputGroup, Select/Combobox, RadioGroup, AlertDialog, Empty, Skeleton, Alert, Progress, Table/DataTable, Pagination, DropdownMenu e Toast compatível com Base UI.
- Reusar Button, Card e Badge existentes.
- Componentes de domínio ficam fora de `components/ui`: `QuickAdd`, `TransactionRow`, `StatementSummary`, `GoalProgress`, `StockItem`, `SafeToSpendBreakdown`, `ImportMapping`.
- `MoneyInput` pode ser componente compartilhado de formulário composto por primitives; não deve mascarar valor sem manter label, caret, paste e erro acessíveis.
- Nenhum primitive customizado está autorizado por este wireflow. Lacuna descoberta exige justificativa e revisão.

## Contrato de validação futura

Este artefato é documentação de protótipo, portanto não possui browser runtime para validar. Cada implementação deve testar interativamente:

- 320, 390, 768/820, 1024, 1280 e intervalos onde a composição muda;
- teclado, foco, Escape/retorno de foco, zoom 200%, reduced motion e teclado virtual;
- texto/números longos, zero/poucos/muitos itens, loading, empty, error, offline, permissão e conflito;
- ação principal, cancelamento, retry idempotente e preservação de rascunho.
