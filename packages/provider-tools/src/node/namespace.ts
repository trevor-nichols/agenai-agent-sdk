// ------------------------------------------------------------------------------------------------
//                namespace.ts - Bubblewrap arguments, namespace-init observation and descendant joins
// ------------------------------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const USR_LINKS = [['usr/bin', '/bin'], ['usr/lib', '/lib'], ['usr/lib64', '/lib64'], ['usr/sbin', '/sbin']] as const;
export const COMMAND_SYSTEM_ROOT = '/usr';
/** Private stores and state must not overlap any command-visible system path. */
export const COMMAND_SYSTEM_PATHS = [COMMAND_SYSTEM_ROOT, ...USR_LINKS.map(([, link]) => link)];
const INFO_BYTES = 1_024;
const JOIN_POLL_MS = 5;
export const JOIN_LIMIT_MS = 5_000;

/**
 * Only the workspace is writable; /usr is read-only; every namespace including the network is new;
 * the environment is replaced. The store, staging, controller state, credentials and sockets stay outside.
 */
export function commandArguments(workspace: string, command: string): readonly string[] {
  return ['--unshare-all', '--unshare-user', '--unshare-pid', '--unshare-net', '--disable-userns', '--die-with-parent', '--new-session',
    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    '--ro-bind', COMMAND_SYSTEM_ROOT, COMMAND_SYSTEM_ROOT, ...USR_LINKS.flatMap(([target, link]) => ['--symlink', target, link]),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', workspace, workspace, '--chdir', workspace,
    '--info-fd', '3', '--', '/usr/bin/bash', '-c', command];
}

/** The helper sees only the store at /store and its own read-only executable. */
export function helperArguments(helper: string, store: string, leaseMs: number): readonly string[] {
  return ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', helper, '/agenai-sandbox-files', '--bind', store, '/store', '--proc', '/proc', '--info-fd', '3',
    '--', '/agenai-sandbox-files', '/store', 'read_write', String(leaseMs)];
}

/**
 * What bwrap's info channel established. `not_started`: it closed cleanly without a report, so no
 * namespace exists. `reaped`: the reported init was already confirmed gone. `running`: the init with
 * its start time. `unidentified`: a report, stream or observation that cannot prove either, which
 * is never treated as a join.
 */
export type NamespaceReport =
  | Readonly<{ kind: 'not_started' }>
  | Readonly<{ kind: 'reaped'; pid: number; pidNamespace: number | null }>
  | Readonly<{ kind: 'running'; pid: number; start: string; pidNamespace: number | null }>
  | Readonly<{ kind: 'unidentified'; pid: number | null; pidNamespace: number | null }>;

type Observation = Readonly<{ kind: 'present'; state: string; start: string }> | Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'unknown' }>;

/** Only ENOENT/ESRCH confirm absence; every other failure and every malformed record is unknown. */
async function observe(pid: number): Promise<Observation> {
  let text: string;
  try {
    text = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? { kind: 'absent' } : { kind: 'unknown' };
  }
  const close = text.lastIndexOf(')');
  if (!text.startsWith(`${pid} (`) || close < 0) return { kind: 'unknown' };
  const fields = text.slice(close + 2).trimEnd().split(' ');
  const state = fields[0] ?? '';
  const start = fields[19] ?? '';
  return /^[A-Za-z]$/u.test(state) && /^[0-9]+$/u.test(start) ? { kind: 'present', state, start } : { kind: 'unknown' };
}

/** Reads bwrap's `{"child-pid": N}` info object from fd 3, bounded and strictly parsed. */
export function readNamespaceInit(info: Readable): Promise<NamespaceReport> {
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    let reported = false;
    const finish = (value: NamespaceReport) => { if (!settled) { settled = true; resolve(Object.freeze(value)); } };
    const unidentified = (pid: number | null, pidNamespace: number | null = null) => finish({ kind: 'unidentified', pid, pidNamespace });
    info.setEncoding('utf8');
    info.on('data', (chunk: string) => {
      if (reported) return;
      text += chunk;
      if (text.length > INFO_BYTES) { info.destroy(); unidentified(null); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return; }
      const fields = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      const pid = fields['child-pid'];
      const namespace = fields['pid-namespace'];
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2) { unidentified(null); return; }
      reported = true;
      const pidNamespace = typeof namespace === 'number' && Number.isSafeInteger(namespace) ? namespace : null;
      void observe(pid).then((observed) => {
        if (observed.kind === 'present') finish({ kind: 'running', pid, start: observed.start, pidNamespace });
        else if (observed.kind === 'absent') finish({ kind: 'reaped', pid, pidNamespace });
        else unidentified(pid, pidNamespace);
      });
    });
    info.on('error', () => { if (!reported) unidentified(null); });
    info.on('close', () => { if (!reported) finish(text === '' ? { kind: 'not_started' } : { kind: 'unidentified', pid: null, pidNamespace: null }); });
  });
}

/** Whether one observation proves the reported init gone: absent, reused by another process, or a zombie. */
function gone(report: NamespaceReport, observed: Observation): boolean {
  if (observed.kind === 'absent') return true;
  if (observed.kind === 'unknown' || report.kind !== 'running') return false;
  return observed.start !== report.start || observed.state === 'Z' || observed.state === 'X';
}

/**
 * Resolves true once the namespace init is proven gone. The kernel kills and reaps every other process
 * of a PID namespace before its init exits, so this join covers all descendants. Unknown observations
 * keep polling and the bounded join then fails; an init without a pid can never be joined.
 */
export async function joinNamespace(report: NamespaceReport, limitMs = JOIN_LIMIT_MS): Promise<boolean> {
  if (report.kind === 'not_started' || report.kind === 'reaped') return true;
  if (report.pid === null) return false;
  const deadline = Date.now() + limitMs;
  while (true) {
    if (gone(report, await observe(report.pid))) return true;
    if (Date.now() >= deadline) return false;
    await delay(JOIN_POLL_MS);
  }
}

/** Kills an init only when its start time proves it is still the reported process, then re-joins it. */
export async function terminateNamespace(report: NamespaceReport): Promise<boolean> {
  if (report.kind === 'running') {
    const observed = await observe(report.pid);
    if (observed.kind === 'present' && observed.start === report.start) {
      try { process.kill(report.pid, 'SIGKILL'); } catch { /* already gone or no longer ours */ }
    }
  }
  return joinNamespace(report);
}

/**
 * The retained obligation for one namespace: single-flight, idempotent once proven, and rejecting with
 * `failure()` for as long as the namespace cannot be proven gone.
 */
export function namespaceSettlement(report: NamespaceReport, failure: () => Error): () => Promise<void> {
  let settled = report.kind === 'not_started' || report.kind === 'reaped';
  let pending: Promise<void> | undefined;
  return () => {
    if (settled) return Promise.resolve();
    pending ??= terminateNamespace(report).then((joined) => {
      if (!joined) throw failure();
      settled = true;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

/** Keeps at most `limit` bytes from a stream and records whether more arrived. */
export function boundedCollector(limit: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    add(chunk: Buffer) {
      const room = limit - bytes;
      if (chunk.byteLength > room) truncated = true;
      if (room <= 0) return;
      const part = chunk.subarray(0, room);
      chunks.push(part);
      bytes += part.byteLength;
    },
    get truncated() { return truncated; },
    get bytes() { return bytes; },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}
