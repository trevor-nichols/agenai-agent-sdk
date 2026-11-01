// ------------------------------------------------------------------------------------------------
//                desktopHostObservation.ts - Pinned prepared Darwin observation and joined execution
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '@agen-ai/sandbox';
import type { DockerDesktopRouteAuthorityIdentity } from '../network/desktopAuthority.js';
import { parseDesktopHostObservation } from '../network/desktop/observation/host.js';
import type { DesktopHostAuthorityObservation } from '../network/desktop/observation/host.js';
import type { DesktopObservationByteBudget } from '../network/desktop/observation/budget.js';
import { runPreparedRouteObserver } from './command.js';
import { openPreparedExecutable } from './preparedExecutable.js';

export async function readDesktopHostObservation(identity: DockerDesktopRouteAuthorityIdentity, signal?: AbortSignal,
  budget?: DesktopObservationByteBudget): Promise<DesktopHostAuthorityObservation> {
  const executable = identity.hostObserver.executable;
  signal?.throwIfAborted();
  const prepared = await openPreparedExecutable(executable, signal);
  try {
    const before = prepared.identity;
    const output = await runPreparedRouteObserver(executable.path, identity, signal);
    budget?.consume(output.stdout.byteLength + output.stderr.byteLength);
    await prepared.verify(signal);
    if (output.stderr.length !== 0) throw new SandboxOperationError('driver_failure', 'Desktop host observer emitted a failure diagnostic.');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.stdout));
    return Object.freeze({ ...parseDesktopHostObservation(value), executableIdentity: before });
  } finally { await prepared.close(); }
}
