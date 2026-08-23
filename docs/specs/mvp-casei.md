# Specification: MVP operacional do Casei

- Status: vigente

## Contexto e problema

Pessoas, casais e pequenos grupos precisam cuidar de dinheiro, compromissos financeiros, metas e itens da casa sem transformar o registro cotidiano em outro trabalho. Se a captura exigir muitos campos ou decisões, os dados deixam de ser registrados; sem dados consistentes, qualquer previsão ou recomendação perde confiança.

## Objetivo

Entregar um PWA em que um espaço doméstico consiga registrar o que aconteceu em poucos segundos, planejar o que acontecerá, entender o dinheiro disponível, acompanhar metas e saber o que falta em casa. O produto deve explicar seus cálculos e degradar honestamente quando os dados forem insuficientes.

## Atores

- **Proprietário do espaço:** cria o espaço, controla membros, dados e configurações.
- **Membro:** registra e organiza dados conforme sua permissão.
- **Leitor:** consulta dados, sem alterá-los.
- **Administrador da plataforma:** gerencia contas, acesso e operação do serviço sem acesso rotineiro ao conteúdo financeiro ou doméstico.

Uma pessoa pode pertencer a mais de um espaço, mas opera em um espaço ativo por vez. Todo dado de negócio pertence exatamente a um espaço.

## Princípios do produto

- **Capturar primeiro, enriquecer depois:** o caminho rápido exige somente a informação sem a qual o registro seria falso ou ambíguo. Categoria, nota, comprovante e demais detalhes são opcionais ou progressivos.
- **Defaults visíveis e reversíveis:** data atual, carteira única e último meio de pagamento pertinente podem ser sugeridos, nunca aplicados de modo oculto.
- **Uma ação, uma consequência compreensível:** uma compra no cartão é despesa e dívida; o pagamento da fatura reduz carteira e dívida, mas não cria outra despesa.
- **Planejado não é realizado:** projeções, saldo atual e histórico distinguem compromissos futuros de movimentos efetivados.
- **Automação explicável:** sugestões e projeções mostram origem, premissas e nível de confiança; o usuário pode corrigir os dados de origem.
- **Compartilhar sem perder autoria:** toda mudança relevante registra autor, horário e origem.
- **Sem becos sem saída:** erros preservam os valores válidos, ações relevantes oferecem recuperação e nenhum gesto é o único meio de executar uma tarefa.

## Escopo funcional

O MVP inclui, com regras detalhadas nas specs vinculadas:

- identidade, onboarding, espaços compartilhados, convites, papéis e console administrativo em [identidade e administração](identidade-e-administracao.md);
- carteira única, transações, recorrências, parcelas, empréstimos e ajustes em [finanças](financas.md);
- cartões, ciclos, faturas e pagamentos em [cartões de crédito](cartoes-de-credito.md);
- metas, projeção de 12 meses e valor seguro para gastar em [metas e planejamento](metas-e-planejamento.md);
- produtos, movimentações, níveis mínimos e lista de compras em [estoque doméstico](estoque-domestico.md);
- importação e exportação de planilhas em [intercâmbio de dados](intercambio-de-dados.md).

## Arquitetura da informação e jornadas

### Navegação do produto

- **Hoje:** saldo atual, próximos compromissos, fatura corrente, metas em risco, itens em falta e explicação de “quanto posso gastar”.
- **Finanças:** linha do tempo, carteira, recorrências, cartões/faturas, empréstimos e projeção.
- **Metas:** metas ativas, valores reservados, ritmo e simulações.
- **Casa:** estoque, lista de compras e histórico de movimentações.
- **Relatórios:** visão mensal, categorias e exportação. Relatórios não introduzem cálculos diferentes dos domínios de origem.
- **Configurações:** perfil, espaço, membros, categorias, cartões, importação e preferências.
- **Administração:** rota e autorização separadas da experiência doméstica.

Em telefone, as quatro áreas mais frequentes ficam na navegação inferior e as demais no menu “Mais”. Em telas amplas, a mesma hierarquia usa sidebar. A ação global **Adicionar** permanece alcançável, não encobre conteúdo nem depende de hover.

### Captura rápida

1. O usuário escolhe uma ação contextual, como `Despesa`, `Receita`, `Compra no cartão`, `Movimentar estoque` ou `Adicionar produto`.
2. O foco vai para a informação principal, como valor ou produto.
3. A interface mostra os defaults aplicados e permite abrir `Mais detalhes`.
4. Ao salvar, a nova informação aparece imediatamente e uma confirmação oferece `Desfazer` quando a reversão for segura.

Para uma despesa ou receita simples, o caminho conhecido exige no máximo: abrir a ação, informar valor e salvar. O tipo é definido pela ação escolhida; data e carteira têm defaults explícitos. Descrição e categoria podem ficar ausentes e ser enriquecidas depois.

### Busca, filtros e URLs

Busca, período, filtros relevantes, aba e entidade selecionada devem ser representáveis na URL quando fizerem sentido para voltar, atualizar e compartilhar. Filtros ativos permanecem visíveis e removíveis. Listas oferecem estado vazio, carregamento, erro, sem resultados e paginação ou carregamento incremental consistente.

## Requisitos e invariantes transversais

- Valores monetários são persistidos em unidades inteiras da menor denominação; o MVP usa uma moeda configurada por espaço e inicia com BRL.
- Datas civis usam o fuso IANA do espaço; instantes de auditoria usam UTC. O padrão inicial é inferido no onboarding e confirmado pelo proprietário.
- Mutação protegida valida sessão, permissão e `workspaceId` no servidor. Identificadores fornecidos pelo cliente nunca definem autorização sozinhos.
- Operações de criação críticas aceitam chave de idempotência; retry não cria transação, parcela, pagamento, convite ou movimentação duplicada.
- Exclusão de registros com efeito financeiro ou de estoque é lógica e auditável. Quando houver dependências, o sistema cancela/reverte de forma explícita em vez de apagar o histórico.
- Edições concorrentes usam versão do registro; conflito preserva ambas as intenções e pede revisão, sem último-write-wins silencioso.
- Toda lista potencialmente grande é paginada no servidor e possui ordenação determinística.
- O PWA permite ler o shell offline, mas mutações exigem conexão. Formulários em andamento preservam rascunho local temporário e informam claramente que ainda não foram salvos.
- WCAG 2.2 AA é o baseline; tarefas funcionam com teclado, toque, zoom de 200%, reflow equivalente a 320 CSS px e preferência de movimento reduzido.
- Dados sensíveis não aparecem em logs, telemetria, mensagens de erro ou console administrativo. Auditoria registra metadados e referências, não valores desnecessários.

## Estados comuns de interface

Toda jornada deve especificar e implementar, quando aplicável:

- carregamento inicial e atualização em segundo plano sem layout shift relevante;
- vazio inicial com explicação e CTA adequado;
- vazio por filtro, mantendo filtros visíveis;
- sucesso com consequência e próximo passo claros;
- validação no campo e resumo acionável quando houver múltiplos erros;
- falha de rede com dados digitados preservados e retry idempotente;
- dado parcial ou projeção de baixa confiança identificados como tal;
- permissão insuficiente sem revelar existência de dados inacessíveis;
- conflito de edição com comparação entre versão carregada e atual;
- offline, diferenciando conteúdo em cache de dado atualizado.

## Critérios de aceitação do MVP

- [ ] Uma pessoa cria conta e espaço, conclui onboarding e registra receita ou despesa simples pelo caminho rápido sem preencher campos opcionais.
- [ ] Duas pessoas autorizadas compartilham o mesmo espaço; autoria, permissões e isolamento entre espaços são comprovados por testes.
- [ ] Saldo, despesas, dívida de cartão, fatura, metas reservadas e valor seguro para gastar não apresentam dupla contagem nos cenários canônicos.
- [ ] Recorrências, parcelas, vencimentos e ciclos de cartão produzem ocorrências previsíveis e editáveis sem reescrever histórico encerrado.
- [ ] Empréstimos recebidos e concedidos alteram caixa e dívida/recebível sem serem classificados incorretamente como renda ou despesa.
- [ ] Estoque sinaliza falta e gera lista de compras sem exigir integração item a item com transações financeiras.
- [ ] Importação possui mapeamento, prévia, validação, detecção de duplicidade e resultado por linha; exportação produz arquivo reimportável.
- [ ] O painel explica compromissos, projeção e valor seguro para gastar, inclusive quando negativo ou de baixa confiança.
- [ ] Proprietário gerencia membros; administrador da plataforma gerencia contas sem terminal e sem acesso implícito ao conteúdo do espaço.
- [ ] Jornadas críticas passam por testes de domínio, integração de API e E2E, além de validação manual responsiva e de acessibilidade.

## Métricas de produto

- Mediana de tempo entre abrir captura rápida e salvar uma transação simples.
- Percentual de capturas simples concluídas sem abrir detalhes avançados.
- Retenção de espaços que registram em pelo menos três dias de cada semana.
- Percentual de recorrências previstas confirmadas ou corrigidas.
- Quantidade de imports com erro, duplicata evitada e correção concluída.
- Uso da explicação do valor seguro para gastar e frequência de correção dos dados de origem.

As métricas não devem registrar descrição, contraparte, produto, valor individual ou outro conteúdo sensível.

## Non-goals do MVP

- integração bancária/Open Finance, conciliação automática e iniciação de pagamento;
- OCR de recibos, leitura automática de notas fiscais, barcode obrigatório ou baixa automática de estoque por compra financeira;
- classificação por IA, aconselhamento financeiro regulado ou recomendações probabilísticas sem explicação;
- investimentos, contabilidade fiscal, múltiplas moedas no mesmo espaço ou conversão cambial;
- juros rotativos calculados pelo emissor, renegociação automática ou regras fiscais de empréstimos;
- mutações offline com sincronização e resolução de conflitos;
- permissões por campo, por registro ou por categoria; o MVP usa papéis estáveis;
- anexos e armazenamento de comprovantes;
- notificações push, WhatsApp ou e-mail transacional além do necessário para autenticação e convites.

## Decisões de produto aprovadas

Estas decisões foram aprovadas pelo responsável do produto e são requisitos vigentes:

1. BRL como moeda única inicial por espaço.
2. Papéis domésticos `owner`, `member` e `viewer`.
3. CSV e XLSX como formatos de entrada; CSV UTF-8 como formato canônico de saída no MVP.
4. Metas como reservas virtuais dentro da carteira, sem criar novas contas de dinheiro.
5. Valor seguro para gastar com horizonte padrão de 30 dias e cálculo determinístico explicado.
6. Console administrativo dentro do mesmo PWA, sob rota, layout, sessão reforçada e autorização próprios.
7. Sem baixa automática de estoque a partir de uma despesa; a compra concluída pode oferecer uma atualização explícita da lista de compras.
8. Sem exclusão física de histórico financeiro pelo usuário; correção ocorre por edição auditada, cancelamento ou reversão.
