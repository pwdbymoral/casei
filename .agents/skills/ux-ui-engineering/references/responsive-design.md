# Design responsivo

## Mobile-first e continuum

Comece pela menor largura relevante e acrescente capacidade conforme o espaço cresce. Preserve a tarefa principal, a informação essencial e a hierarquia em telefone, tablet, laptop e desktop amplo. Mobile-first define a ordem de implementação, não limita a validação ao mobile.

Trate responsividade como continuum. Aumente e reduza o espaço de forma gradual e introduza breakpoints quando conteúdo, leitura ou interação deixarem de funcionar confortavelmente — nunca por marca ou modelo de aparelho. Minimize breakpoints e inspecione também os intervalos entre eles.

Quando faltar espaço, avalie nesta ordem:

1. reflow;
2. wrapping;
3. stacking;
4. mudança de composição;
5. priorização;
6. progressive disclosure;
7. scroll explicitamente adequado à natureza do conteúdo.

Não esconda informação importante apenas para fazer a tela caber.

## Ferramenta de layout correta

- Use Grid para relações bidimensionais e Flexbox para fluxos predominantemente lineares.
- Prefira intrinsic sizing, `min()`, `max()` e `clamp()` quando tornam o continuum mais robusto.
- Use container queries quando um componente reutilizável deve responder ao próprio espaço, independentemente do viewport.
- Use media queries para viewport, orientação e preferências do usuário.
- Prefira CSS a medições e cálculos JavaScript de layout.
- Adote recursos modernos com suporte adequado e progressive enhancement; não use tecnologia apenas por novidade.

## Tablet e orientação

Tablet não é um telefone ampliado nem um desktop comprimido. Verifique se navegação, densidade, agrupamento, painéis e posição das ações aproveitam o espaço sem alongar excessivamente leitura ou alcance.

Tablet só passa quando a composição é adequada, não apenas quando deixa de apresentar overflow ou quebra. Avalie:

- largura e conforto de leitura;
- densidade e aproveitamento do espaço;
- hierarquia e agrupamento;
- comprimento da jornada e quantidade de scroll;
- posição e alcance das ações;
- relação entre conteúdo e área disponível.

“Funciona” significa que a tarefa ainda pode ser concluída; “é adequado” significa que a composição usa o espaço sem degradar compreensão, eficiência ou prioridade. Exija ambos.

Teste portrait, landscape e transições quando a experiência puder mudar materialmente. Não dependa de orientação específica para concluir a tarefa.

## Touch, pointer e teclado

Não deduza input pela largura: dispositivos podem combinar touch, mouse e teclado.

- Hover é enhancement; ações essenciais permanecem visíveis e operáveis sem hover.
- Tooltips não carregam informação essencial sozinhos.
- Toda ação exposta por swipe ou drag também possui alternativa visível e operável sem o gesto; drag operável por teclado segue o padrão semântico do controle.
- Use `hover` e `pointer` media features somente quando o mecanismo real importar.
- Controles importantes em touch devem ter hit areas confortáveis, em geral próximas de 44–48 CSS px, mesmo com ícones menores.
- Preserve ordem e visibilidade de foco em layouts que mudam.

## Viewport, safe areas e teclado virtual

Em layouts full-screen, overlays e ações fixas, considere safe-area insets, notch, browser chrome, orientação e teclado virtual. Quando a altura utilizável importa, avalie unidades modernas como `dvh` em vez de presumir que `100vh` representa a área visível.

Headers, footers e CTAs sticky não podem cobrir conteúdo, erros ou o elemento focado. Verifique o fluxo enquanto o teclado virtual está aberto.

## Conteúdo e reflow

Teste texto curto, médio e muito longo; números grandes; nomes extensos; zero e muitos itens; imagens ausentes; dados parciais e conteúdo localizado. Permita wrapping onde ele preserva compreensão; truncation deve oferecer acesso ao valor completo quando necessário para a tarefa.

A página deve permanecer utilizável com zoom e aumento de texto, refluindo para largura equivalente a 320 CSS px sem perda de função e sem scroll horizontal geral. Scroll horizontal pode ser correto para conteúdo genuinamente bidimensional, como certas tabelas, mapas ou diagramas; torne-o explícito e mantenha contexto e controles acessíveis.

## Imagens e overflow

- Reserve dimensões ou proporção para evitar layout shift.
- Use imagens responsivas e tamanhos adequados ao contexto; não baixe ativos muito maiores que a renderização.
- Preserve crop e ponto focal quando a composição variar.
- Garanta fallback e texto alternativo conforme a função da imagem.
- Procure causas de overflow em conteúdo sem quebra, larguras mínimas, grids, elementos posicionados e controles fixos; não esconda o defeito globalmente com `overflow-x: hidden`.
