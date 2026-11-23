import { cobrancasProcessadas } from '../telemetria/metricas';
import { registrarErro } from '../telemetria/tracing';
import { processarPagamento } from './pagamento';
import { registrarFalhaLegado } from './registro-legado';

export type StatusDoPedido = 'confirmado' | 'recusado';

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