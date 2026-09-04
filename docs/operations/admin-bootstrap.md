# Bootstrap do primeiro administrador da plataforma

O bootstrap é uma operação única de deploy. Ele não faz parte da API pública e não aceita papel
ou e-mail enviados pelo navegador.

1. Crie/verifique a conta Better Auth do operador com e-mail verificado, sem compartilhar senha ou
   token com a operação.
2. Em uma janela de deploy, configure `DATABASE_URL_MIGRATION` com a conexão administrativa de
   migrations e `CASEI_BOOTSTRAP_USER_ID` com o `user.id` opaco da conta. Não use e-mail como valor.
3. Execute `pnpm --filter @casei/api bootstrap:platform-admin` uma única vez.
4. O comando bloqueia o conjunto de contas de plataforma na transação. Se qualquer conta de
   plataforma já existir (inclusive suspensa), aborta sem alterar papéis; reexecuções não promovem
   outra conta.
5. Remova `CASEI_BOOTSTRAP_USER_ID` dos segredos do job e faça o primeiro login. O console deve
   exigir a ativação do segundo fator antes de qualquer operação administrativa crítica.

O primeiro admin não é criado por seed automático, header, fixture ou sessão fabricada. Promoções,
rebaixamentos, suspensão e reativação posteriores acontecem no console, com autenticação recente,
motivo e auditoria transacional. Aplique `0022_platform_admin_and_step_up.sql` depois de
DATA-004/0019, cartões/0020 e export/0021. Essa migration cria o papel persistido, o schema oficial do Better
Auth two-factor, RLS e as funções controladas de metadados administrativos. Após o bootstrap, o
primeiro `platform_admin` precisa cadastrar e verificar TOTP; sem isso o layout/API liberam somente
a jornada de enrollment, não contas, sessões ou comandos.

Reenvios de verificação/recuperação criam uma intent `pending` na migration 0022 e só marcam a
idempotência/auditoria como sucesso depois que Better Auth aceita o envio. Falhas ficam `failed` e
podem ser reprocessadas com a mesma chave escopada por ator, ação e alvo; a outbox de Better Auth
recebe uma identidade determinística. Não altere 0019, 0020, 0021 ou 0022 depois de aplicadas.

A boundary `/v1/admin` também usa um bucket durável de 60 tentativas por janela de 60 segundos
por ator. Quando o limite é excedido, a API responde `429` e inclui `Retry-After`; a janela é
compartilhada entre instâncias e não é resetada por restart.
