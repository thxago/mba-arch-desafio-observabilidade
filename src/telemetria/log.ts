import { trace } from '@opentelemetry/api';
import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';
type CamposDoLog = { pedido_id?: number };

function escrever(level: Nivel, msg: string, campos?: CamposDoLog): void {
  const contexto = trace.getActiveSpan()?.spanContext();
  const linha = {
    timestamp: new Date().toISOString(),
    level,
    service: NOME_DO_SERVICO,
    msg,
    trace_id: contexto?.traceId ?? '',
    span_id: contexto?.spanId ?? '',
    ...campos,
  };

  process.stdout.write(JSON.stringify(linha) + '\n');
}

export const log = {
  info(msg: string, campos?: CamposDoLog): void {
    escrever('info', msg, campos);
  },
  warn(msg: string, campos?: CamposDoLog): void {
    escrever('warn', msg, campos);
  },
  error(msg: string, campos?: CamposDoLog): void {
    escrever('error', msg, campos);
  },
};