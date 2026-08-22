# Acessibilidade operacional

Use WCAG 2.2 Level AA como baseline mínimo para interfaces web aplicáveis. Acessibilidade participa da escolha do componente, conteúdo e implementação desde o início; automação complementa, mas não substitui inspeção manual.

## Semântica e estrutura

- Use elementos nativos antes de ARIA: `button` para ações, `a`/Link para navegação, `label` para campos e landmarks apropriados.
- Preserve ordem lógica de headings e uma hierarquia compreensível.
- Não transforme `div` ou `span` em controle quando existe elemento semântico adequado.
- Use ARIA apenas para completar semântica ou comunicar estados que HTML não expressa; não sobreponha papéis conflitantes.
- Confirme a experiência com tecnologia assistiva quando a complexidade, risco ou customização do controle justificar.

## Teclado e foco

- Toda interação relevante funciona por teclado com ordem lógica.
- Não remova outline sem substituição visível; prefira `:focus-visible`.
- Menus, dialogs, popovers, tabs e composites seguem os padrões de teclado do primitive adotado.
- Overlays modais gerenciam foco inicial, trapping, Escape e restauração de foco; overlays não modais seguem o padrão de foco do primitive correspondente.
- Sticky UI e overlays não escondem completamente o elemento focado.
- Toda ação disponível por hover, drag, swipe ou gesto multiponto também possui alternativa visível e operável sem esse mecanismo.

## Nomes acessíveis, imagens e conteúdo

- Todo controle tem nome acessível claro. Icon-only buttons precisam de `aria-label` ou técnica equivalente; tooltip não substitui nome.
- Ícones decorativos ficam ocultos de tecnologia assistiva quando apropriado.
- Imagens informativas têm texto alternativo que comunica sua função; imagens decorativas usam alternativa vazia; evite repetir legenda ou texto adjacente.
- Labels e instruções visíveis correspondem ao nome anunciado e permanecem compreensíveis fora do contexto visual.

## Formulários e erros

- Todo controle possui label persistente; placeholder não substitui label.
- Defina `type`, `name`, `autocomplete` e `inputmode` semanticamente para melhorar preenchimento e teclado virtual.
- Não bloqueie paste. Preserve valores válidos após falhas.
- Associe descrições e erros aos campos. A mensagem identifica o problema e como corrigi-lo.
- Em submit inválido, direcione atenção e foco ao primeiro erro quando isso melhorar a recuperação, sem perder contexto.
- Campos obrigatórios, formato e constraints são compreensíveis antes do erro quando razoável.

## Contraste, cor e tamanho do alvo

Verifique WCAG AA no estado real do componente:

- texto comum: contraste mínimo de 4.5:1;
- texto grande: mínimo de 3:1;
- controles, indicadores de foco, estados e gráficos essenciais: mínimo de 3:1 contra cores adjacentes, quando o critério se aplica.

Não comunique erro, sucesso, seleção, warning ou estado apenas por cor. Combine cor com texto, forma, ícone, padrão ou posição compreensível.

Atenda ao critério WCAG 2.2 aplicável para tamanho de alvo e espaçamento. Para touch comum, busque hit areas confortáveis próximas de 44–48 CSS px em controles importantes, usando padding quando o ícone visual deve permanecer menor e evitando alvos pequenos e colados.

## Zoom, reflow e orientação

- Em mudanças que afetam texto, layout, controles ou regiões fixas, verifique zoom/aumento de texto até 200% sem perda de conteúdo ou função.
- Verifique reflow equivalente a 320 CSS px sem scroll horizontal geral; conteúdo bidimensional pode justificar scroll localizado.
- Não desabilite zoom via viewport metadata.
- A tarefa continua disponível em diferentes orientações, salvo necessidade essencial documentada.
- Conteúdo ampliado, foco e mensagens não ficam cobertos por regiões sticky.

## Status e estados dinâmicos

- Loading, sucesso, erro e atualizações assíncronas relevantes são perceptíveis sem depender apenas de animação.
- Use live regions ou padrão equivalente quando uma mudança precisa ser anunciada sem mover foco.
- Não anuncie atualizações excessivas; escolha prioridade e granularidade proporcionais.
- Quando um componente possui estado disabled, selected, expanded, invalid ou busy, comunique esse estado semanticamente.

## Motion

- Motion comunica relação, estado, orientação ou feedback; não existe apenas para parecer sofisticado.
- Respeite `prefers-reduced-motion` e preserve compreensão sem animação decorativa.
- Evite `transition: all`; prefira propriedades adequadas como transform e opacity.
- Animação não essencial que inicia automaticamente e dura mais de cinco segundos ou se repete oferece mecanismo para pausar, parar ou ocultar.

## Verificação manual mínima

Além de scanners automatizados, percorra a tarefa com teclado; confira foco, ordem, labels, headings, landmarks, conteúdo, contraste, alvos, erros, estados dinâmicos e compreensão sem cor ou motion. Para controles customizados ou fluxos críticos, inclua teste com tecnologia assistiva apropriada ao risco.
