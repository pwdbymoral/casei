# Plano: DATA-005 — exportação versionada

- Status: ativo
- Spec associada: [intercâmbio de dados](../../specs/intercambio-de-dados.md)
- Arquitetura: [núcleo de intercâmbio](../../architecture/intercambio-de-dados-csv.md)

## Objetivo

Entregar no pacote puro `@casei/data` a exportação CSV versionada e um
empacotador ZIP streaming com `manifest.json`, checksums e proteção obrigatória
contra formula injection. O pacote não acessa storage, sessão, banco ou
autorização; jobs, retenção e proxy autorizado são responsabilidade da camada de
aplicação.

## Critérios de aceitação

- CSV mantém cabeçalho versionado, IDs estáveis, manifesto determinístico,
  SHA-256 e proteção contra células executáveis.
- ZIP contém o CSV e `manifest.json`, usa CRC-32/diretório central válidos e
  pode ser consumido sem acumular o CSV inteiro em memória.
- Cancelamento ou falha do ZIP cancela o stream CSV e fecha o iterador da fonte.
- Limites de linhas, bytes, células e células protegidas continuam sendo
  aplicados pelo exportador CSV antes de qualquer conclusão de manifesto.
- Nome de arquivo e metadados não permitem path traversal ou conteúdo inválido.

## Implementação e rastreabilidade

- `packages/data/src/export.ts`: `createVersionedCsvExport` existente e novo
  `createVersionedZipExport`, com data descriptors, CRC-32 e ZIP32 bounded.
- `packages/data/test/export.test.ts`: 51 testes, incluindo leitura do diretório
  central, CSV/manifesto no ZIP e cancelamento da fonte subjacente.
- `docs/architecture/intercambio-de-dados-csv.md` e a spec registram a fronteira
  entre o núcleo puro e o proxy/job autorizado.

## Decisões

- O ZIP usa armazenamento sem compressão para manter a implementação
  streaming-friendly e bounded sem introduzir dependência nativa; o CSV já é
  limitado pelo exportador e o overhead ZIP é pequeno e determinístico.
- Data descriptors permitem escrever o cabeçalho antes de conhecer CRC e
  tamanho; o diretório central é emitido ao final, quando todos os checksums
  estão disponíveis.
- O primitivo recebe uma exportação de domínio por vez. Composição de múltiplos
  CSVs e manifesto final fica no job DATA-004/ambiente de aplicação.

## Validação

- `vitest run` em `packages/data`: 51 testes passando.
- `tsc --noEmit` em `packages/data`: passando.
- Biome nos arquivos alterados e `git diff --check`: passando.
