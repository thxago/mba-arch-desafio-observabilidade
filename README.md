# Do sintoma ao post-mortem

Entrega do MBA Arquitetura Full Cycle — Observabilidade e DevOps/SRE. API TypeScript/Express e worker processam pedidos via Redis e PostgreSQL, com Prometheus, Grafana, Jaeger e Alertmanager locais. O defeito de negócio foi preservado: o objetivo é torná-lo observável, não corrigi-lo.

## Como rodar

**Pré-requisitos:** Git, PowerShell 7+ e Docker com suporte a containers Linux e Docker Compose v2 atualizado. No Windows, inicie o Docker Desktop. Não é necessário instalar Node.js, npm ou PostgreSQL no host. Execute os comandos abaixo no PowerShell, mantendo a mesma sessão e o diretório do projeto; as portas publicadas no `compose.yaml` precisam estar livres.

```powershell
git clone https://github.com/thxago/mba-arch-desafio-observabilidade.git
Set-Location .\mba-arch-desafio-observabilidade
Copy-Item .env.example .env
docker compose up -d --wait --wait-timeout 180
docker compose ps -a
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 10
Invoke-RestMethod -Uri 'http://127.0.0.1:8081/health' -TimeoutSec 10
```

O Compose constrói a imagem na primeira execução, aguarda banco/Redis e executa o seed antes da API e do worker. Ambos devem ficar `healthy` e responder `status: ok`; o seed deve terminar com código 0, não permanecer rodando. O arquivo `.env` é local e ignorado pelo Git: não versione credenciais. Estes exemplos usam as portas padrão `API_PORT=8080` e `WORKER_PORT=8081`, também usadas pelos healthchecks e pela coleta configurada.

| Acesso | Endereço / verificação |
| --- | --- |
| API e métricas | `http://127.0.0.1:8080/produtos` e `http://127.0.0.1:8080/metrics` |
| Worker | `http://127.0.0.1:8081/health` e `http://127.0.0.1:8081/metrics` |
| Dashboard Pedidos | `http://127.0.0.1:3000/d/pedidos/pedidos`; login definido por `GRAFANA_ADMIN_USER` e `GRAFANA_ADMIN_PASSWORD` no `.env` |
| Prometheus | `http://127.0.0.1:9090/targets`: API e worker `UP`; `http://127.0.0.1:9090/rules`: `FalhaEmCobrancas` sem erro |
| Jaeger | `http://127.0.0.1:16686`; serviços `api` e `worker` após gerar tráfego |
| Alertmanager | `http://127.0.0.1:9093` |
| Receptor do webhook | `http://127.0.0.1:9099`; a prova do recebimento está em `docker compose logs receptor-alertas` |

O dashboard e os dois datasources são provisionados por arquivos, sem configuração pela interface. Aguarde as primeiras coletas de 15s para consultar métricas.

**Criar e consultar um pedido real.** O seed já inclui produtos e pedidos antigos; não suponha IDs fixos. Este exemplo usa um produto retornado pela API e um cliente de pagamento aprovado:

```powershell
$produtos = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/produtos' -TimeoutSec 10
$produto = $produtos[0]
$corpo = @{
    cliente_id = 'cli-0001'
    itens = @(@{ produto_id = $produto.id; quantidade = 1 })
} | ConvertTo-Json -Depth 4
$inicioPedido = [DateTimeOffset]::UtcNow.ToString('o')
$criado = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8080/pedidos' `
    -ContentType 'application/json' -Body $corpo -TimeoutSec 10
$criado
for ($tentativa = 0; $tentativa -lt 20; $tentativa++) {
    $pedido = Invoke-RestMethod -Uri "http://127.0.0.1:8080/pedidos/$($criado.pedido_id)" -TimeoutSec 10
    if ($pedido.status -ne 'pendente') { break }
    Start-Sleep -Milliseconds 500
}
$pedido | ConvertTo-Json -Depth 5
```

O POST responde 202 com `pedido_id` e `status: pendente`; o processamento é assíncrono. Se o pedido continuar pendente após a espera, consulte saúde e logs do worker.

**Correlacionar API, fila e worker.** Obtenha o trace do pedido recém-criado, sem copiar um ID de outra execução:

```powershell
$eventos = docker compose logs --since $inicioPedido --no-color --no-log-prefix api worker |
    Where-Object { $_.StartsWith('{') } |
    ForEach-Object { $_ | ConvertFrom-Json }
$traceId = ($eventos | Where-Object {
    $_.pedido_id -eq $criado.pedido_id -and $_.service -eq 'api'
} | Select-Object -First 1).trace_id
if (-not $traceId) { throw 'Trace do pedido não encontrado nos logs.' }
docker compose logs --since $inicioPedido --no-color api worker |
    Select-String -SimpleMatch $traceId
"http://127.0.0.1:16686/trace/$traceId"
```

Após alguns segundos para exportação, abra a URL impressa: o mesmo trace deve conter `pedido.criar` na API e `pedido.processar` no worker. Para inspecionar as últimas linhas JSON sem o prefixo do Compose:

```powershell
docker compose logs --no-color --no-log-prefix --tail 20 api worker
```

**Validar a regra antes da carga.** Com a stack ativa, execute os testes de regra já versionados. O caminho `/test` é interno ao container Linux; o caminho de montagem no host é PowerShell/Windows.

```powershell
docker compose exec -T prometheus promtool check rules /etc/prometheus/regras/falha-em-cobrancas.yml
docker compose run --rm --no-deps --entrypoint promtool --volume "${PWD}\prometheus:/test:ro" prometheus test rules /test/testes/falha-em-cobrancas.test.yml
```

Os casos cobrem tráfego saudável com recusas legítimas, tráfego zero, séries ausentes, igualdade ao budget e falha sustentada respeitando `for`. Depois de editar regras, recarregue com `Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:9090/-/reload' -TimeoutSec 10` e confira `/rules`.

**Cargas e teste ponta a ponta, sem sobreposição.** Não mantenha outro gerador ativo. Se repetir um teste após um incidente, aguarde `FalhaEmCobrancas` voltar a `inactive` em `/rules` e a notificação `resolved` chegar ao receptor antes de começar. Reiniciar o receptor não apaga logs antigos nem resolve alertas no Alertmanager.

Primeiro rode `normal` por pelo menos três minutos, após reiniciar o receptor. O bloco mantém o ID do container criado e para somente esse gerador, inclusive se a observação for interrompida:

```powershell
docker compose restart receptor-alertas
$inicioNormal = [DateTimeOffset]::UtcNow.ToString('o')
$normal = docker compose run --rm -d --no-deps carga normal
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível iniciar normal.' }
try {
    Start-Sleep -Seconds 180
    docker compose logs --since $inicioNormal --no-color receptor-alertas
} finally {
    docker stop $normal | Out-Null
}
```

O esperado é **nenhuma notificação de `FalhaEmCobrancas`** nesse intervalo. Não prossiga se houver uma; confira geradores anteriores, estado da regra e logs. O cenário saudável inclui aprovações e recusas legítimas, sem a falha técnica investigada.

Somente depois de parar `normal`, execute `cenario-a`. O bloco observa o primeiro webhook por até cinco minutos, mede o intervalo desde o início real do container e encerra apenas sua própria carga:

```powershell
$desdeIncidente = [DateTimeOffset]::UtcNow.ToString('o')
$incidente = docker compose run --rm -d --no-deps carga cenario-a
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível iniciar cenario-a.' }
try {
    $inicioIncidente = [DateTimeOffset]::Parse((docker inspect --format '{{.State.StartedAt}}' $incidente))
    $limite = $inicioIncidente.AddMinutes(5)
    do {
        Start-Sleep -Seconds 5
        $webhook = docker compose logs --since $desdeIncidente --no-color --no-log-prefix receptor-alertas |
            Select-String -SimpleMatch 'alerta=FalhaEmCobrancas status=firing' |
            Select-Object -First 1
    } while (-not $webhook -and [DateTimeOffset]::UtcNow -lt $limite)
    if (-not $webhook) { throw 'Webhook não recebido em até cinco minutos.' }
    $recebido = [DateTimeOffset]::Parse(($webhook.Line -split ' ')[0])
    $segundos = ($recebido - $inicioIncidente).TotalSeconds
    $webhook.Line
    'Detecção: {0:N3} segundos' -f $segundos
    if ($segundos -gt 300) { throw 'Webhook recebido fora do limite de cinco minutos.' }
} finally {
    docker stop $incidente | Out-Null
}
docker compose logs --since $desdeIncidente --no-color api worker |
    Select-String -SimpleMatch '"level":"error"'
```

O esperado é o webhook `status=firing` e logs de erro de cobrança com motivo, `pedido_id` e `trace_id`, mesmo com respostas HTTP de sucesso. As variáveis dos geradores guardam seus IDs reais; se precisar pará-los manualmente, use `docker stop $normal` ou `docker stop $incidente`, somente enquanto o respectivo container existir. Não execute os dois blocos em paralelo.

**Alterações e encerramento.** O código é montado em volume, mas não recarrega sozinho: após editar arquivos em `src\` ou trocar seu conteúdo por operações Git, reinicie os processos. Alterações em dependências exigem rebuild. Para executar os testes da aplicação, o `sh` abaixo roda dentro do container Linux, não no host:

```powershell
docker compose restart api worker
docker compose up -d --build
docker compose exec -T api sh -c 'npm run tipos && node --import tsx --test src/*/*.test.ts'
```

Esses comandos atendem situações distintas; não é necessário rebuild para editar apenas `src\`. Ao terminar, pare primeiro qualquer gerador criado com `compose run` e então use `docker compose down`, que mantém os volumes nomeados. **Não use `down -v` para uma parada normal:** essa opção remove pedidos, histórico do Prometheus e estado persistido de Grafana/Alertmanager. Jaeger e Redis usam memória e perdem traces/fila ao recriar seus containers.

A investigação histórica, com fontes, IDs, precisão das contagens e ações propostas, está em `reports\post-mortem.md`. Seus horários e IDs pertencem à reprodução de 23/11/2026, não são resultados esperados de um clone novo.

## Equivalências com o curso

| Aspecto | Java no curso | TypeScript nesta entrega |
| --- | --- | --- |
| Métricas | Spring Boot Actuator expõe métricas do Micrometer para o Prometheus | `prom-client`: `Registry`, `Counter` e `Histogram`, expostos em `/metrics`; coleta pull pelo Prometheus |
| Tracing | Micrometer Tracing com bridge OpenTelemetry e exportação OTLP | `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node` e `@opentelemetry/api` para spans manuais; `@opentelemetry/exporter-trace-otlp-http` para Jaeger |
| Logs estruturados | Logs JSON com IDs do contexto de tracing correlacionados via MDC | Logger próprio usa `trace.getActiveSpan()` e escreve JSON no stdout com `trace_id`, `span_id` e `pedido_id`; sem MDC ou biblioteca de logging adicional |
| Propagação de contexto | W3C Trace Context associado ao tracing OpenTelemetry na aplicação Java | `propagation.inject()` no JSON da fila Redis; `propagation.extract(ROOT_CONTEXT, mensagem)` e `context.with()` no consumidor, preservando `traceparent`/`tracestate` quando presentes |

Actuator, Micrometer e o bridge são componentes Java, não dependências instaladas no Node. A equivalência está nos sinais, no contexto e nos protocolos.

## Decisões técnicas

O histograma usava caminhos concretos como `/pedidos/25`, criando séries por identificador e multiplicando memória/armazenamento até comprometer o Prometheus em produção; agora usa templates como `/pedidos/:id` e o valor fixo `nao_encontrada` para rotas desconhecidas.

| Métrica de negócio | O que responde / ponto de incremento |
| --- | --- |
| `pedidos_criados_total` | Quantos pedidos foram persistidos com sucesso? Incrementada pela API após criar no banco, antes de publicar na fila; não garante publicação nem processamento |
| `pedidos_confirmados_total` | Quantos pedidos o worker atualizou para confirmado? Incrementada após persistir o status; não garante pagamento aprovado |
| `cobrancas_processadas_total` | Quantas cobranças tiveram aprovação, recusa legítima ou exceção? O único label de negócio é `resultado`, com os valores `aprovada`, `recusada` e `falha` |

Os três contadores são inicializados em zero nos dois processos, incluindo todos os resultados de cobrança. Somente a API incrementa criações; somente o worker incrementa confirmações e resultados de cobrança. Some as séries dos processos; aplique `rate()`/`increase()` antes da soma para tratar resets individualmente. IDs de pedido/cliente ficam nos logs e traces, nunca nos labels.

Essas métricas contam eventos, não valores financeiros nem pedidos únicos em possíveis reprocessamentos. `increase()` extrapola amostras e não substitui uma contagem exata; o valor monetário exige cruzar os pedidos afetados com seus dados no banco, sem somar indiscriminadamente todas as confirmações.

O dashboard **Pedidos**, versionado em `grafana\provisioning\dashboards\pedidos.json`, contém quatro painéis:

| Painel | Pergunta respondida | Como interpretar |
| --- | --- | --- |
| Falhas tecnicas: cobrancas e HTTP 5xx | O sistema está com erro? | Compara falhas técnicas de cobrança e HTTP 5xx/s; recusas legítimas não são falhas e HTTP 2xx não prova cobrança |
| Latencia HTTP p95 por rota | O sistema está lento? | p95 em segundos, agregando buckets por `le` e `route` antes do quantil; exclui `/health` e `/metrics` |
| Pedidos criados, confirmados e cobrancas aprovadas | O dinheiro está entrando? | Compara as três taxas; confirmações sustentadamente acima de aprovações sinalizam divergência |
| Cobrancas por resultado | O dinheiro está entrando? | Separa aprovações, recusas legítimas e falhas técnicas para explicar o destino das cobranças |

As consultas usam `$__rate_interval`, respeitando coleta e zoom, e `rate()` antes da agregação. Unidades são eventos/s ou segundos, nunca moeda: os painéis não quantificam receita nem prejuízo. Atrasos da fila podem produzir diferenças transitórias. Sem requisições, o p95 fica sem valor; HTTP 5xx só assume zero na presença das métricas HTTP, sem mascarar coleta ausente. Salve mudanças no JSON versionado, não apenas na interface.

O logger consulta o span ativo em cada escrita e sempre inclui `timestamp`, `level`, `service`, `msg`, `trace_id` e `span_id`; sem span, os dois IDs são strings vazias. Logs de pedidos incluem `pedido_id`, fornecido explicitamente ou pelo contexto ativo do processamento. Não há agregador central de logs.

Os spans `pedido.criar` e `pedido.processar` delimitam o negócio com atributos de pedido, cliente e valor; o consumidor inclui fila e status final. O produtor injeta W3C Trace Context no JSON sem alterar os dados originais. O worker extrai a partir de `ROOT_CONTEXT` e ativa o contexto antes do span `CONSUMER`, evitando herdar contexto de outra mensagem. Mensagens antigas sem contexto continuam válidas e iniciam um trace independente.

O SDK sobe antes da aplicação, instrumenta automaticamente HTTP, Redis e PostgreSQL, amostra 100% e exporta diretamente por OTLP/HTTP para o Jaeger, sem Collector. Exceções capturadas geram evento no span, status `ERROR` e log com motivo; spans terminam em `finally`. O fluxo original foi preservado, inclusive a confirmação incorreta após falha de cobrança e o relançamento no handler async do Express 4, sem converter uma rejeição que derrubaria a API em resposta 500.

## SLO e alerta

**SLI:** proporção de cobranças processadas com resposta válida (aprovação ou recusa legítima), sem falha técnica, entre todas as cobranças processadas na janela.

```promql
(
  sum(increase(cobrancas_processadas_total{resultado=~"aprovada|recusada"}[30d]))
  /
  sum(increase(cobrancas_processadas_total[30d]))
)
and on()
(sum(increase(cobrancas_processadas_total[30d])) > 0)
```

**SLO:** SLI de pelo menos **99,9% em janela móvel de 30 dias**. A cobrança é financeiramente crítica: o objetivo proposto tolera no máximo uma falha técnica a cada mil cobranças, sem penalizar recusas legítimas. Mede processamento técnico, não conciliação financeira ou valor recebido.

**Error budget:** `1 - 0,999 = 0,001 = 0,1%` das cobranças. Para `N` cobranças na janela, são `0,001 × N` falhas técnicas; por exemplo, 10 em 10.000. O orçamento é baseado em eventos, não automaticamente em minutos de indisponibilidade. O Compose mantém retenção de 30 dias no Prometheus; antes de haver esse histórico, o SLI usa apenas o período disponível e estimado por `increase()`.

**Derivação de `FalhaEmCobrancas`:** a regra em `prometheus\regras\falha-em-cobrancas.yml` compara a fração de falhas em **1 minuto** com o mesmo budget, sem multiplicador adicional de burn rate (`B = 1`):

```text
limiar = B × (1 - SLO) = 1 × (1 - 0,999) = 0,001 = 0,1%
```

```promql
(
  sum(rate(cobrancas_processadas_total{resultado="falha"}[1m]))
  /
  sum(rate(cobrancas_processadas_total[1m]))
) > (1 - 0.999)
and on()
(sum(rate(cobrancas_processadas_total[1m])) > 0)
```

A condição deve permanecer verdadeira por **`for: 1m`**. O limite é estrito: igualdade ao budget não dispara. Recusas entram no denominador, não no numerador de falhas. Sem tráfego ou sem coleta, não há resultado avaliável que dispare; isso não comprova sucesso e ausência de telemetria exigiria monitoramento próprio.

O Prometheus coleta e avalia a cada **15s**. A detecção inclui histórico saudável na janela de `rate()`, coleta, avaliação, `for` e **`group_wait: 10s`** do Alertmanager; atualizações do grupo respeitam `group_interval: 30s` e repetições, `repeat_interval: 1h`. Reiniciar API/worker não limpa o histórico do Prometheus. O único destino é o webhook local `receptor-alertas`, com severidade `critical`.

A janela curta busca tornar o defeito observável durante o exercício, não provar que o SLO de 30 dias já foi violado. É sensível a falhas isoladas em baixo volume e deve ser revista antes de uso operacional, inclusive quanto a alertas de múltiplas janelas.

Na reprodução de **23/11/2026**, `normal` foi observado por **180,329s sem notificações**. Em seguida, o primeiro webhook chegou **86,915s** após iniciar `cenario-a`: 19:18:05,639 até 19:19:32,554, em UTC-03:00. Esse tempo foi medido no receptor, não inferido apenas do `for`; novas execuções variam com coleta, avaliação, histórico e agrupamento.