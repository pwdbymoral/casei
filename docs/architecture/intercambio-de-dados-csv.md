# Núcleo CSV de intercâmbio

- Status: vigente
- Spec: [intercâmbio de dados](../specs/intercambio-de-dados.md)
- Pacote: `@casei/data`

## Escopo

`@casei/data` é o núcleo puro usado pelas fatias de importação. Ele não acessa
filesystem, object storage, banco, sessão ou casos de uso. Recebe bytes ou texto
já mantidos pelo chamador e devolve uma prévia imutável; nenhuma função aplica
linhas ou cria registros. CSV e XLSX convergem para uma representação tabular
comum; armazenamento temporário, jobs e perfis persistidos permanecem nas
fatias DATA-001, DATA-004 e DATA-006.

## Limites e parsing

`parseCsv` mede os bytes originais antes de decodificar. Os padrões do MVP são;
o boundary do servidor pode fornecer limites positivos diferentes quando uma
política operacional aprovada exigir:

- 10.000.000 bytes por arquivo;
- 50.000 linhas de dados, sem contar o cabeçalho;
- 256 colunas e 1.000.000 bytes por célula.

Os limites são validados como inteiros positivos antes de serem usados. UTF-8 estrito é tentado primeiro; bytes inválidos
usam Latin-1 detectável. BOM UTF-8 é aceito, UTF-16 e bytes NUL são rejeitados.
O parser implementa CSV RFC 4180 (aspas, aspas duplicadas, CRLF/LF e quebras de
linha em campos), mantém linhas com largura incorreta para diagnóstico e nunca
avalia conteúdo como fórmula ou código.
Registros com campos vazios, inclusive `""` e linhas fisicamente vazias
previstas pelo formato, são mantidos para que o preflight produza o resultado e
o erro obrigatório daquela linha; uma quebra de linha final isolada não cria um
registro adicional.

O separador é detectado no cabeçalho entre vírgula, ponto e vírgula e TAB. Para
um arquivo de uma coluna, `locale: "pt-BR"` escolhe ponto e vírgula como fallback
para que uma vírgula decimal não seja confundida com separador. Datas com barra
exigem locale explícito; valores monetários são convertidos por strings para
minor units, sem `number` ou float.

`parseXlsx` lê uma única planilha visível selecionada por nome ou índice; quando
o workbook tem mais de uma planilha, a seleção é obrigatória. O parser mede os
bytes originais, inspeciona o diretório ZIP e cada cabeçalho local antes do
load, descompacta cada entrada com um limite rígido de saída e compara os bytes
reais com os tamanhos declarados. Assim, um tamanho pequeno forjado no
diretório central não permite burlar o orçamento nem faz o ExcelJS receber o
arquivo. Ele rejeita criptografia, caminhos inválidos, VBA, links externos,
métodos de compressão inesperados e expansão acima do limite. ExcelJS `4.4.0`
é usado somente para materializar o workbook já validado. Células de fórmula
usam exclusivamente o resultado armazenado; fórmula sem cache, erro de célula,
tipo desconhecido, linha/célula excessiva ou cabeçalho inválido gera
diagnóstico sem avaliação. Números inteiros não seguros e decimais com mais de
15 dígitos significativos geram `numeric_precision_loss`, porque o lexema XML
não é exposto pelo modelo numérico do ExcelJS e não pode ser arredondado
silenciosamente.

## Mapeamento e preflight

`mapCsvColumns` compara chaves e aliases após normalização Unicode, caixa,
acentos, pontuação e espaços. O cabeçalho original é preservado. Ambiguidades,
colunas ausentes obrigatórias e mapeamentos duplicados são diagnósticos
explícitos; colunas desconhecidas são aviso por padrão ou erro quando o fluxo
escolhe `unknownColumns: "error"`.

`preflightCsvImport` percorre todas as linhas antes de qualquer aplicação,
valida campos com parsers fornecidos pelo domínio e retorna cada linha como
`valid`, `duplicate` ou `invalid`, incluindo seus erros, avisos, valores
normalizados e número de origem. A mesma função aceita a representação tabular
produzida por CSV ou XLSX. Perfis nomeados criados por
`createCsvMappingProfile` armazenam apenas domínio, locale e cabeçalhos
normalizados; `applyCsvMappingProfile` reaplica a preferência e mantém
ambiguidade, campo ausente ou drift como diagnóstico editável. Fingerprints SHA-256 incluem domínio, espaço
opcional, nomes e valores normalizados. Coincidências são somente sugestões:
repetir um fingerprint não remove nem invalida automaticamente uma linha.
A API de fingerprint aceita somente valores escalares (`string`, `number`,
`bigint`, `boolean`, `null` ou `undefined`); objetos e arrays são rejeitados
para evitar que a ordem ou a forma de uma estrutura aninhada altere o contrato
sem uma canonicalização de domínio explícita. Um domínio que precise incluir
dados compostos deve convertê-los primeiro para uma representação escalar
canônica.

## Proteção de exportação

`protectCsvFormula` e `serializeCsv` sempre prefixam com apóstrofo textos que
começam com espaço/tab/quebra de linha seguido de `=`, `+`, `-` ou `@`; o
serializador público não oferece opt-out. O resultado
expõe também o `logicalValue`, permitindo que DATA-005 preserve o valor lógico
no manifesto sem entregar uma célula executável a planilhas.

`createVersionedCsvExport` acrescenta as colunas reservadas
`casei_schema_version` e `casei_id` ao cabeçalho canônico e recebe somente
colunas declaradas pelo domínio. Ele devolve um `ReadableStream<Uint8Array>`
UTF-8 de uso único: o hash SHA-256, contagem e tamanho são calculados durante o
consumo, em chunks limitados, sem acumular o arquivo inteiro em memória. O
manifesto só resolve após o EOF e contém schema, domínio, horário UTC, fuso,
moeda, filtros congelados, colunas, checksum do CSV e posições/valores lógicos
das células protegidas.

O núcleo rejeita linhas sem `casei_id`, campos não declarados, valores que não
sejam strings/nulos, excesso de linhas/bytes/células e cancelamento do stream.
`createVersionedCsvExport` aplica essa proteção sempre; não há opt-out na API
pública, para que nenhum consumidor produza uma planilha executável por
configuração acidental. `createVersionedZipExport` compõe o CSV versionado e
`manifest.json` em um ZIP armazenado (sem compressão), usando data descriptors,
CRC-32 e diretório central para continuar emitindo o arquivo sem acumular o
CSV. O manifesto é o mesmo objeto versionado e contém o checksum do CSV; o
primitivo de pacote cobre um domínio por vez e o boundary de job pode compor
vários domínios.

Jobs, autorização no momento do download, proxy autenticado e armazenamento
temporário permanecem fora do pacote. O download sensível usa o proxy
autorizado descrito na decisão de armazenamento, revalidando sessão,
membership, capacidade, espaço e estado do job a cada requisição; URL
presignada bearer não é usada.
