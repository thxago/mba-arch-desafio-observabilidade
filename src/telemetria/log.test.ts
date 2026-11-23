import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { context, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { CONTEXTO_DO_PEDIDO, log } from './log';

const sdk = new NodeSDK({
  spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
});
sdk.start();
after(() => sdk.shutdown());

const tracer = trace.getTracer('log-test');

function capturarLinha(escrever: () => void): Record<string, unknown> {
  let linha = '';
  const escrita = mock.method(process.stdout, 'write', (texto: string | Uint8Array) => {
    linha += texto.toString();
    return true;
  });

  try {
    escrever();
  } finally {
    escrita.mock.restore();
  }

  return JSON.parse(linha);
}

test('mantem os campos de correlacao vazios sem span ativo em todos os niveis', () => {
  for (const nivel of ['info', 'warn', 'error'] as const) {
    const linha = capturarLinha(() => log[nivel]('sem span'));
    assert.equal(linha.trace_id, '');
    assert.equal(linha.span_id, '');
    assert.equal(linha.level, nivel);
    assert.equal(linha.msg, 'sem span');
    assert.equal(typeof linha.timestamp, 'string');
    assert.equal(typeof linha.service, 'string');
  }
});

test('usa o span ativo de cada operacao concorrente e preserva o pedido', async () => {
  const contextos = await Promise.all([1, 2].map((pedidoId) =>
    tracer.startActiveSpan('pedido', async (span) => {
      try {
        await new Promise<void>((resolver) => setImmediate(resolver));
        const linha = capturarLinha(() => log.info('pedido criado', { pedido_id: pedidoId }));
        assert.equal(linha.trace_id, span.spanContext().traceId);
        assert.equal(linha.span_id, span.spanContext().spanId);
        assert.equal(linha.pedido_id, pedidoId);
        return span.spanContext();
      } finally {
        span.end();
      }
    })
  ));

  assert.notEqual(contextos[0].traceId, contextos[1].traceId);
  const linha = capturarLinha(() => log.info('operacoes encerradas'));
  assert.equal(linha.trace_id, '');
  assert.equal(linha.span_id, '');
});

test('inclui o pedido do contexto nas camadas internas sem vazar para fora', () => {
  context.with(context.active().setValue(CONTEXTO_DO_PEDIDO, 17), () => {
    const linha = capturarLinha(() => log.error('falha na cobranca'));
    assert.equal(linha.pedido_id, 17);
  });

  const linha = capturarLinha(() => log.info('fora do pedido'));
  assert.equal(linha.pedido_id, undefined);
});