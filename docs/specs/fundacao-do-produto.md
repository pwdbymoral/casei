# Specification: fundação do produto Casei

## Contexto e problema

O Casei começa como uma aplicação web progressiva para organizar a vida de uma pessoa, casal ou grupo. O produto deve concentrar planejamento financeiro, metas e estoque doméstico em uma experiência simples, segura e agradável de usar em telas pequenas e grandes.

## Objetivo

Estabelecer uma base técnica que permita iniciar o PWA e evoluir, sem reestruturação do repositório, para aplicativos móveis nativos e serviços complementares.

## Atores

- Pessoa que administra sua própria vida cotidiana.
- Membro de um casal ou grupo que compartilha informações e tarefas autorizadas.

## Comportamento esperado

- Quando uma pessoa acessar o produto no celular, tablet ou computador, o sistema deve oferecer uma experiência responsiva e adequada à entrada por toque e teclado.
- Quando a aplicação web for compatível com instalação, o sistema deve disponibilizar os artefatos necessários para instalação como PWA.
- Quando dados forem compartilhados por mais de uma pessoa, o sistema deve aplicar autenticação e autorização que preservem o acesso somente aos dados autorizados.

## Requisitos e invariantes

- O repositório deve comportar o PWA atual e futuros aplicativos móveis nativos.
- O código, os contêineres e a documentação operacional não devem depender de um provedor específico de hospedagem.
- O sistema deve privilegiar desempenho, segurança, eficiência operacional e manutenção assistida por agentes.
- O shadcn/ui é a base de componentes da interface web.
- O modelo de dados deve suportar isolação por espaço compartilhado (pessoa, casal ou grupo) e papéis de acesso.
- A primeira versão aceita operações de dados somente com conexão; a instalação e a leitura do shell da aplicação devem continuar disponíveis conforme a política de cache do PWA.

## Critérios de aceitação

- [ ] Uma decisão arquitetural aprovada define o gerenciador de pacotes, monorepo, PWA, API, dados, autenticação, qualidade e entrega contínua, com trade-offs explícitos.
- [ ] A estrutura inicial do repositório permite adicionar um aplicativo Expo sem migrar o PWA ou os pacotes de domínio compartilhados.
- [ ] O projeto pode ser executado e entregue como imagens OCI e configuração genérica, sem referência a uma plataforma de deploy específica.
- [ ] A automação de integração contínua valida formatação/lint, tipos, testes, build e vulnerabilidades antes de aceitar mudanças.

## Limites

### Incluído

- Fundação do monorepo, do PWA, da API, dos dados, da qualidade e da automação de entrega.

### Non-goals

- Implementar nesta etapa os módulos de finanças, metas ou estoque.
- Publicar um aplicativo nativo antes de suas jornadas e requisitos serem especificados.
- Definir uma integração de deploy para uma plataforma específica.

## Qualidades e contratos

- Dados financeiros e de vida doméstica são sensíveis: segredos não podem ser versionados, tráfego deve usar TLS no ambiente publicado e o acesso a recursos deve ser autorizado no servidor.
- Alterações de esquema de banco devem ser versionadas e aplicadas por migrações explícitas.
- Contratos de domínio e de API devem ser validados em runtime e compartilháveis sem depender de componentes de interface.
- As instruções para agentes, decisões, contratos e comandos de validação devem ser versionados e concisos.

## Questões em aberto

- A autenticação inicial deve oferecer somente e-mail e senha, ou também login social?
- Quais provedores de e-mail transacional e de armazenamento de arquivos serão necessários quando essas capacidades entrarem no escopo?
