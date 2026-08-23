# Reuso e composição com shadcn/ui

## Reuse ladder

Decida nesta ordem:

1. componente já existente no projeto;
2. componente shadcn já instalado;
3. variante ou composição de componentes existentes;
4. componente disponível no registry oficial do shadcn;
5. block oficial adequado;
6. item de registry já configurado e aprovado pelo projeto;
7. composição de primitives shadcn;
8. componente de domínio composto a partir desses primitives;
9. primitive customizado, somente após justificar a lacuna.

Não reconstrua manualmente controles e comportamentos genéricos — como button, dialog, select, combobox, dropdown, tooltip, drawer, sheet, tabs, accordion, checkbox, radio, switch, popover, command palette, pagination, table ou form primitive — quando houver solução shadcn semanticamente adequada. Não force um componente inadequado: semântica, acessibilidade e adequação à tarefa prevalecem.

## Inspecione antes de escolher

Verifique o estado real do projeto antes de implementar. Quando shadcn estiver configurado, confirme:

- biblioteca-base e APIs correspondentes;
- componentes instalados e seus arquivos locais;
- aliases e caminhos resolvidos;
- estilo, tokens, CSS global e configuração do Tailwind;
- biblioteca de ícones, framework e package manager;
- versões relevantes e registries configurados.

Use a skill companion `shadcn` para o procedimento e as regras atuais. Use o shadcn MCP para descobrir e examinar componentes, blocks e registries; use a CLI conforme orientado pela companion para operações no projeto. Consulte a documentação oficial atual antes de assumir APIs de memória. Não mantenha nesta skill uma lista de componentes, nem suponha Radix, Base UI ou outra biblioteca-base.

Nunca migre a biblioteca-base como efeito colateral de uma tarefa de UX.

### Instalado ou esperado, mas ainda não configurado

A ausência de `components.json` ou de configuração completa não autoriza criar primitives manuais por conveniência. Quando shadcn estiver instalado ou fizer parte da arquitetura esperada:

1. inspecione dependências, estrutura e configuração existentes;
2. consulte a companion `shadcn` e o MCP para confirmar o caminho oficial atual;
3. determine se inicialização ou configuração é necessária para atender à tarefa;
4. se essa configuração estiver dentro do escopo aprovado, use o caminho oficial;
5. se ela ampliar materialmente o escopo, registre a dependência ou bloqueio e solicite direção somente quando a escolha mudar o produto ou o trabalho autorizado.

Não construa um substitute primitive manual para contornar configuração pendente.

## Primitives e componentes de domínio

O diretório de UI compartilhada contém primitives e componentes genéricos do design system. Conceitos estáveis do produto pertencem à camada de domínio apropriada.

Um componente como `AppointmentCard` é válido quando representa um conceito real e compõe Card, Button, Badge, Avatar, Dropdown ou outros primitives existentes. Não mova toda composição de produto para `components/ui`, nem recrie internamente semântica que o design system já oferece.

Quando um padrão visual ou comportamental se repetir e tiver significado estável, promova-o para variante ou componente compartilhado. Não abstraia coincidências locais prematuramente.

## Registry e dependências

Priorize:

1. registry oficial shadcn;
2. registries privados ou oficiais já configurados e aprovados;
3. registries externos explicitamente aprovados.

Antes de introduzir item externo, avalie manutenção, acessibilidade, dependências, qualidade do código, compatibilidade, segurança, licença quando relevante e custo de manutenção. A existência no registry não é aprovação. Não adicione dependência ou registry externo apenas para poupar uma implementação pequena.

Após instalar código de registry, leia os arquivos adicionados, confira imports, dependências, composição, biblioteca de ícones e aderência aos padrões locais. Preserve mudanças locais ao atualizar componentes; siga a companion `shadcn` para preview, diff e autorização de overwrite.

## Customização

Personalize código shadcn quando necessário, preservando:

- HTML e nomes acessíveis corretos;
- comportamento de teclado e foco;
- focus trapping e restauração de foco quando aplicáveis;
- Escape e demais convenções da interação;
- ARIA e comunicação de estados;
- estados visuais e comportamento esperado do primitive.

Prefira, nesta ordem:

1. design tokens e CSS variables existentes;
2. variantes existentes ou novas variantes estáveis;
3. composição;
4. classes locais justificadas.

Leia cores, radius, tipografia, spacing, shadows, borders, iconografia, densidade e motion existentes antes de criar valores. Um novo token só se justifica quando representa uma necessidade sistêmica; trate-o como evolução do design system, não como correção local improvisada.

## Custom primitive justification

Antes de criar um primitive genérico do zero, registre brevemente:

1. quais componentes existentes no projeto foram inspecionados;
2. qual componente shadcn equivalente foi avaliado;
3. por que uma variante não resolve;
4. por que composição não resolve;
5. por que extensão não resolve;
6. qual comportamento ou requisito justifica o primitive novo;
7. qual semântica, comportamento de teclado e foco serão preservados;
8. como o primitive será testado.

Fundamente a lacuna em diferenças observáveis de comportamento, semântica, contrato ou composição. “Não atende”, “não é flexível o suficiente” e “custom é mais fácil” não são justificativas suficientes.

Essa evidência breve não é exigida para componentes de domínio simples que apenas compõem primitives existentes.
