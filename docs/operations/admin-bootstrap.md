# Bootstrap do primeiro administrador da plataforma

O bootstrap é uma operação única de deploy. Ele não faz parte da API pública e não aceita papel
ou e-mail enviados pelo navegador.

1. Crie/verifique a conta Better Auth do operador com e-mail verificado, sem compartilhar senha ou
   token com a operação.
2. Em uma janela de deploy, configure `DATABASE_URL_MIGRATION` com a conexão administrativa de
   migrations e `CASEI_BOOTSTRAP_USER_ID` com o `user.id` opaco da conta. Não use e-mail como valor.
3. Execute `pnpm --filter @casei/api bootstrap:platform-admin` uma única vez.
4. O comando bloqueia o conjunto de administradores ativos na transação. Se outro admin já existir,
   aborta sem alterar papéis; reexecuções não promovem outra conta.
5. Remova `CASEI_BOOTSTRAP_USER_ID` dos segredos do job e faça o primeiro login. O console deve
   exigir a ativação do segundo fator antes de qualquer operação administrativa crítica.

O primeiro admin não é criado por seed automático, header, fixture ou sessão fabricada. Promoções,
rebaixamentos, suspensão e reativação posteriores acontecem no console, com autenticação recente,
motivo e auditoria transacional. A migration que cria `platform_account` e `platform_audit_event`
deve entrar somente após DATA-004/0019 e cartões/0020, com o próximo índice livre definido na
integração; este runbook não fixa o número.
