// ------------------------------------------------------------------------------------------------
//                withSandbox.ts - Scoped sandbox execution - Public ownership and bounded waits
// ------------------------------------------------------------------------------------------------

import type { SandboxBackend, SandboxRunOptions, Sandbox } from './contracts.js';
import type { SandboxRequestInput } from './policy/types.js';
import { SandboxRunError } from './errors.js';
import { parseSandboxRunOptions } from './internal/operations.js';
import { actualOperation, observe } from './lifecycle/observation.js';
import { parseSandboxRequest } from './policy/parse.js';

export async function withSandbox<T>(backend: SandboxBackend, request: SandboxRequestInput,
  use: (sandbox: Sandbox) => Promise<T>, options: SandboxRunOptions): Promise<T> {
  const parsed = parseSandboxRunOptions(options);
  const admitted = parseSandboxRequest(request);
  if (typeof use !== 'function') throw new TypeError('Sandbox use must be a function.');
  const operation = parsed.signal === undefined ? {} : { signal: parsed.signal };
  const owner = backend.reserve(admitted, parsed.recovery);
  let outcome: { readonly kind: 'returned'; readonly value: T } | { readonly kind: 'threw'; readonly error: unknown };
  try {
    const sandbox = await owner.start(operation);
    operation.signal?.throwIfAborted();
    const actual = actualOperation(() => use(sandbox));
    const execution = admitted.policy.execution;
    const value = await observe(actual, execution.kind === 'deadline' ? execution.timeoutMs : undefined, { ...operation,
      onInterrupt: () => { void owner.stop().catch(() => {}); },
    });
    outcome = { kind: 'returned', value };
  }
  catch (error) { outcome = { kind: 'threw', error }; }
  try { await owner.destroy(); }
  catch (cleanupError) {
    if (outcome.kind === 'threw') throw new SandboxRunError({ primaryError: outcome.error, cleanupError, owner });
    throw cleanupError;
  }
  if (outcome.kind === 'threw') throw outcome.error;
  return outcome.value;
}
