# ADR: autenticação e e-mail transacional

- Status: aprovada
- Data: 2026-08-23
- Spec ou contexto relacionado: [identidade e administração](../../specs/identidade-e-administracao.md)

## Contexto

O MVP exige e-mail verificado, senha, recuperação, sessões revogáveis, convites e administração, mantendo self-hosting e evitando dependência de um fornecedor de e-mail.

## Decisão

Usar Better Auth com adapter Drizzle/PostgreSQL. Habilitar somente e-mail e senha no MVP, exigir verificação antes de criar sessão e revogar as demais sessões após reset de senha. Usar os plugins oficiais de administração e segundo fator somente pelas capacidades aprovadas na spec; papel de plataforma permanece em política própria e não concede membership doméstica.

Encapsular envio em `TransactionalEmailPort`. O primeiro adapter de produção usa Nodemailer com SMTP autenticado/TLS, configurado por ambiente. Templates pertencem à aplicação e possuem versão, texto e HTML; URLs de verificação, reset e convite são geradas pelo servidor com allowlist de origem.

O callback de Better Auth não envia no request principal: grava mensagem na outbox dentro da transação aplicável, e o worker entrega com idempotência. Respostas públicas não revelam existência de conta. Tokens, URLs completas e conteúdo de e-mail não vão para logs.

Em desenvolvimento e testes, um adapter de captura persiste/expõe mensagens somente no ambiente controlado, sem SMTP real. Startup publicado verifica configuração do transport e falha com diagnóstico sanitizado quando e-mail obrigatório estiver inválido.

## Consequências

- Trocar provedor de e-mail altera configuração ou adapter, não fluxos de identidade.
- SMTP oferece portabilidade ampla, mas entregabilidade, SPF, DKIM e DMARC continuam responsabilidades operacionais.
- Convite/verificação podem chegar depois do commit; o usuário vê estado pendente e pode reenviar com rate limit.
- Atualizações do Better Auth exigem revisar migrações, plugins e notas de segurança antes de upgrade.

## Alternativas consideradas

- API proprietária de e-mail: melhor telemetria específica, mas aumenta lock-in e quantidade de adapters no MVP.
- Envio SMTP síncrono no request: reduz infraestrutura, mas cria falhas parciais e latência no cadastro.
- Implementar autenticação própria: superfície de segurança e manutenção injustificáveis.
- Login social inicial: reduz senha para parte dos usuários, porém adiciona provedores, credenciais e fluxos sem necessidade aprovada.

## Compatibilidade e migração

O schema inicial de autenticação deve ser gerado a partir da versão instalada do Better Auth e revisado antes de integrar às migrations Drizzle. Configuração do adapter e nomes de tabelas não são assumidos de exemplos antigos. Referências atuais: [Better Auth](https://www.better-auth.com/docs), [SMTP no Nodemailer](https://nodemailer.com/smtp).
