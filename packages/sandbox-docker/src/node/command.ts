// ------------------------------------------------------------------------------------------------
//                command.ts - Pinned executable descriptor, bounded output and joined process groups
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxOperationError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { DockerLinuxRouteAuthorityIdentity } from '../network/routeAuthority.js';

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error; }
}

export async function readIpJson(identity: DockerLinuxRouteAuthorityIdentity, args: readonly string[], signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const descriptor = await open(identity.ipExecutable.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await descriptor.stat({ bigint: true });
    if (!before.isFile() || before.size > 32n * 1024n ** 2n || (before.mode & 0o111n) === 0n
      || await realpath(identity.ipExecutable.path) !== identity.ipExecutable.path) throw new SandboxUnsupportedError('Route observer must be an exact canonical regular executable.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const read = await descriptor.read(buffer, 0, buffer.length, position);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
      if (position > 32 * 1024 ** 2) throw new SandboxUnsupportedError('Route observer executable exceeds its artifact bound.');
      signal?.throwIfAborted();
    }
    const after = await descriptor.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || hash.digest('hex') !== identity.ipExecutable.sha256) throw new SandboxUnsupportedError('Route observer executable identity changed or its digest differs.');
    signal?.throwIfAborted();
    const output = await executeObserver({ kind: 'linux_descriptor', fd: descriptor.fd, args }, identity, signal);
    const settled = await descriptor.stat({ bigint: true });
    if (after.size !== settled.size || after.mtimeNs !== settled.mtimeNs || after.ctimeNs !== settled.ctimeNs) throw new SandboxUnsupportedError('Route observer executable changed during observation.');
    return JSON.parse(output.stdout.toString('utf8'));
  } finally { await descriptor.close(); }
}

interface ObserverOutput { readonly stdout: Buffer; readonly stderr: Buffer }
type ObserverLaunch = Readonly<{ kind: 'linux_descriptor'; fd: number; args: readonly string[] }>
  | Readonly<{ kind: 'prepared_path'; executable: string }>;
type ObserverLimits = Pick<DockerLinuxRouteAuthorityIdentity, 'commandTimeoutMs' | 'maxOutputBytes'>;

/** The Darwin launch is a verified path under caller-owned executable/ancestor quiescence. */
export function runPreparedRouteObserver(executable: string, limits: ObserverLimits, signal?: AbortSignal): Promise<ObserverOutput> {
  signal?.throwIfAborted();
  return executeObserver({ kind: 'prepared_path', executable }, limits, signal);
}

async function executeObserver(launch: ObserverLaunch, identity: ObserverLimits, signal?: AbortSignal): Promise<ObserverOutput> {
  return new Promise<ObserverOutput>((resolve, reject) => {
    const child = launch.kind === 'linux_descriptor'
      ? spawn('/proc/self/fd/3', [...launch.args], { detached: true, env: { LANG: 'C', LC_ALL: 'C', PATH: '/nonexistent' },
        stdio: ['ignore', 'pipe', 'pipe', launch.fd] })
      : spawn(launch.executable, [], { detached: true, cwd: '/', env: { LANG: 'C', LC_ALL: 'C', PATH: '/nonexistent' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: unknown;
    const chunks: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    let bytes = 0;
    const fail = (cause: unknown) => {
      failure ??= cause;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failure = error; }
      }
    };
    const receive = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > identity.maxOutputBytes) fail(new SandboxOperationError('output_limit', 'Route observation exceeded its output bound.'));
      else if (stdout) chunks.push(chunk);
      else diagnostics.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => receive(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => receive(chunk, false));
    child.stdout?.on('error', fail);
    child.stderr?.on('error', fail);
    child.once('error', fail);
    child.once('exit', (code) => {
      if (code !== 0) fail(new SandboxOperationError('driver_failure', 'Route observer exited unsuccessfully.'));
      else if (child.pid && groupExists(child.pid)) fail(new SandboxOperationError('driver_failure', 'Route observer left an active process group.'));
    });
    const timeout = setTimeout(() => fail(new SandboxOperationError('deadline_exceeded', 'Route observation exceeded its command deadline.')), identity.commandTimeoutMs);
    const abort = () => fail(new SandboxOperationError('cancelled', 'Route observation was cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // Pipe closure can be delayed by a misbehaving descendant; never discard ownership silently.
    const finalTimeout = setTimeout(() => {
      fail(new SandboxOperationError('driver_failure', 'Route observer output ownership did not settle.'));
      child.stdout?.destroy(); child.stderr?.destroy();
    }, identity.commandTimeoutMs + 2500);
    child.once('close', () => { void (async () => {
      clearTimeout(timeout); clearTimeout(finalTimeout); signal?.removeEventListener('abort', abort);
      if (child.pid) {
        const deadline = Date.now() + 2500;
        while (groupExists(child.pid) && Date.now() < deadline) await delay(20);
        if (groupExists(child.pid)) failure ??= new SandboxOperationError('driver_failure', 'Route observer process-group quiescence remains uncertain.');
      }
      if (failure !== undefined) reject(failure);
      else resolve({ stdout: Buffer.concat(chunks), stderr: Buffer.concat(diagnostics) });
    })().catch(reject); });
  });
}
