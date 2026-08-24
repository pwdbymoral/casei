# Plano: endurecimento do domínio da lista de compras (STOCK-003)

- Status: concluído — implementação e validações locais feitas; revisão/merge pendentes
- Spec associada: [estoque-domestico.md](../../specs/estoque-domestico.md#lista-de-compras)

## Objetivo

Fechar a integração entre edição de produto e lista colaborativa sem criar duas solicitações
ativas para o mesmo produto. A lista automática precisa acompanhar o nome e a unidade atuais;
uma colisão com item livre deve ser um conflito recuperável antes de qualquer mutação.

## Critérios de aceitação e rastreabilidade

1. Quando um produto com item automático ativo é editado, a linha automática exibida usa nome,
   chave normalizada, unidade e rótulo atuais do produto.
2. Quando o novo nome do produto coincide com item livre ativo do mesmo espaço, a edição retorna
   `conflict`, não atualiza o produto e deixa a lista inalterada; restaurar produto arquivado com
   a mesma colisão segue a mesma regra. Criação, renomeação e restauro serializam a chave
   canônica `(workspaceId, nameNormalized)` com lock transacional antes da checagem/mutação.
3. A unicidade continua por espaço e somente para itens não comprados; itens comprados não
   bloqueiam uma nova solicitação.
4. `PATCH` preserva campos omitidos e permite limpar campos anuláveis somente quando `null` é
   enviado; uma projeção automática não atribui autoria ao leitor e retorna `lastChangedBy: null`.

Cada critério terá regressão no teste de serviço, seguida da validação das suítes API, contratos,
domínio, lint e typecheck.

## Restrições

- Sem UI, storage externo ou nova migration nesta fatia.
- A rejeição é deliberadamente conservadora: não há operação de merge/remoção silenciosa de uma
  linha livre, e os eventos append-only não serão falsificados.
