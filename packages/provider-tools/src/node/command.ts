// ------------------------------------------------------------------------------------------------
//                command.ts - One approved command in fresh Bubblewrap namespaces with a confirmed join
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { NodeProviderToolsError } from '../errors.js';
import { assertExecutableUnchanged, type VerifiedExecutable } from './identity.js';
import { boundedCollector, commandArguments, namespaceSettlement, readNamespaceInit } from './namespace.js';

export interface CommandResult {
  readonly reason: 'exited' | 'timeout' | 'canceled' | 'spawn_failed';
  /** Whether bwrap may have created a namespace; only a clean close without a report proves it did not. */
  readonly started: boolean;
  /** Whether the namespace, including every descendant, is confirmed gone. */
  readonly joined: boolean;
  /** The command's fresh PID namespace inode as reported by bwrap, for independent survivor checks. */
  readonly pidNamespace: number | null;
  /** The retained obligation of an unjoined namespace; it rejects until the namespace is proven gone. */
  readonly unsettled: (() => Promise<void>) | undefined;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface CommandInput {
  readonly bubblewrap: VerifiedExecutable;
  readonly workspace: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly outputBytes: number;
  readonly signal: AbortSignal;
}

/**
 * Resolves only after the namespace init is confirmed gone, or after the bounded join fails. Timeout
 * and cancellation kill bwrap, whose die-with-parent chain kills the init and with it the namespace;
 * after bwrap closes, a still-current init is killed directly before the join.
 */
export async function runCommand(input: CommandInput): Promise<CommandResult> {
  await assertExecutableUnchanged(input.bubblewrap);
  const started = Date.now();
  const output = boundedCollector(input.outputBytes);
  const errors = boundedCollector(input.outputBytes);
  return new Promise((resolve) => {
    const child = spawn(input.bubblewrap.path, commandArguments(input.workspace, input.command), {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: {}, cwd: '/',
    });
    const init = readNamespaceInit(child.stdio[3] as Readable);
    let reason: CommandResult['reason'] = 'exited';
    const stop = (why: CommandResult['reason']) => {
      if (reason !== 'exited') return;
      reason = why;
      child.kill('SIGKILL');
    };
    child.stdout?.on('data', (chunk: Buffer) => output.add(chunk));
    child.stderr?.on('data', (chunk: Buffer) => errors.add(chunk));
    const timer = setTimeout(() => stop('timeout'), input.timeoutMs);
    const abort = () => stop('canceled');
    if (input.signal.aborted) abort();
    else input.signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => stop('spawn_failed'));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      void init.then(async (observed) => {
        const settle = namespaceSettlement(observed, () => new NodeProviderToolsError('namespace_unavailable', 'A command namespace remains unjoined.'));
        const joined = await settle().then(() => true, () => false);
        resolve(Object.freeze({
          reason, started: observed.kind !== 'not_started', joined, pidNamespace: observed.kind === 'not_started' ? null : observed.pidNamespace,
          unsettled: joined ? undefined : settle, exitCode: code, signal, durationMs: Date.now() - started,
          stdout: output.text(), stderr: errors.text(), truncated: output.truncated || errors.truncated,
        }));
      });
    });
  });
}
