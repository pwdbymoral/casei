# Plano: DATA-006 — UI de importação e exportação

- Status: incremento parcial intencional; aplicação durável depende de DATA-001/DATA-004.
- Spec associada: [intercâmbio de dados](../../specs/intercambio-de-dados.md)
- Planos relacionados: [DATA-002/003](data-002-003.md) e [DATA-005](data-005-export.md)

## Objetivo

Entregar uma jornada única e acessível para preparar importações (domínio,
arquivo, mapeamento, prévia e política de duplicidade), acompanhar aplicação e
baixar o resultado, além de configurar e baixar exportações filtradas ou
completas.

## Fronteira desta fatia

`DataExchangeAdapter` é o port tipado entre a PWA e os jobs DATA-001/DATA-004.
O adapter HTTP envia `multipart/form-data` para os endpoints previstos e não
fabrica sucesso quando o backend ainda não estiver disponível. O adapter de
fixtures exercita a jornada completa em desenvolvimento e testes sem gravar
dados reais. A prévia CSV local é somente um fallback de UX para poder revisar
um arquivo antes da aplicação; a validação canônica continua no servidor.
Quando não há conexão, o adapter autenticado usa esse fallback somente para
CSV; XLSX continua exigindo o servidor. A confirmação e o envio permanecem
bloqueados offline.
Depois que a conexão volta, uma prévia CSV local precisa ser atualizada e
validada pelo servidor antes da confirmação; o fixture de desenvolvimento é a
única exceção explícita.

Não fazem parte desta fatia storage, job worker, persistência de perfis,
autorização server-side, reimportação efetiva ou um parser XLSX no navegador.
Um arquivo XLSX segue para o endpoint de prévia quando DATA-004 estiver
disponível.

## Critérios de aceitação

- [x] Owner/member veem o fluxo de upload; viewer recebe a permissão de somente leitura.
- [x] CSV e XLSX podem ser selecionados, com limite de 10 MB informado antes do envio.
- [x] Domínio, locale, mapeamento editável, política de duplicidade e modo de aplicação são explícitos.
- [x] Prévia mostra válidas, avisos, duplicatas e erros antes de confirmar.
- [x] Aplicação exibe progresso, parcial, sucesso, cancelamento, retry e relatório de erros.
- [x] Exportação oferece domínio, período, formato, progresso, expiração e download autorizado pelo adapter.
- [x] Loading, vazio, erro, offline, permission denied, sucesso e dados parciais possuem feedback acessível.
- [x] Jornada e helpers possuem testes web; a validação visual fica registrada no PR.

## Limitações conhecidas

Os endpoints DATA-001/DATA-004 ainda não existem na API deste branch. Em
ambiente autenticado a UI mostra a indisponibilidade do boundary e preserva o
arquivo/configuração para retry; nenhum sucesso simulado é exibido.
O fallback local respeita o limite de 50 mil linhas e bloqueia a confirmação
quando o arquivo excede esse limite. O relatório de erros prefixa células com
caracteres de fórmula para não transformar mensagens retornadas pelo job em
fórmulas de planilha; a proteção canônica de exportações continua em DATA-005.
No adapter de fixtures, chaves de idempotência são isoladas por espaço,
reproduzem o mesmo resultado e rejeitam uma segunda requisição com payload
divergente; a aplicação server-side permanece responsabilidade do DATA-004.
O parser local mantém campos CSV RFC 4180 com aspas, separadores e quebras de
linha; retries e exportações têm estado pending e uma chave estável enquanto a
operação está em andamento.
