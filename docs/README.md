# Documentação do projeto

Esta árvore é o sistema de registro do projeto. Ela cresce por necessidade: crie um documento somente quando houver conhecimento real a preservar e quando uma fonte canônica existente não puder recebê-lo com clareza.

## Mapa

- `specs/`: comportamento que o produto deve oferecer. Comece pelo [`template de specification`](specs/_template.md).
- `architecture/`: estrutura, boundaries, contratos internos e princípios arquiteturais vigentes. Crie documentação quando decisões reais existirem.
- `architecture/decisions/`: ADRs para decisões relevantes, contexto e trade-offs históricos. Use o [`template de ADR`](architecture/decisions/_template.md).
- `plans/`: trabalho necessário para entregar mudanças não triviais. Use o [`template de plano`](plans/_template.md). Crie `active/` ao iniciar o primeiro plano e `completed/` somente quando um plano concluído merecer retenção histórica.
- [`testing/`](testing/README.md): estratégia, convenções, evidência de qualidade e comandos de validação quando existirem.
- `references/`: crie quando uma referência externa ou material de apoio precisar permanecer disponível no contexto dos agentes.

Specs descrevem o que o produto deve fazer. Arquitetura descreve como o sistema é estruturado. Planos descrevem o trabalho. ADRs preservam decisões e seus trade-offs. Não misture essas responsabilidades.

## Progressive disclosure

Comece por `AGENTS.md`, depois leia a spec da tarefa, a arquitetura diretamente relevante, o plano ativo se houver, os testes relacionados e o código afetado. Carregue outras fontes somente quando elas contribuírem para a decisão ou validação atual.

Mantenha uma única fonte canônica para cada regra ou conhecimento. Prefira links internos a cópias e amplie documentos existentes quando isso preservar clareza. A documentação explica invariantes; testes, tipos, schemas, linters, CI ou validações estruturais devem garanti-las quando for razoável.

## Estado vigente e histórico

Documentação operacional é state-of-truth: descreva diretamente como o sistema funciona agora. Ao mudar um requisito, substitua a descrição obsoleta pela formulação canônica vigente e revise exemplos, comentários, diagramas, comandos e referências afetados.

Use formulações declarativas, precisas, pesquisáveis e observáveis. Por exemplo: “A sessão expira após 30 minutos de inatividade.” Evite narrar correções ou acumular negações, exceto quando a negação for uma constraint real do domínio.

Preserve histórico somente quando ele tiver valor, em ADRs, histórico Git, changelog, issues, planos concluídos ou notas de migração. Documentação obsoleta é um defeito; não a retenha na documentação corrente para explicar comportamentos anteriores.

## Manutenção

Toda mudança deve avaliar os documentos afetados no mesmo trabalho. Quando documentação e realidade divergirem, determine primeiro qual fonte deveria ser canônica. Evidência sobre o estado atual não autoriza reescrever a spec para legitimar uma implementação incorreta.

Após alterações relevantes, revise os artefatos aplicáveis: spec, testes, implementação, contratos, comentários, exemplos, documentação, diagramas, comandos e referências. Remova afirmações que deixaram de ser verdadeiras.
