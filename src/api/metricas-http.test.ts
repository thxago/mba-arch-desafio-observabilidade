import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { registro } from '../telemetria/metricas';
import { medirRequisicoes } from './metricas-http';

test('agrupa IDs por template e caminhos desconhecidos em uma unica rota', async (t) => {
  const aplicacao = express();
  aplicacao.use(medirRequisicoes);
  aplicacao.get('/produtos/:id', (_requisicao, resposta) => resposta.sendStatus(200));
  aplicacao.get('/pedidos/:id', (_requisicao, resposta) => resposta.sendStatus(200));

  const servidor = aplicacao.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolver, rejeitar) => {
    servidor.close((erro) => erro ? rejeitar(erro) : resolver());
    servidor.closeAllConnections();
  }));
  await once(servidor, 'listening');
  const endereco = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

  for (const caminho of [
    '/produtos/1?cliente_id=123',
    '/produtos/2',
    '/pedidos/10',
    '/pedidos/11',
    '/inexistente/10',
    '/outra/11',
  ]) {
    const resposta = await fetch(endereco + caminho);
    assert.equal(resposta.status, caminho.startsWith('/produtos/') ||
      caminho.startsWith('/pedidos/') ? 200 : 404);
    await resposta.text();
  }

  const metrica = await registro.getSingleMetric('http_request_duration_seconds')!.get();
  const contagens = metrica.values.filter((valor) =>
    'metricName' in valor && valor.metricName === 'http_request_duration_seconds_count'
  );
  assert.deepEqual(contagens.map(({ labels, value }) => ({ route: labels.route, value })), [
    { route: '/produtos/:id', value: 2 },
    { route: '/pedidos/:id', value: 2 },
    { route: 'nao_encontrada', value: 2 },
  ]);
});