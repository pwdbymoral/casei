# ADR: armazenamento temporário compatível com S3

- Status: aprovada
- Data: 2026-08-23
- Spec ou contexto relacionado: [intercâmbio de dados](../../specs/intercambio-de-dados.md)

## Contexto

Imports e exports podem sobreviver ao request e ser processados pelo worker. Disco local não é compartilhado entre réplicas e se perde em containers efêmeros; armazenar arquivos binários no PostgreSQL prejudica backup e operação.

## Decisão

Definir `ObjectStoragePort` e implementar o primeiro adapter com `@aws-sdk/client-s3`, aceitando endpoint S3-compatible, região, bucket, credenciais e `forcePathStyle` por ambiente. Desenvolvimento local usa MinIO em profile separado do Compose; produção pode usar qualquer serviço compatível validado.

Objetos usam chave opaca com namespace de ambiente/espaço/job, sem nome original ou e-mail. Metadata sensível permanece no PostgreSQL. Upload e download são streaming, com limite também aplicado no servidor; o browser nunca recebe credenciais permanentes.

Downloads de dados domésticos usam streaming/proxy autorizado no MVP: cada requisição revalida sessão, membership, capacidade, espaço e estado do job antes de ler o objeto. URL presignada não é usada para export sensível, pois é um bearer token não revogável até o TTL. Upload direto assinado fica fora da primeira implementação de 10 MB, mas o port permite adicioná-lo para arquivos não sensíveis após decisão específica.

Arquivos temporários expiram logicamente em até 24 horas e o bucket possui lifecycle de defesa em profundidade. Job de limpeza trata falhas/órfãos. Criptografia em trânsito é obrigatória em ambiente publicado; criptografia em repouso é exigida do adapter/deploy.

A implementação compartilhada fica em `@casei/storage`: `ObjectStoragePort` não
expõe URLs e `S3ObjectStorage` usa `PutObject`/`GetObject`/`HeadObject`/
`DeleteObject` com stream, `Content-Length`, SHA-256, metadata de formato e
expiração, `Cache-Control: no-store` e `ServerSideEncryption: AES256`. O
adapter rejeita chaves com traversal/controle, aplica o limite padrão de 10 MB
e o TTL máximo de 24 horas, e remove um upload parcial quando a fonte, o hash
ou a varredura falha. `FormatFileScanPort` valida MIME, assinatura ZIP do XLSX,
bytes NUL e tamanho; `FileScanPort` é uma injeção explícita para scanner de
malware do deploy e o scanner de formato nunca declara um antivírus limpo.
O pacote aceita `CASEI_OBJECT_STORAGE_*` por ambiente, credenciais são
opcionais para permitir a cadeia padrão do SDK/IAM e um par parcial de chaves é
rejeitado.

## Consequências

- API e worker compartilham arquivos sem afinidade de instância.
- Surge um serviço opcional no desenvolvimento das features de import/export, não necessário nos gates anteriores.
- Compatibilidade S3 deve ser testada contra o adapter local e o alvo publicado, pois implementações variam em detalhes.
- Uma URL presignada, se aprovada futuramente para conteúdo não sensível, precisa de TTL curto e nunca substitui autorização no momento da emissão; ela não oferece revogação imediata.

## Alternativas consideradas

- Filesystem local/volume: simples em uma instância, mas dificulta escala, limpeza e deploy genérico.
- `bytea` no PostgreSQL: transacional, porém aumenta banco/backups e mistura workloads.
- API proprietária de storage: pode oferecer recursos extras, mas cria lock-in desnecessário.

## Compatibilidade e migração

O domínio armazena `storageKey`, hash, tamanho e estado, nunca URL do fornecedor. Troca de adapter pode copiar objetos ativos e atualizar apenas metadados operacionais. Referência: [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3).
