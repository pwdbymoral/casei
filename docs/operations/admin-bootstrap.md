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
motivo e auditoria transacional. Aplique `0021_platform_admin_and_step_up.sql` depois de
DATA-004/0019 e cartões/0020. Essa migration cria o papel persistido, o schema oficial do Better
Auth two-factor, RLS e as funções controladas de metadados administrativos. Após o bootstrap, o
primeiro `platform_admin` precisa cadastrar e verificar TOTP; sem isso o layout/API liberam somente
a jornada de enrollment, não contas, sessões ou comandos.

Reenvios de verificação/recuperação são enfileirados fora da transação de comando e usam a chave de
idempotência como identidade determinística do outbox. Em migrations futuras, use 0022 ou superior;
não altere 0019, 0020 ou 0021 depois de aplicadas.
