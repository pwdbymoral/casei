---
name: ux-ui-engineering
description: Cria, altera, revisa e valida interfaces deste projeto — páginas, telas, frontend de features, componentes, layouts, navegação, formulários, dashboards, modais, drawers, menus, tabelas, cards, estados de loading/empty/error, interações, design system, shadcn/ui, acessibilidade, responsividade mobile/tablet/desktop e validação no navegador. Use para qualquer mudança com impacto visual ou de UX; não use para trabalho puramente backend sem impacto na interface.
---

# UX/UI Engineering

Esta skill é a autoridade operacional para trabalho de interface neste projeto. Siga o processo e as fontes de verdade do `AGENTS.md`; não replique aqui suas regras globais.

Priorize, nesta ordem:

`Task success → usability → accessibility → consistency → responsiveness → performance → visual polish → novelty`

Use padrões de produto familiares. Inove na apresentação quando isso fortalecer a identidade sem reduzir compreensão, previsibilidade ou acessibilidade; não invente paradigmas de interação para ações que já possuem convenções compreendidas.

## Fluxo essencial

Antes de escrever JSX ou CSS, determine:

1. a tarefa que o usuário tenta concluir;
2. a informação necessária para concluí-la;
3. a ação principal;
4. as ações secundárias;
5. os erros plausíveis;
6. os estados do fluxo;
7. o feedback que confirma recebimento, progresso, sucesso ou falha.

Depois:

1. Leia a spec aplicável, componentes vizinhos, telas equivalentes, tokens e padrões existentes.
2. Procure reuso antes de construir. Para seleção, composição ou customização de componentes, leia [shadcn-reuse.md](references/shadcn-reuse.md) e use também a skill `shadcn` disponível.
3. Para decisões de fluxo, hierarquia, conteúdo, estados ou conflito entre objetivo do usuário e solução prescrita, leia [ux-principles.md](references/ux-principles.md).
4. Para qualquer comportamento que varie com espaço ou mecanismo de entrada, leia [responsive-design.md](references/responsive-design.md).
5. Para criação, alteração ou revisão de interação e conteúdo visual, leia [accessibility.md](references/accessibility.md).
6. Antes de concluir uma mudança de layout, estilo, responsividade, estado visual ou comportamento interativo, leia e execute a validação obrigatória em [validation.md](references/validation.md).

## Invariantes

- Minimize decisões, memória, passos, ambiguidade, surpresa, retrabalho e risco de erro. Prefira reconhecimento a memorização e mantenha o estado do sistema compreensível.
- Diferencie o objetivo legítimo do usuário da implementação que ele prescreveu. Preserve o objetivo, mas não aplique literalmente uma solução que viole o baseline de acessibilidade, semântica, navegabilidade, teclado/touch ou cause dano material de UX.
- Use a ordem `reuse → compose → customize → extend → create`. Semântica e UX prevalecem sobre reuso artificial.
- Inspecione a configuração real antes de assumir biblioteca-base, API, alias, versão, tokens ou componentes instalados. Nunca migre a biblioteca-base incidentalmente.
- Preserve semântica, teclado, foco, nomes acessíveis, ARIA necessária e comportamentos esperados ao customizar primitives.
- Componentes de domínio são legítimos; componha-os com primitives do design system e mantenha primitives genéricos no diretório próprio do sistema.
- Comece pelo menor contexto relevante e evolua pelo continuum de tamanhos. Mobile-first não significa mobile-only, e breakpoints respondem ao conteúdo, não a modelos de dispositivo.
- Hover é enhancement. Funcionalidade essencial funciona com teclado; toda ação exposta por gesto, drag ou swipe também possui alternativa visível e operável sem esse mecanismo.
- Classifique a entrega como protótipo, incremento parcial intencional ou feature concluída; trate estados e registre omissões conforme [validation.md](references/validation.md).
- Use HTML semântico antes de ARIA e WCAG 2.2 AA como baseline mínimo.
- Toda mudança de layout, estilo, responsividade, estado visual ou comportamento interativo exige browser validation antes da conclusão, salvo as exceções explícitas de [validation.md](references/validation.md).
