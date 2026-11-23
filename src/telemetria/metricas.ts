import client from 'prom-client';

export const registro = new client.Registry();

client.collectDefaultMetrics({ register: registro });

export const pedidosCriados = new client.Counter({
  name: 'pedidos_criados_total',
  help: 'Total de pedidos criados',
  registers: [registro],
});

export const pedidosConfirmados = new client.Counter({
  name: 'pedidos_confirmados_total',
  help: 'Total de pedidos confirmados',
  registers: [registro],
});

export const cobrancasProcessadas = new client.Counter<'resultado'>({
  name: 'cobrancas_processadas_total',
  help: 'Total de cobrancas processadas por resultado',
  labelNames: ['resultado'],
  registers: [registro],
});

pedidosCriados.inc(0);
pedidosConfirmados.inc(0);
for (const resultado of ['aprovada', 'recusada', 'falha']) {
  cobrancasProcessadas.inc({ resultado }, 0);
}

export const TIPO_DE_CONTEUDO = registro.contentType;

export function coletar(): Promise<string> {
  return registro.metrics();
}