# ADR: autenticação e e-mail transacional

- Status: aprovada
- Data: 2026-08-23
- Spec ou contexto relacionado: [identidade e administração](../../specs/identidade-e-administracao.md)

## Contexto

O MVP exige e-mail verificado, senha, recuperação, sessões revogáveis, convites e administração, mantendo self-hosting e evitando dependência de um fornecedor de e-mail.

## Decisão

Usar Better Auth `1.6.22` com adapter Drizzle/PostgreSQL e Nodemailer `9.0.5` para SMTP; ambas as versões são pinadas sem caret/range e entram no lockfile da implementação. A versão `1.6.22` substitui `1.6.16` por corrigir uma vulnerabilidade de account takeover reportada em versões anteriores. Habilitar somente e-mail e senha no MVP, exigir verificação antes de criar sessão e revogar as demais sessões após reset de senha. Usar os plugins oficiais de administração e segundo fator somente pelas capacidades aprovadas na spec; papel de plataforma permanece em política própria e não concede membership doméstica. Upgrade exige nova decisão e revisão das migrations/notas de segurança.

Encapsular envio em `TransactionalEmailPort`. O primeiro adapter de produção usa Nodemailer com SMTP autenticado/TLS, configurado por ambiente. Templates pertencem à aplicação e possuem versão, texto e HTML; URLs de verificação, reset e convite são geradas pelo servidor com allowlist de origem.

Callbacks `after` de Better Auth não são a fronteira de atomicidade: a partir da linha 1.5 eles executam depois do commit, e o fluxo de verificação pode entregar um JWT assinado diretamente ao callback sem persistir uma linha de token no adapter. Portanto, não dependemos de uma linha `verification` para garantir entrega. Cada operação de cadastro/verificação/reset cria antes um registro `auth_email_intent` idempotente, com finalidade, ator opcional até o usuário existir, e-mail normalizado protegido, correlation ID, callback URL allowlisted, estado e expiração. O callback `sendVerificationEmail`/reset recebe a URL/token e transforma a intent em payload criptografado de `auth_email_outbox`; token, URL e conteúdo nunca aparecem em logs. Se o callback falhar depois do commit, a intent pendente aciona recovery job que solicita um novo token pelo endpoint/API da versão pinada e reprocessa a outbox; o usuário vê estado pendente e pode reenviar. Convites e outras mensagens iniciadas pelo Casei gravam a outbox na própria transação do comando. O worker entrega com idempotência por `(message_kind, source_id)` e reintenta sem criar mensagem duplicada. AUTH-001 é bloqueada até um spike contra `better-auth@1.6.22` provar cadastro, reenvio, reset, falha da outbox, recovery, preservação da callback URL e expiração; qualquer divergência exige nova ADR. Respostas públicas não revelam existência de conta.

Em desenvolvimento e testes, um adapter de captura persiste/expõe mensagens somente no ambiente controlado, sem SMTP real. Startup publicado verifica configuração do transport e falha com diagnóstico sanitizado quando e-mail obrigatório estiver inválido.

## Consequências

- Trocar provedor de e-mail altera configuração ou adapter, não fluxos de identidade.
- SMTP oferece portabilidade ampla, mas entregabilidade, SPF, DKIM e DMARC continuam responsabilidades operacionais.
- Convite/verificação podem chegar depois do commit; o usuário vê estado pendente e pode reenviar com rate limit.
- Atualizações do Better Auth exigem revisar migrations, `auth_email_intent`, callback/recovery, plugins e notas de segurança antes de upgrade; a aplicação falha no startup se a versão efetiva não corresponder ao baseline pinado.

## Alternativas consideradas

- API proprietária de e-mail: melhor telemetria específica, mas aumenta lock-in e quantidade de adapters no MVP.
- Envio SMTP síncrono no request: reduz infraestrutura, mas cria falhas parciais e latência no cadastro.
- Implementar autenticação própria: superfície de segurança e manutenção injustificáveis.
- Login social inicial: reduz senha para parte dos usuários, porém adiciona provedores, credenciais e fluxos sem necessidade aprovada.

## Compatibilidade e migração

O schema inicial de autenticação deve ser gerado a partir de `better-auth@1.6.22` e revisado antes de integrar às migrations Drizzle. Não se assume que o fluxo de e-mail persista token no adapter; a integração é validada contra o [fluxo oficial de verificação por callback](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/api/routes/email-verification.ts) e os endpoints da versão pinada. A migration cria `auth_email_intent`/`auth_email_outbox` e a aplicação aborta se o contrato de callback/recovery não estiver coberto pelo spike. Referências: [Better Auth](https://www.better-auth.com/docs), [Better Auth 1.5 — after hooks pós-transação](https://better-auth.com/blog/1-5), [SMTP no Nodemailer](https://nodemailer.com/smtp).
