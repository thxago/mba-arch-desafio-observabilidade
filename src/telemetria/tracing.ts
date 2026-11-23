import { SpanStatusCode, trace } from '@opentelemetry/api';
import { log, type CamposDoLog } from './log';

export const tracer = trace.getTracer('loja-pedidos');

export function registrarErro(erro: unknown, mensagem: string, campos?: CamposDoLog): void {
  const motivo = erro instanceof Error ? erro.message : String(erro);
  const span = trace.getActiveSpan();
  span?.recordException(erro instanceof Error ? erro : motivo);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: motivo });
  log.error(mensagem + ': ' + motivo, campos);
}