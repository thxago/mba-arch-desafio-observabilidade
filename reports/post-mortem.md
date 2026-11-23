# Post-mortem: pedidos confirmados sem cobrança

## Resumo

Na reprodução local de `cenario-a` em 23/11/2026, 68 pedidos foram confirmados apesar de falha na cobrança, somando 66.512,89 em `valor_total`. O tratamento da exceção permitia confirmar sem aprovação de pagamento; métricas, trace e logs demonstraram essa sequência, e o alerta notificou em 86,915 segundos. A reprodução foi contida encerrando o gerador, mas o defeito permanece intencionalmente sem correção nesta entrega.

## Impacto

**Janela de apuração:** 23/11/2026, de **19:18:05 até 19:19:45, UTC-03:00**, com início inclusivo e fim exclusivo (`22:18:05Z` a `22:19:45Z`). Ela inclui a inicialização de `cenario-a` às 19:18:05,639 e o escoamento do processamento; o último evento da reprodução foi às 19:19:35,779. Não representa 100 segundos exatos de geração de carga.

| Medida | Resultado | Fonte e precisão |
| --- | --- | --- |
| Pedidos criados | 159 | Contagem exata dos logs, confirmada por `pedidos.criado_em` no banco e pelo delta do contador |
| Pedidos confirmados | 149 | Contagem exata dos logs, status no banco e delta do contador |
| Cobranças aprovadas | 81 | Delta exato de `cobrancas_processadas_total{resultado="aprovada"}` nos snapshots antes/depois |
| Recusas legítimas | 10 | Logs de status recusado, banco e delta do contador; não são pedidos afetados |
| Pedidos afetados | **68** | 68 IDs distintos com log de falha de cobrança, confirmação posterior e status confirmado no banco |
| Valor desses 68 pedidos | **66.512,89** | Soma exata de `pedidos.valor_total`, tipo `numeric(10,2)`, somente dos IDs afetados |
| Falhas estimadas pelo Prometheus | 69,33333333333333 | `increase()` em 100s, avaliado às 22:19:45Z; estimativa extrapolada, não contagem exata |

A diferença entre a estimativa de 69,33 e os 68 casos exatos decorre da amostragem e extrapolação de `increase()`. A quantidade oficial deste relatório é 68, obtida pelos casos individuais, não por arredondamento da métrica. Os deltas dos snapshots também foram 159 criados, 149 confirmados, 81 aprovações, 10 recusas e 68 falhas, sem reset dos processos entre os dois cenários.

O valor é **nominal e simulado, na unidade monetária da aplicação**: ela não declara moeda, portanto não se assume BRL nem perda bancária real. Foram somados apenas os 68 pedidos afetados, não todos os 149 confirmados. O banco contém o valor dos pedidos, mas não uma conciliação bancária; a ausência de aprovação é sustentada pela telemetria e pelo processador local simulado.

Consulta de leitura para auditar a soma, usando os IDs extraídos dos logs de erro e confirmados nos logs de processamento desta execução:

```sql
BEGIN READ ONLY;
WITH falhas(pedido_id) AS (
  SELECT unnest(ARRAY[
    587,588,591,592,593,594,596,597,603,604,606,607,
    612,613,615,617,620,624,625,626,627,628,629,630,
    631,634,637,638,639,640,646,650,652,653,654,655,
    656,658,662,666,667,677,679,680,681,687,692,693,
    696,698,704,707,708,709,714,716,719,722,725,726,
    730,733,735,736,738,740,742,745
  ]::integer[])
)
SELECT count(*) AS afetados_confirmados,
       sum(p.valor_total) AS valor_total_afetado
FROM pedidos p
JOIN falhas f ON f.pedido_id = p.id
WHERE p.status = 'confirmado'
  AND p.criado_em >= TIMESTAMPTZ '2026-11-23T22:18:05Z'
  AND p.criado_em < TIMESTAMPTZ '2026-11-23T22:19:45Z';
ROLLBACK;
```

Resultado: `afetados_confirmados = 68`, `valor_total_afetado = 66512.89`. IDs e horários identificam esta reprodução; uma execução futura deve obter seus próprios IDs, não reutilizar esta lista.

## Detecção

No cenário apresentado, a descoberta foi manual, pelo financeiro no fechamento mensal, ao comparar pedidos confirmados com entradas efetivas. O enunciado não informa quando o defeito começou nem a duração exata até essa descoberta; não é possível afirmar que a detecção anterior levou um mês inteiro.

Na reprodução instrumentada, o dashboard mostrou confirmações acima de aprovações e falhas técnicas mesmo sem HTTP 5xx. Às 19:19:30, as consultas de taxa em 1m retornaram aproximadamente **1,7333 confirmações/s** e **1,0889 aprovações/s**; a investigação seguiu daí para um trace e para os pedidos individuais, antes de confirmar a explicação no código.

O SLO proposto é 99,9% de respostas válidas de cobrança em 30 dias, com budget de 0,1%; recusas legítimas são válidas. `FalhaEmCobrancas` compara a fração de falhas em 1m com `1 - 0.999`, sustentada por `for: 1m`. O cenário `normal` foi observado por **180,329 segundos sem notificações**; imediatamente depois, `cenario-a` gerou o primeiro webhook em **86,915 segundos** desde a inicialização do container.

Esse tempo foi medido até o receptor, não inferido do `for`: inclui coleta e avaliação a cada 15s, histórico saudável na janela de `rate()`, os 60s de persistência e o `group_wait` de 10s. A mudança é de descoberta posterior por conciliação manual para sinalização durante o processamento; o alerta não substitui conciliação financeira nem prova, sozinho, violação do SLO de 30 dias.

## Causa raiz

**Arquivo:** `src\worker\conciliacao.ts`. **Função:** `decidirStatusDoPedido`. Trecho observado na base analisada, commit `596a3f4`:

```typescript
export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    cobrancasProcessadas.inc({ resultado: resultado.aprovado ? 'aprovada' : 'recusada' });
    recusado = !resultado.aprovado;
  } catch (erro) {
    cobrancasProcessadas.inc({ resultado: 'falha' });
    registrarErro(erro, 'erro ao processar cobranca');
    registrarFalhaLegado(erro);
  }

  return recusado ? 'recusado' : 'confirmado';
}
```

Quando o pagamento lança uma exceção, a atribuição `recusado = !resultado.aprovado` não ocorre. O `catch` registra o problema, mas mantém `recusado` em `false`; o retorno escolhe `confirmado`. `processarMensagem`, em `src\worker\index.ts`, persiste esse retorno com `atualizarStatusPedido`, produzindo confirmação sem cobrança aprovada.

O **gatilho**, distinto do defeito, é `processarPagamento`, em `src\worker\pagamento.ts`: clientes com último dígito 7 geram a exceção simulada `gateway respondeu de forma inesperada`; o dígito 3 produz recusa legítima. O registro legado mantém ocorrências em uma lista limitada em memória e não impede a confirmação. Instrumentar o `catch` tornou o problema visível, sem mudar sua decisão funcional; a correção definitiva está apenas nos itens de ação.

## Evidências

**Trace real:** `b9ed9eebc9edadebba250794d78e7d48`, observado no [Jaeger](http://localhost:16686/trace/b9ed9eebc9edadebba250794d78e7d48), pedido `587`, cliente sintético `cli-0367`, valor `1108.31`.

| Serviço | Span | ID | Resultado observado |
| --- | --- | --- | --- |
| api | `pedido.criar` | `3be12dfce5dd2f0b` | Pedido 587 criado; mesmo trace do worker |
| worker | `pedido.processar` | `248263e8810f7d39` | `CHILD_OF` do span de criação; `error=true`, `otel.status_code=ERROR`, evento `exception` com o motivo do gateway e atributo final `pedido.status=confirmado` |

A consulta posterior `GET /pedidos/587` retornou HTTP 200 com `status: confirmado` e `valor_total: 1108.31`; o banco confirmou o mesmo pedido. Isso liga a falha técnica ao sucesso aparente de um caso individual, não a um palpite sobre o banco.

**PromQL utilizada:** a fração de falhas técnicas abaixo, avaliada pela API do Prometheus com `time=2026-11-23T22:19:30Z`, retornou **`0.3536585365853659`**, aproximadamente **35,37%**, acima do budget de 0,1%:

```promql
sum(rate(cobrancas_processadas_total{resultado="falha"}[1m]))
/
sum(rate(cobrancas_processadas_total[1m]))
```

Para estimar a quantidade na janela de apuração, a consulta seguinte, avaliada com `time=2026-11-23T22:19:45Z`, retornou **`69.33333333333333`**:

```promql
sum(increase(cobrancas_processadas_total{resultado="falha"}[100s]))
```

**Busca no log executada:**

```powershell
docker compose logs --no-color api worker |
    Select-String -SimpleMatch 'b9ed9eebc9edadebba250794d78e7d48'
```

Resultado: quatro linhas, uma da API e três do worker, com o mesmo trace e `pedido_id: 587`. Conteúdo JSON das linhas, sem o prefixo de apresentação do Compose:

```json
{"timestamp":"2026-11-23T22:18:06.760Z","level":"info","service":"api","msg":"pedido 587 criado para cli-0367","trace_id":"b9ed9eebc9edadebba250794d78e7d48","span_id":"3be12dfce5dd2f0b","pedido_id":587}
{"timestamp":"2026-11-23T22:18:06.760Z","level":"info","service":"worker","msg":"mensagem do pedido 587 recebida da fila","trace_id":"b9ed9eebc9edadebba250794d78e7d48","span_id":"248263e8810f7d39","pedido_id":587}
{"timestamp":"2026-11-23T22:18:06.812Z","level":"error","service":"worker","msg":"erro ao processar cobranca: gateway respondeu de forma inesperada","trace_id":"b9ed9eebc9edadebba250794d78e7d48","span_id":"248263e8810f7d39","pedido_id":587}
{"timestamp":"2026-11-23T22:18:06.816Z","level":"info","service":"worker","msg":"pedido 587 ficou confirmado","trace_id":"b9ed9eebc9edadebba250794d78e7d48","span_id":"248263e8810f7d39","pedido_id":587}
```

**Webhook observado no receptor:**

```text
2026-11-23T22:19:32.554Z alerta=FalhaEmCobrancas status=firing
```

Os horários dos logs com `Z` estão em UTC; as tabelas narrativas usam UTC-03:00. Logs, consultas históricas, deltas, snapshots de regras, trace completo e apuração SQL foram preservados localmente, fora do versionamento. Os resultados essenciais e os IDs estão transcritos aqui; a disponibilidade futura do trace no Jaeger depende de não recriar seu armazenamento em memória.

## Lições aprendidas

**O que correu bem:** métricas de negócio revelaram o que o HTTP não mostrava; a propagação pela fila ligou API, falha e confirmação no mesmo trace; logs estruturados permitiram contar casos exatos e cruzá-los com os valores do banco. O alerta chegou ao receptor dentro do limite e não confundiu recusas legítimas com falhas.

**O que correu mal:** a decisão de confirmação era permissiva em caso de exceção; o sucesso aparente ao cliente não comprovava cobrança. A instrumentação original e o registro legado em memória não davam visibilidade operacional suficiente, e o banco não guardava resultado/autorização de pagamento por pedido para uma conciliação direta.

**Onde tivemos sorte:** o processador simulado e a carga determinística tornaram o caso reproduzível sem dinheiro real. Os contadores não foram reiniciados entre os cenários e os logs, traces e dados do banco ainda estavam disponíveis para validar as fontes, em vez de depender apenas de uma estimativa agregada.

## Itens de ação

| Ação | Tipo | Prioridade | Situação |
| --- | --- | --- | --- |
| Corrigir `decidirStatusDoPedido` para confirmar somente após aprovação explícita e tratar falha técnica sem confirmar; adicionar teste do comportamento corrigido | evitar | P0 | Planejada; correção definitiva **não executada** neste desafio |
| Persistir resultado e autorização de cobrança vinculados ao pedido, distinguindo aprovação, recusa e falha para auditoria | evitar | P1 | Planejada |
| Conciliar os 68 IDs com as evidências de cobrança antes de decidir recuperação; qualquer reprocessamento deve ser idempotente para não cobrar em duplicidade | mitigar | P0 | Planejada; nenhum reprocessamento realizado |
| Manter o alerta derivado do SLO e um roteiro de resposta que cruza métrica, trace, logs e valor do pedido | mitigar | P1 | Instrumentação e alerta entregues; rotina operacional futura |

## Timeline

Todos os horários abaixo são de **23/11/2026, UTC-03:00**. A descoberta pelo financeiro pertence ao contexto do exercício e não tem horário informado.

| Horário | Evento e origem |
| --- | --- |
| 19:15:01,740 | Início de `normal`, conforme horário de início do container |
| 19:18:03,004 | Concluída a observação de 180,329s sem notificações; cenário saudável encerrado em seguida, conforme registro da validação |
| 19:18:05,639 | Início de `cenario-a`, conforme container; começo da reprodução incidente |
| 19:18:06,760 | API registra a criação do pedido 587 e worker registra seu recebimento, no mesmo trace |
| 19:18:06,812 | Worker registra a primeira falha de cobrança da reprodução, com motivo e IDs correlacionados |
| 19:18:06,816 | Worker registra o mesmo pedido como confirmado, demonstrando a inconsistência |
| 19:18:22,487 | `FalhaEmCobrancas` entra em `pending`, conforme `activeAt` no Prometheus |
| 19:19:22,489 | Avaliação da regra em `firing`, após sustentar a condição por 60s |
| 19:19:32,554 | Receptor registra o webhook: 86,915s após o início do cenário |
| 19:19:35,779 | Último evento de processamento nos logs coletados; o gerador foi encerrado ao fim da observação, sem correção do defeito |
| 19:19:45 | Fim exclusivo da janela escolhida para apuração, incluindo escoamento; não é o horário exato de parada do container |
| 19:34–19:37 | Investigação histórica: painéis e PromQL, trace/logs, consulta SQL de leitura e confirmação da causa no código; apurados 68 casos e soma de 66.512,89 |