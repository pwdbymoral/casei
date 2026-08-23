# Specification: identidade, espaços, permissões e administração

- Status: vigente; subordinada às [decisões de produto do MVP](mvp-casei.md#decisões-de-produto-aprovadas)

## Contexto e objetivo

Dados do Casei são íntimos e podem ser compartilhados. O produto precisa permitir colaboração simples, isolamento rigoroso e operação administrativa sem acesso por terminal nem privilégio implícito sobre o conteúdo.

## Cadastro, sessão e onboarding

- Cadastro inicial usa e-mail verificado e senha; login social fica fora do MVP.
- Senha segue política do provedor de autenticação e aceita password managers, paste e autocomplete.
- Recuperação de senha invalida tokens de uso único após sucesso; mensagens não revelam se um e-mail possui conta.
- Sessões podem ser listadas e revogadas pelo usuário. Mudança de senha e ação administrativa crítica podem revogar todas.
- Onboarding solicita nome de exibição, nome do espaço, moeda, fuso e saldo inicial opcional. A pessoa pode pular saldo e começar com confiança baixa nas projeções.
- Aceite de termos/privacidade é versionado quando esses documentos existirem; não inventar checkbox antes do conteúdo jurídico aprovado.

## Espaços e papéis domésticos

Papéis do MVP:

| Capacidade | owner | member | viewer |
| --- | --- | --- | --- |
| Ver finanças, metas e estoque | sim | sim | sim |
| Criar e editar dados de domínio | sim | sim | não |
| Importar | sim | sim | não |
| Exportar dados visíveis | sim | sim | sim |
| Gerenciar categorias e cartões | sim | sim | não |
| Convidar/remover membros | sim | não | não |
| Alterar papel | sim | não | não |
| Transferir propriedade/excluir espaço/export completo | sim | não | não |

- Todo espaço tem exatamente um owner no MVP.
- Owner não pode sair ou ser removido sem transferir propriedade.
- Convite possui e-mail, papel, emissor, espaço e expiração; aceitar com outro e-mail é bloqueado.
- Reenvio invalida token anterior; aceite e revogação são idempotentes.
- Remover membro revoga acesso imediatamente e preserva autoria histórica pelo identificador e nome no momento do evento.
- Troca de espaço ativo não mistura cache, URL, sugestões recentes ou dados entre espaços.

## Perfil e preferências

Usuário edita nome, locale, preferência de ocultar valores e senha. E-mail exige reverificação. Preferências do espaço — moeda, fuso, nome e margem de segurança — são editáveis pelo owner, com prévia das consequências. Moeda não pode mudar após movimentos financeiros no MVP; exige novo espaço ou migração futura específica.

## Administração da plataforma

O console fica no mesmo PWA para reduzir operação, mas em rota/layout/boundary de API separados. Não aparece para usuários comuns e negar acesso não revela dados administrativos.

### Papéis da plataforma

- `platform_admin`: gerencia contas, estado do serviço e outros administradores, com autenticação reforçada.
- `platform_support`: consulta metadados mínimos e executa ações de suporte permitidas; não promove administradores nem acessa conteúdo doméstico.

Papel de plataforma é independente do papel em espaços e nunca concede acesso automático a um espaço.

### Capacidades

- buscar conta por ID ou e-mail normalizado;
- ver status, data de criação, última atividade, sessões, espaços por ID/nome e contagens agregadas, sem valores ou descrições;
- suspender/reativar login com motivo obrigatório;
- revogar sessões e reenviar verificação/recuperação pelos fluxos normais;
- alterar papel de plataforma com step-up authentication e auditoria;
- visualizar saúde de jobs de import/recorrência e reexecutar apenas operações idempotentes falhas;
- consultar auditoria administrativa por ator, alvo, ação e período.

Não inclui editar transações do usuário, revelar senha/token, assumir identidade, entrar silenciosamente em espaço, ler descrições/valores/produtos ou excluir fisicamente dados.

### Bootstrap e segurança

- O primeiro `platform_admin` é criado por procedimento único documentado no deploy; depois, administradores são geridos no console.
- `platform_admin` deve ativar TOTP antes de usar o console. Ações críticas exigem autenticação recente e novo desafio de segundo fator; recovery codes são mostrados uma vez e armazenados conforme o Better Auth.
- Toda ação exige motivo, registra ator, alvo, horário, IP truncado/adequado à política, resultado e correlation ID.
- Uma pessoa não pode remover o último `platform_admin` ativo.
- Suspensão não apaga dados; exportação e exclusão por solicitação do titular serão uma jornada de privacidade própria antes de produção pública.

## Isolamento e segurança

- Toda consulta de domínio filtra por membership válida e espaço; testes tentam IDs válidos de outro espaço.
- Respostas de recurso inexistente e não autorizado não permitem enumeração.
- Rate limiting protege login, recuperação, convite, import e endpoints administrativos.
- Cookies/sessões usam propriedades seguras adequadas ao ambiente publicado; CSRF, CORS e origem são configurados explicitamente.
- Logs redigem tokens, cookies, senhas, conteúdo financeiro e arquivos.

## Critérios de aceitação

- [ ] Cadastro, verificação, login, recuperação, logout e revogação de sessões funcionam sem enumeração de conta.
- [ ] Onboarding cria exatamente um espaço e membership owner sob retry.
- [ ] Matriz de papéis é aplicada no servidor e refletida na interface, com testes cruzados entre espaços.
- [ ] Convite expirado, revogado, reenviado e aceito concorrentemente permanece consistente.
- [ ] Owner transfere propriedade antes de sair; último owner/admin não pode ser removido.
- [ ] Console administrativo elimina operações rotineiras via terminal e não expõe conteúdo do espaço.
- [ ] Suspensão, revogação, promoção e jobs administrativos exigem motivo, proteção reforçada e auditoria.
