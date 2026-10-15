import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { parseAgentInstanceId } from '@agen-ai/agent-protocol';
import { AgentProviderRegistryError, createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import type { AcpConnectionStreams } from '@agen-ai/provider-acp';
import {
  createNodeAcpProviderDriver, isNodeAcpExecutionCleanupError, NodeAcpExecutionCleanupError,
  type NodeAcpExecutionBoundary,
} from '@agen-ai/provider-acp/node';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

/** Installed exports and registry wrapping are the contract here; no native work is started. */
export async function proveRegistryStartupCleanup(executable: string, cwd: string) {
  const startup = deferred<AcpConnectionStreams>();
  const release = deferred<void>();
  const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  let reservations = 0;
  let starts = 0;
  let releases = 0;
  let joins = 0;
  let startupSignal: AbortSignal | undefined;
  let cleanup: NodeAcpExecutionCleanupError | undefined;
  const instanceId = parseAgentInstanceId('packed-node-startup-cleanup');
  const boundary: NodeAcpExecutionBoundary = {
    reserve() {
      reservations += 1;
      return {
        start(context) { starts += 1; startupSignal = context.signal; return startup.promise; },
        release() {
          releases += 1;
          return release.promise.then(() => {
            streams.stdin.destroy(); streams.stdout.destroy(); streams.stderr.destroy(); joins += 1;
          });
        },
      };
    },
  };
  const driver = createNodeAcpProviderDriver({
    providerKey: 'packed-node-startup-cleanup', executionBoundary: boundary,
    sessionInteractions: { mapping: 'grok-folder-trust-v1' },
    launch: { executable, args: ['agent', '--no-leader', 'stdio'], cwd, shutdownTimeoutMs: 100 },
    limits: { initializationTimeoutMs: 20 },
  });
  try {
    const materialization = createAgentProviderRegistry({ drivers: [driver],
      definitions: [{ instanceId, providerKey: driver.providerKey, driverConfiguration: {} }],
    });
    await assert.rejects(materialization, (error: unknown) => {
      assert.ok(error instanceof AgentProviderRegistryError);
      assert.equal(error.code, 'instance_materialization_failed');
      assert.equal(error.instanceId, instanceId);
      assert.ok(isNodeAcpExecutionCleanupError(error.cause));
      assert.ok(error.cause instanceof NodeAcpExecutionCleanupError);
      cleanup = error.cause;
      assert.ok(cleanup.cause instanceof Error);
      assert.ok(cleanup.cleanupError instanceof Error);
      return true;
    });
    assert.ok(cleanup);
    assert.equal(startupSignal?.aborted, true);
    assert.deepEqual([reservations, starts, releases, joins], [1, 1, 1, 0]);
    const retryCleanup = cleanup.retryCleanup;
    let retrySettled = false;
    const retry = retryCleanup().then(() => { retrySettled = true; });
    await delay(0);
    assert.equal(retrySettled, false, 'Retry must retain the genuinely pending acquisition and release.');
    startup.resolve(streams);
    await delay(0);
    assert.equal(retrySettled, false, 'A late startup result cannot bypass the pending release.');
    assert.deepEqual([reservations, starts, releases, joins], [1, 1, 1, 0]);
    release.resolve();
    await retry;
    await retryCleanup();
    assert.deepEqual([reservations, starts, releases, joins], [1, 1, 1, 1]);
    assert.ok(streams.stdin.destroyed && streams.stdout.destroyed && streams.stderr.destroyed);
    return { scenario: 'registry-startup-cleanup', cause: 'NodeAcpExecutionCleanupError',
      pendingStartupRetained: true, pendingReleaseRetained: true, reservations, starts, releases, joins, nativeStarts: 0, cleanup: 'joined' };
  } finally {
    startup.resolve(streams);
    release.resolve();
    try { await cleanup?.retryCleanup(); }
    finally { streams.stdin.destroy(); streams.stdout.destroy(); streams.stderr.destroy(); }
  }
}
