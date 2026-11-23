import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { propagation, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';
import { criarRotas } from '../api/rotas';
import { consumirPedido, publicarPedido } from '../fila/fila';
import { decidirStatusDoPedido } from '../worker/conciliacao';
import { log } from './log';
import { registrarErro, tracer } from './tracing';

const exportador = new InMemorySpanExporter();
const sdk = new NodeSDK({
  spanProcessors: [new SimpleSpanProcessor(exportador)],
});
sdk.start();
after(() => sdk.shutdown());

test('transporta o contexto W3C pela mensagem sem alterar os dados do pedido', async () => {
  let conteudo = '';
  const redis = {
    lpush: mock.fn(async (_fila: string, valor: string) => {
      conteudo = valor;
      return 1;
    }),
    brpop: mock.fn(async () => ['pedidos', conteudo]),
  } as unknown as Redis;
  const pedido = { pedido_id: 17, cliente_id: 'teste-1', valor_total: 10 };

  await tracer.startActiveSpan('pedido.criar', async (span) => {
    try {
      await publicarPedido(redis, pedido);
      const mensagem = await consumirPedido(redis);
      assert.ok(mensagem);
      assert.deepEqual({
        pedido_id: mensagem.pedido_id,
        cliente_id: mensagem.cliente_id,
        valor_total: mensagem.valor_total,
      }, pedido);
      const contexto = propagation.extract(ROOT_CONTEXT, mensagem);
      assert.equal(trace.getSpanContext(contexto)?.traceId, span.spanContext().traceId);
      assert.equal(trace.getSpanContext(contexto)?.spanId, span.spanContext().spanId);
      assert.equal('traceparent' in pedido, false);
    } finally {
      span.end();
    }
  });
});

test('marca a falha capturada na cobranca sem corrigir a confirmacao legada', async (t) => {
  const erros = t.mock.method(log, 'error', () => {});
  await tracer.startActiveSpan('pedido.processar', async (span) => {
    try {
      assert.equal(await decidirStatusDoPedido('teste-7', 10), 'confirmado');
    } finally {
      span.end();
    }
    const finalizado = exportador.getFinishedSpans().find((item) =>
      item.spanContext().spanId === span.spanContext().spanId
    )!;
    assert.equal(finalizado.status.code, SpanStatusCode.ERROR);
    assert.equal(finalizado.events[0].name, 'exception');
    assert.equal(finalizado.events[0].attributes?.['exception.message'],
      'gateway respondeu de forma inesperada');
  });
  assert.match(erros.mock.calls[0].arguments[0] ?? '', /gateway respondeu de forma inesperada/);
});

test('relanca o erro do handler async e encerra o span sem responder 500', async (t) => {
  t.mock.method(log, 'error', () => {});
  const rotas = criarRotas({} as Redis);
  const camada = rotas.stack.find((item: { route?: { path: string } }) =>
    item.route?.path === '/pedidos'
  );
  assert.ok(camada?.route);
  const handler = camada.route.stack[0].handle;
  const responder = mock.fn();
  await assert.rejects(async () => handler(
    { body: { cliente_id: 'teste', itens: [null] } } as Request,
    { status: responder } as unknown as Response,
    mock.fn()
  ), TypeError);
  assert.equal(responder.mock.callCount(), 0);
  const span = exportador.getFinishedSpans().filter((item) =>
    item.name === 'pedido.criar'
  ).at(-1)!;
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.events[0].name, 'exception');
});

test('registra motivo mesmo sem span e quando a excecao nao e um Error', (t) => {
  const erros = t.mock.method(log, 'error', () => {});
  registrarErro('falha externa', 'erro ao iniciar');
  assert.equal(erros.mock.calls[0].arguments[0], 'erro ao iniciar: falha externa');
});