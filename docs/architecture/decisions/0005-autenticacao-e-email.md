# ADR: autenticação e e-mail transacional

- Status: aprovada
- Data: 2026-08-23
- Spec ou contexto relacionado: [identidade e administração](../../specs/identidade-e-administracao.md)

## Contexto

O MVP exige e-mail verificado, senha, recuperação, sessões revogáveis, convites e administração, mantendo self-hosting e evitando dependência de um fornecedor de e-mail.

## Decisão

Usar Better Auth `1.6.16` com adapter Drizzle/PostgreSQL e Nodemailer `9.0.5` para SMTP; ambas as versões são pinadas sem caret/range e entram no lockfile da implementação. Habilitar somente e-mail e senha no MVP, exigir verificação antes de criar sessão e revogar as demais sessões após reset de senha. Usar os plugins oficiais de administração e segundo fator somente pelas capacidades aprovadas na spec; papel de plataforma permanece em política própria e não concede membership doméstica. Upgrade exige nova decisão e revisão das migrations/notas de segurança.

Encapsular envio em `TransactionalEmailPort`. O primeiro adapter de produção usa Nodemailer com SMTP autenticado/TLS, configurado por ambiente. Templates pertencem à aplicação e possuem versão, texto e HTML; URLs de verificação, reset e convite são geradas pelo servidor com allowlist de origem.

Callbacks `after` de Better Auth não são a fronteira de atomicidade: a partir da linha 1.5 eles executam depois do commit. Para verificação e reset, a integração usa um adapter decorator transacional, específico da versão pinada, que insere uma referência na `auth_email_outbox` na mesma transação que insere o registro `verification`; a outbox não copia o token. Se a inserção da outbox falhar, a transação de auth falha junto. Convites e outras mensagens iniciadas pelo Casei gravam a outbox na própria transação do comando. O worker entrega com idempotência por `(message_kind, source_id)` e reintenta sem criar mensagem duplicada. Se a versão pinada não expuser uma fronteira transacional para esse decorator, AUTH-001 fica bloqueada e exige nova ADR antes da implementação. Respostas públicas não revelam existência de conta. Tokens, URLs completas e conteúdo de e-mail não vão para logs.

Em desenvolvimento e testes, um adapter de captura persiste/expõe mensagens somente no ambiente controlado, sem SMTP real. Startup publicado verifica configuração do transport e falha com diagnóstico sanitizado quando e-mail obrigatório estiver inválido.

## Consequências

- Trocar provedor de e-mail altera configuração ou adapter, não fluxos de identidade.
- SMTP oferece portabilidade ampla, mas entregabilidade, SPF, DKIM e DMARC continuam responsabilidades operacionais.
- Convite/verificação podem chegar depois do commit; o usuário vê estado pendente e pode reenviar com rate limit.
- Atualizações do Better Auth exigem revisar migrations, trigger/adapter de outbox, plugins e notas de segurança antes de upgrade; a aplicação falha no startup se a versão efetiva não corresponder ao baseline pinado.

## Alternativas consideradas

- API proprietária de e-mail: melhor telemetria específica, mas aumenta lock-in e quantidade de adapters no MVP.
- Envio SMTP síncrono no request: reduz infraestrutura, mas cria falhas parciais e latência no cadastro.
- Implementar autenticação própria: superfície de segurança e manutenção injustificáveis.
- Login social inicial: reduz senha para parte dos usuários, porém adiciona provedores, credenciais e fluxos sem necessidade aprovada.

## Compatibilidade e migração

O schema inicial de autenticação deve ser gerado a partir de `better-auth@1.6.16` e revisado antes de integrar às migrations Drizzle. Configuração do adapter, nomes de tabelas e trigger de `verification` não são assumidos de exemplos antigos; a migration aborta se o schema gerado não corresponder ao contrato registrado. Referências: [Better Auth](https://www.better-auth.com/docs), [Better Auth 1.5 — after hooks pós-transação](https://better-auth.com/blog/1-5), [SMTP no Nodemailer](https://nodemailer.com/smtp).
