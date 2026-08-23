# Validação de UX/UI

Use a estratégia em camadas:

`Code checks + Browser behavior + Responsive inspection + Accessibility + Relevant automated tests`

A profundidade além do mínimo obrigatório pode variar com impacto e risco, mas não substitua comportamento real por confiança estética ou uma screenshot isolada.

## 1. Code checks

- Relacione a mudança à spec e aos estados esperados.
- Revise semântica, composição, reuso, tokens, aliases e configuração real do design system.
- Execute os comandos canônicos existentes para testes, lint, type check e build.
- Confirme que não foi criado primitive customizado desnecessário, dependência incidental ou segunda linguagem visual.
- Verifique erros de overflow previsíveis, imagens sem dimensões, JS de layout evitável e motion sem reduced-motion.
- Em revisões amplas de UI, consulte como referência complementar as Web Interface Guidelines atuais da Vercel quando estiverem disponíveis; trate a fonte viva como orientação, não como requisito de produto.

## 2. Browser behavior

Toda mudança que altere layout, estilo, responsividade, estado visual ou comportamento interativo deve ser validada no browser antes de ser concluída. Use Playwright MCP para reproduzir bugs, percorrer jornadas, preencher forms, abrir menus/dialogs/drawers, testar estados, foco e responsividade.

“Mudança pequena”, “visualmente óbvia” e “baixo risco” não dispensam browser validation. Uma exceção só existe quando:

- a aplicação não pode ser executada;
- o browser ou MCP necessário não está disponível;
- a mudança é exclusivamente documental ou não possui superfície visual.

Na exceção, registre a limitação concreta e execute a melhor alternativa disponível, como build, teste de componente, inspeção estrutural ou revisão de CSS/semântica. Não declare evidência de runtime que não foi obtida.

Interaja com a interface; não pare em renderização ou screenshot. Confirme ação principal, navegação, feedback assíncrono, fechamento/cancelamento, recuperação de erros e preservação de dados. Screenshot é útil para comparação e registro visual, mas não comprova interação, teclado ou acessibilidade.

## 3. Responsive inspection

Para mudanças estruturais de página, inspecione no browser contextos equivalentes a:

- ~320 px: limite estreito e reflow;
- ~390 px: telefone comum;
- ~768 ou ~820 px: tablet;
- ~1024 px: tablet amplo ou laptop estreito;
- ~1280 px: desktop;
- ~1440 px ou maior quando a página oferece composição para viewport amplo.

Esses pontos são amostras, não breakpoints obrigatórios. Arraste ou inspecione tamanhos intermediários onde o conteúdo se aproxima de wrapping, overflow, mudança de composição ou perda de hierarquia, incluindo ~430, ~900 e ~1100 px quando esses intervalos atravessarem o comportamento alterado.

Para um componente local, inspecione no mínimo um contexto estreito e um amplo. Inclua tablet sempre que largura, densidade, composição, jornada ou posição das ações puderem mudar nesse intervalo. Se o componente responde ao container, varie o container independentemente do viewport.

Acrescente verificações conforme a superfície alterada: portrait/landscape para layouts dependentes de eixo; touch e teclado para controles interativos; mouse para hover; light/dark para estilos ou tokens em produto que suporte ambos; reduced motion para animação; zoom para texto, layout ou controles; safe areas para regiões full-screen ou fixas; teclado virtual para forms e ações próximas à borda inferior.

Em tablet, ausência de quebra não basta. Confirme também largura de leitura, densidade, aproveitamento do espaço, hierarquia, comprimento da jornada, posição das ações e relação entre conteúdo e área disponível.

## 4. Escopo de estados

Classifique a entrega antes de decidir quais estados implementar:

- **Protótipo:** pode omitir estados se a omissão estiver explícita no escopo e o resultado não for apresentado como feature pronta.
- **Incremento parcial intencional:** implemente os estados necessários ao incremento e registre brevemente quais ficaram deliberadamente fora.
- **Feature concluída:** loading, empty, error, disabled, success e todos os demais estados alcançáveis pelo fluxo fazem parte da Definition of Done.

O rótulo não pode ser usado retroativamente para justificar uma tela quebrada ou uma omissão não combinada.

## 5. Content and state stress

Teste uma seleção representativa de:

- texto curto, médio e muito longo;
- números e nomes extensos;
- zero, poucos e muitos itens;
- imagens ausentes;
- dados parciais;
- initial, hover, active, focus, selected e disabled;
- loading, success, error e empty;
- falha de rede/offline e permission denied quando o fluxo pode produzir esses resultados;
- conteúdo truncado e localizado.

Não confunda skeleton com empty state. Confirme que listas vazias, falhas e dados parciais não produzem tela quebrada.

## 6. Accessibility pass

- Percorra a jornada apenas com teclado e confirme ordem, foco visível, Escape e retorno de foco.
- Verifique headings, landmarks, labels, accessible names, mensagens de erro e anúncios dinâmicos.
- Confirme contraste, significado independente de cor, hit areas e reflow/zoom.
- Se a mudança inclui hover, swipe, drag ou motion, teste a alternativa sem esse mecanismo.
- Use tecnologia assistiva em controles customizados ou fluxos de maior risco.

Quando Playwright Test estiver disponível e fizer parte da estratégia do projeto, considere `@axe-core/playwright`. Um scan sem violações não prova acessibilidade completa; mantenha as verificações manuais.

## Definition of Done de interface

Conclua somente quando todos os itens aplicáveis estiverem atendidos:

- comportamento corresponde à spec e a ação principal pode ser concluída;
- reuso foi verificado e não há primitive customizado desnecessário;
- design system, semântica e estados permanecem consistentes;
- mobile, tablet, desktop e intervalos atravessados pela mudança não apresentam quebra ou overflow horizontal acidental; tablet também satisfaz os critérios de qualidade de composição acima;
- teclado funciona, foco é perceptível e accessible names/labels estão corretos;
- contraste e alvos foram verificados nos controles visuais; reflow/zoom nas mudanças de texto ou layout; reduced motion em toda mudança com animação;
- em feature concluída, loading, error, empty, disabled, success e demais estados alcançáveis foram implementados; omissões de protótipo ou incremento parcial estão explícitas;
- browser validation foi executada para toda mudança de layout, estilo, responsividade, estado visual ou interação, ou uma das três exceções foi registrada com validação alternativa;
- testes e checks pertinentes passam;
- documentação aplicável está sincronizada.

Registre com precisão o que foi testado, observado no browser, inferido ou não verificado. Não declare “responsivo”, “acessível”, “perfeito no mobile” ou “UX resolvida” somente porque o código compilou ou parece correto por inspeção.
