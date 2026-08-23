# Princípios operacionais de UX

Use estas perguntas antes e durante o design. Elas orientam decisões; não substituem a spec nem evidência com usuários.

## Objetivo do usuário vs implementação prescrita

Separe sempre:

- **User goal:** o resultado legítimo que o usuário quer produzir no produto;
- **User-prescribed implementation:** a solução visual ou técnica sugerida para alcançar esse resultado.

Preserve o objetivo. Não implemente literalmente a solução prescrita quando ela violar o baseline de acessibilidade, semântica, navegabilidade, operabilidade por teclado/touch ou causar dano material de UX. Nesse caso:

1. identifique o objetivo desejado;
2. explique brevemente o conflito concreto;
3. proponha a alternativa mais próxima que preserve o objetivo;
4. peça uma decisão somente se restar um trade-off real que não possa ser resolvido sem mudar o produto.

Não transforme uma preferência de boa prática em motivo para substituir requisitos legítimos. A intervenção deve ser limitada ao conflito demonstrável.

## Enquadrar a tarefa

- O que o usuário veio concluir, e qual resultado reconhece como sucesso?
- Qual informação precisa estar visível no ponto de decisão?
- Qual é a ação primária? As secundárias competem indevidamente com ela?
- Quais estados initial, loading, success, error, empty, partial data, offline ou permission denied são aplicáveis?
- Quais erros são plausíveis e quais podem ser prevenidos?
- Como texto longo, dados ausentes e volume real alteram o fluxo?

## Visibilidade do estado do sistema

- A interface confirma que uma ação foi recebida e mostra progresso quando a espera é perceptível?
- Sucesso e falha ficam claros, inclusive para tecnologia assistiva quando necessário?
- Loading, empty e error têm significados distintos?
- O próximo passo é compreensível após cada resultado?

## Linguagem e modelos mentais reais

- Labels, ordem e agrupamentos usam termos conhecidos pelo usuário, não jargão interno?
- A ação descreve o resultado, como `Salvar alterações`, em vez de um genérico `Continuar`?
- Datas, moedas e números usam internacionalização apropriada?
- O layout tolera expansão de texto e não depende de comprimento fixo ou direção espacial?

## Controle e liberdade

- Existe saída clara de modal, seleção, filtro ou estado indesejado?
- Voltar, avançar e refresh preservam expectativas?
- Filtros, busca, tabs importantes, paginação ou entidade selecionada devem estar na URL para deep link e compartilhamento?
- Ações destrutivas de alto custo pedem confirmação ou oferecem undo? Evite confirmação em ações triviais.

## Consistência e previsibilidade

- A solução segue componentes, tokens, copy e padrões adequados já usados em telas vizinhas?
- Controles iguais se comportam do mesmo modo entre features?
- A apresentação pode ser original sem inventar interação desconhecida?
- Links navegam e buttons executam ações?

## Prevenção de erro

- Defaults, constraints, confirmação seletiva ou desabilitação explicada evitam falhas previsíveis?
- A interface deixa consequências importantes visíveis antes da ação?
- Formulários preservam dados após erro e não bloqueiam paste?
- Validação explica o problema e como corrigi-lo, no lugar e no momento adequados?

## Reconhecimento em vez de memorização

- Opções, contexto, valores anteriores e instruções relevantes aparecem no ponto de uso?
- Ícones ambíguos têm labels; tooltip não é a única fonte de informação essencial?
- Progressive disclosure reduz carga sem esconder informação necessária?

## Eficiência

- O fluxo elimina passos e decisões que não contribuem para a tarefa?
- Usuários recorrentes têm defaults, atalhos ou ações em lote úteis sem prejudicar iniciantes?
- Ações frequentes estão próximas do conteúdo ao qual pertencem?
- CSS pode resolver layout sem JavaScript? Renderização, imagens e listas evitam custo desnecessário, layout shift e atraso por keystroke?

## Hierarquia e minimalismo informacional

- É fácil perceber onde estou, o que a tela representa, o que importa e o que posso fazer?
- Existe um CTA primário perceptível, sem vários controles competindo pelo mesmo peso?
- Agrupamento, hierarquia, copy e defaults podem reduzir complexidade antes de esconder conteúdo?
- Cada card, divisor e decoração cumpre uma função? Remova ruído, não contexto útil.

## Recuperação de erros

- A mensagem diz o que ocorreu, o que permaneceu salvo e como corrigir ou tentar novamente?
- O usuário mantém dados válidos e contexto?
- O primeiro erro recebe atenção acessível quando isso ajuda o fluxo?
- Falhas parciais distinguem o que funcionou do que precisa de nova ação?

## Ajuda contextual

- A tarefa pode ser compreendida pela própria interface?
- Ajuda aparece perto da decisão e no momento em que é útil?
- Instruções são curtas, acionáveis e não substituem labels ou estrutura claras?
- Casos complexos oferecem detalhes progressivamente, sem sobrecarregar o caminho principal?
