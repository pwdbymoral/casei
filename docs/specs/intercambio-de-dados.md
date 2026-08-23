# Specification: importação e exportação de dados

- Status: vigente; subordinada às [decisões de produto do MVP](mvp-casei.md#decisões-de-produto-aprovadas)

## Contexto e objetivo

Planilhas reduzem o custo de adoção e garantem portabilidade. Importação precisa ser segura para grandes lotes e erros parciais; exportação precisa permitir auditoria e reimportação sem aprisionamento.

## Formatos e limites

- Entrada MVP: CSV UTF-8/Latin-1 detectável e XLSX sem macros.
- Saída canônica: CSV UTF-8 com cabeçalho versionado; exportação completa pode gerar ZIP com um CSV por domínio e manifesto JSON.
- Limites iniciais: 10 MB por arquivo, 50 mil linhas e uma planilha selecionada por operação. Limites são configuráveis no servidor e informados antes do upload.
- Fórmulas são lidas pelo valor armazenado; macros, links externos e conteúdo executável nunca são executados.

## Importação

Fluxo obrigatório:

1. escolher domínio e arquivo;
2. detectar cabeçalho, encoding, separador, planilha, locale de datas e moeda;
3. mapear colunas manualmente ou por sugestão editável;
4. validar e exibir prévia com contagens de válidas, avisos, duplicatas e erros;
5. escolher política de duplicata e confirmar;
6. processar em job idempotente;
7. mostrar resultado por linha e permitir baixar relatório de erros.

O usuário pode salvar um perfil de mapeamento nomeado, sem armazenar o arquivo original.

### Duplicidade

- Exportações Casei carregam `casei_id` e são reconciliadas por esse identificador dentro do espaço.
- Arquivos externos usam fingerprint normalizado por domínio, mas coincidência é apresentada como sugestão, não exclusão automática irreversível.
- Políticas: ignorar prováveis duplicatas, importar mesmo assim ou revisar individualmente.
- Repetir o mesmo job/chave não cria novos registros.

### Atomicidade e concorrência

- Validação completa ocorre antes da confirmação.
- Linhas independentes válidas podem ser importadas mesmo com erros, mas o usuário escolhe entre `Somente válidas` e `Tudo ou nada`.
- Operações compostas de uma linha, como parcelamento, são atômicas.
- O resultado registra versão carregada; conflito com edição posterior não sobrescreve dado atual e volta para revisão.
- Cancelar job impede novos lotes e mantém os já confirmados, mostrando exatamente o que foi aplicado. Revogação de membership produz o mesmo bloqueio antes do lote seguinte. Reverter import cria compensações/cancelamentos auditáveis quando permitido.

## Templates por domínio

- **Transações:** tipo, valor, data, estado, descrição, categoria, vencimento, meio, recorrência/parcelas quando aplicável.
- **Produtos:** nome, quantidade, unidade, mínimo, categoria, local e status.
- **Import completo Casei:** IDs e vínculos estáveis para cartões, faturas, metas, empréstimos e séries.

Templates possuem linha de exemplo separada ou documentação adjacente; dados de exemplo nunca são importados por engano.

## Exportação

- Usuário escolhe domínio, período, filtros e formato antes de gerar.
- A exportação respeita o espaço e a permissão atual no instante da geração e do download. A verificação do download ocorre no endpoint autorizado, não somente quando o job é criado.
- No MVP, dados domésticos são baixados por streaming/proxy autorizado que revalida sessão, membership, capacidade e estado do job em cada requisição; URL presignada bearer não é usada para export sensível porque não é revogável durante seu TTL.
- Arquivos grandes são gerados em job com progresso e expiração; o job persiste ator, espaço e capacidade e revalida esses dados antes de cada lote e transição.
- Valores, datas, IDs, estado e vínculos necessários à reimportação são preservados; labels localizados podem coexistir com códigos canônicos.
- CSV protege contra formula injection prefixando valores perigosos conforme política documentada, sem perder o valor lógico no manifesto.
- Export completo inclui versão de schema, fuso, moeda, horário, filtros e checksums no manifesto.

## Privacidade e operação

- Arquivo temporário é criptografado em trânsito e repouso, não vai para logs e expira automaticamente em até 24 horas.
- Apenas owner e member importam; viewer pode exportar somente os domínios que pode visualizar. Export completo é exclusivo do owner.
- Eventos auditam quem iniciou, confirmou, baixou, cancelou ou reverteu, com contagens e hash, não conteúdo linha a linha.

## Critérios de aceitação

- [ ] CSV e XLSX válidos chegam a uma prévia antes de qualquer mutação.
- [ ] Datas, centavos, encoding e separadores comuns em pt-BR são interpretados ou geram erro acionável, nunca coerção silenciosa.
- [ ] Retry e reimportação com IDs não duplicam registros.
- [ ] Resultado parcial identifica cada linha aplicada, ignorada ou rejeitada.
- [ ] Exportação filtrada e completa respeitam permissão e produzem arquivos reimportáveis.
- [ ] Formula injection, macro, arquivo excessivo, revogação durante job/download e acesso após expiração possuem testes de segurança.
