import { context, propagation } from '@opentelemetry/api';
import Redis from 'ioredis';

export const NOME_DA_FILA = 'pedidos';

export type MensagemPedido = {
  pedido_id: number;
  cliente_id: string;
  valor_total: number;
};

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function criarConexaoRedis(): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export async function publicarPedido(
  redis: Redis,
  mensagem: MensagemPedido
): Promise<void> {
  const contextoDeTrace: Record<string, string> = {};
  propagation.inject(context.active(), contextoDeTrace);
  await redis.lpush(NOME_DA_FILA, JSON.stringify({ ...mensagem, ...contextoDeTrace }));
}

export async function consumirPedido(
  redis: Redis,
  segundosDeEspera = 5
): Promise<Record<string, unknown> | null> {
  const resposta = await redis.brpop(NOME_DA_FILA, segundosDeEspera);

  if (!resposta) {
    return null;
  }

  return JSON.parse(resposta[1]) as Record<string, unknown>;
}