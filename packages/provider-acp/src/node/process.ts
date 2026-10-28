import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { throwIfAgentOperationAborted } from '@agen-ai/agent-runtime';
import type { AcpConnectionFactoryContext, AcpConnectionLease } from '../contracts.js';
import { AcpProviderConnectionError } from '../connection/errors.js';
import type { ResolvedNodeAcpLaunch } from './launch.js';

export async function spawnAcpProcess(
  launch: ResolvedNodeAcpLaunch,
  context: AcpConnectionFactoryContext,
): Promise<AcpConnectionLease> {
  throwIfAgentOperationAborted(context.signal);
  const child = spawn(launch.executable, [...launch.args], {
    cwd: launch.cwd,
    env: { ...launch.env },
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Startup rejects through onSpawnError below; errors stay observed until cleanup closes the child.
  const onError = () => {};
  child.on('error', onError);
  let closed = false;
  child.once('close', () => {
    child.off('error', onError);
    closed = true;
  });
  const pid = child.pid;
  let groupGone = pid === undefined;
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (groupGone) return false;
    try { process.kill(-pid!, signal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      // Once absent, the numeric group ID no longer grants authority over a later reuse.
      groupGone = true;
      return false;
    }
  };
  const signalAndWait = async (initialSignal: NodeJS.Signals): Promise<boolean> => {
    let nextSignal: NodeJS.Signals | 0 = initialSignal;
    let pendingSignalError: Error | undefined;
    const deadline = performance.now() + launch.shutdownTimeoutMs;
    for (;;) {
      try {
        // Retire an absent group even while a detached descendant keeps a pipe open.
        if (!signalGroup(nextSignal) && closed) return true;
      } catch (error) {
        if (closed || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error;
        // A Darwin zombie can reject signals before reaping; cleanup still requires close and ESRCH.
        pendingSignalError = error;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        if (pendingSignalError) throw pendingSignalError;
        return false;
      }
      nextSignal = 0;
      await delay(Math.min(10, remaining));
    }
  };
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (!releasePromise) releasePromise = Promise.resolve().then(async () => {
      try {
        if (!child.stdin.destroyed) child.stdin.end();
        if (await signalAndWait('SIGTERM')) return;
        if (!await signalAndWait('SIGKILL')) throw new AcpProviderConnectionError(
          'acp_provider_process_shutdown_timeout', 'The owned ACP process group and streams did not close after termination.',
        );
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }).catch((error) => { releasePromise = undefined; throw error; });
    return releasePromise;
  };
  let onAbort: (() => void) | undefined;
  let onSpawn: (() => void) | undefined;
  let onSpawnError: ((error: Error) => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onSpawn = resolve;
      onSpawnError = reject;
      onAbort = () => reject(context.signal?.reason ?? new DOMException('ACP process startup was aborted.', 'AbortError'));
      child.once('spawn', onSpawn);
      child.once('error', onSpawnError);
      context.signal?.addEventListener('abort', onAbort, { once: true });
      if (context.signal?.aborted) onAbort();
    });
    throwIfAgentOperationAborted(context.signal);
    return Object.freeze({ ownership: 'owned', stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, release });
  } catch (cause) {
    try { await release(); } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], 'ACP process startup and cleanup failed.');
    }
    throw cause;
  } finally {
    if (onSpawn) child.off('spawn', onSpawn);
    if (onSpawnError) child.off('error', onSpawnError);
    if (onAbort) context.signal?.removeEventListener('abort', onAbort);
  }
}
