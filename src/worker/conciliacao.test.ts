import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cobrancasProcessadas, coletar } from '../telemetria/metricas';
import { decidirStatusDoPedido } from './conciliacao';

test('expoe todas as series de negocio em zero antes de processar eventos', async () => {
  const metricas = await coletar();
  assert.match(metricas, /^pedidos_criados_total 0$/m);
  assert.match(metricas, /^pedidos_confirmados_total 0$/m);
  for (const resultado of ['aprovada', 'recusada', 'falha']) {
    assert.ok(metricas.includes(`cobrancas_processadas_total{resultado="${resultado}"} 0\n`));
  }
});

test('conta resultados reais de cobranca sem alterar a decisao legada', async () => {
  const casos = [
    { cliente: 'teste-1', resultado: 'aprovada', status: 'confirmado' },
    { cliente: 'teste-3', resultado: 'recusada', status: 'recusado' },
    { cliente: 'teste-7', resultado: 'falha', status: 'confirmado' },
  ];
  const esperado: Record<string, number> = { aprovada: 0, recusada: 0, falha: 0 };

  for (const caso of casos) {
    assert.equal(await decidirStatusDoPedido(caso.cliente, 10), caso.status);
    esperado[caso.resultado]++;
    const metrica = await cobrancasProcessadas.get();
    assert.deepEqual(Object.fromEntries(
      metrica.values.map(({ labels, value }) => [labels.resultado, value])
    ), esperado);
  }
});