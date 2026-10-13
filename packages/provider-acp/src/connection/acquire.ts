import { throwIfAgentOperationAborted } from '@agen-ai/agent-runtime';
import type { AcpConnectionFactory, AcpConnectionFactoryContext, AcpConnectionLease } from '../contracts.js';

export async function releaseOwnedLease(lease: AcpConnectionLease): Promise<void> {
  if (lease?.ownership === 'owned' && typeof lease.release === 'function') await lease.release();
}

export async function acquireAcpLease(
  factory: AcpConnectionFactory,
  context: AcpConnectionFactoryContext & { readonly signal: AbortSignal },
): Promise<AcpConnectionLease> {
  throwIfAgentOperationAborted(context.signal);
  const acquisition = Promise.resolve().then(() => factory(context));
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      acquisition,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(context.signal.reason);
        context.signal.addEventListener('abort', onAbort, { once: true });
        if (context.signal.aborted) onAbort();
      }),
    ]);
  } catch (cause) {
    if (context.signal.aborted) {
      // An uncooperative factory still owns acquisition; dispose any lease it eventually delivers.
      void acquisition.then(releaseOwnedLease).catch(() => undefined);
    }
    throw cause;
  } finally {
    if (onAbort) context.signal.removeEventListener('abort', onAbort);
  }
}
