// ------------------------------------------------------------------------------------------------
//                helper.ts - Verified filesystem-helper launch, readiness and joined shutdown
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createNodeFilesystemHelperClient, type NodeFilesystemHelperClient } from '@agen-ai/sandbox-docker/node';
import { NodeProviderCleanupError, NodeProviderToolsError } from '../errors.js';
import { assertExecutableUnchanged, type VerifiedExecutable } from './identity.js';
import { boundedCollector, helperArguments, namespaceSettlement, readNamespaceInit } from './namespace.js';

const HELPER_LEASE_MS = 30_000;
const HELPER_LIMITS = Object.freeze({ readyTimeoutMs: 10_000, responseTimeoutMs: 10_000, heartbeatMs: 5_000 });
const EXIT_WAIT_MS = 5_000;

export interface HelperProcess {
  readonly client: NodeFilesystemHelperClient;
  readonly pidNamespace: number | null;
  /** Exact close receipt, exit 0 and a joined namespace; after a failure each retry kills and re-joins. */
  close(): Promise<void>;
}

export interface HelperInput {
  readonly bubblewrap: VerifiedExecutable;
  readonly helper: VerifiedExecutable;
  readonly storeDirectory: string;
  readonly uid: number;
  readonly gid: number;
}

/** A launch that never becomes ready rejects with a `NodeProviderCleanupError` while its namespace is unproven. */
export async function startHelper(input: HelperInput): Promise<HelperProcess> {
  await assertExecutableUnchanged(input.bubblewrap);
  await assertExecutableUnchanged(input.helper);
  const child = spawn(input.bubblewrap.path, helperArguments(input.helper.path, input.storeDirectory, HELPER_LEASE_MS), {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: {}, cwd: '/',
  });
  const stderr = boundedCollector(4_096);
  child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk));
  child.stdin?.on('error', () => {});
  const exited = new Promise<Readonly<{ code: number | null; signal: string | null }>>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  const reported = readNamespaceInit(child.stdio[3] as Readable);
  let client: NodeFilesystemHelperClient;
  let ready = false;
  let settle: (() => Promise<void>) | undefined;
  const settlement = async () => {
    const observed = await reported;
    settle ??= namespaceSettlement(ready && observed.kind === 'not_started' ? { kind: 'unidentified', pid: null, pidNamespace: null } : observed,
      () => new NodeProviderToolsError('helper_unavailable', 'The filesystem helper namespace did not settle after termination.'));
    return settle;
  };
  const terminate = async () => {
    child.kill('SIGKILL');
    await exited;
    await (await settlement())();
  };
  let pidNamespace: number | null = null;
  try {
    client = createNodeFilesystemHelperClient({ input: child.stdin!, output: child.stdout!, user: { uid: input.uid, gid: input.gid }, limits: HELPER_LIMITS });
    await Promise.race([client.ready, exited.then(() => { throw new Error('The filesystem helper exited before readiness.'); })]);
    ready = true;
    const observed = await reported;
    if (observed.kind !== 'running' && observed.kind !== 'reaped') throw new Error('The filesystem helper namespace could not be identified.');
    pidNamespace = observed.pidNamespace;
  } catch (cause) {
    const failure = new NodeProviderToolsError('helper_unavailable', `The filesystem helper was not ready${stderr.bytes ? `: ${stderr.text().trim().slice(0, 400)}` : '.'}`, { cause });
    await terminate().catch((cleanupError: unknown) => {
      throw new NodeProviderCleanupError({ message: 'The filesystem helper was not ready and its namespace is still owned.', cause: failure, cleanupError, retryCleanup: terminate });
    });
    throw failure;
  }
  let closed = false;
  let attempted = false;
  return Object.freeze({
    client,
    pidNamespace,
    async close() {
      if (closed) return;
      if (attempted) { await terminate(); closed = true; return; }
      attempted = true;
      const receipt = await client.close();
      const timer = setTimeout(() => child.kill('SIGKILL'), EXIT_WAIT_MS);
      const exit = await exited.finally(() => clearTimeout(timer));
      const joined = await (await settlement())().then(() => true, () => false);
      if (receipt.kind !== 'closed' || exit.code !== 0 || !joined) {
        if (!joined) throw new NodeProviderToolsError('helper_unavailable', 'The filesystem helper namespace did not settle after close.');
        throw new NodeProviderToolsError('helper_unavailable', `The filesystem helper did not close cleanly (exit ${exit.code ?? exit.signal}).`,
          receipt.kind === 'failed' ? { cause: receipt.error } : undefined);
      }
      closed = true;
    },
  });
}
