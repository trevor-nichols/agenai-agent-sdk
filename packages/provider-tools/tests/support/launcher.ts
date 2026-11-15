// ------------------------------------------------------------------------------------------------
//                launcher.ts - Executable stand-ins for Bubblewrap and a /proc fault boundary for tests
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { verifyExecutable, type VerifiedExecutable } from '../../src/node/identity.js';

/** Above Linux PID_MAX_LIMIT (2^22) and macOS's maximum, so no real process can carry these ids. */
export const FAKE_PID = 4_194_400;

export interface LauncherScript {
  /** Bytes a command launch writes to its info fd; `null` closes it without a report. */
  readonly info: string | null;
  /** Bytes a helper launch writes to its info fd; defaults to `info`. */
  readonly helperInfo?: string | null;
  /** The identity a helper launch attests in its ready frame. */
  readonly ready?: Readonly<{ uid: number; gid: number }>;
}

const SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const script = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'script.json'), 'utf8'));
const helper = process.argv.includes('/agenai-sandbox-files');
const info = helper && script.helperInfo !== undefined ? script.helperInfo : script.info;
if (info !== null) fs.writeSync(3, info);
fs.closeSync(3);
if (!helper) process.exit(0);
const frame = (kind, body) => {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(kind, 0);
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
};
process.stdout.write(frame(4, { protocol: 'agenai.sandbox.filesystem.v1', layout: 'agenai.sandbox.workspace.v1', ...script.ready }));
let buffered = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 16) {
    const size = 16 + buffered.readUInt32BE(8) + buffered.readUInt32BE(12);
    if (buffered.length < size) return;
    const operation = buffered.readUInt32BE(0);
    buffered = buffered.subarray(size);
    if (operation === 10) process.stdout.write(frame(5));
    if (operation === 9) {
      const closed = frame(3, { status: 'closed', effect: 'none', errno: 0, count: '0', mode: null, entry: null });
      process.stdout.write(closed, () => process.exit(0));
    }
  }
});
`;

export interface FakeLauncher {
  readonly executable: VerifiedExecutable;
  /** Changes what later launches report; the verified executable bytes stay the same. */
  script(script: LauncherScript): Promise<void>;
}

/** Writes an owned executable that reports what bwrap would for the current script and verifies it. */
export async function fakeLauncher(t: TestContext, initial: LauncherScript): Promise<FakeLauncher> {
  const directory = await fs.realpath(await fs.mkdtemp(`${tmpdir()}/provider-tools-launcher-`));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const path = `${directory}/bwrap`;
  const source = `#!${process.execPath}\n${SOURCE}`;
  await fs.writeFile(path, source, { mode: 0o700 });
  const script = (value: LauncherScript) => fs.writeFile(`${directory}/script.json`, JSON.stringify({
    ready: { uid: process.geteuid!(), gid: process.getegid!() }, ...value,
  }));
  await script(initial);
  const executable = await verifyExecutable(path, createHash('sha256').update(source).digest('hex'), 1_048_576, process.geteuid!());
  return { executable, script };
}

export type ProcState = 'running' | 'zombie' | 'gone' | 'unreadable' | 'malformed';

/**
 * Answers `/proc/<pid>/stat` for the listed fake pids as Linux would in each state; every other
 * read reaches the real filesystem. `running` keeps one start time, so it stays the same process.
 */
export function fakeProc(t: TestContext, states: Map<number, ProcState>): void {
  const readFile = fs.readFile;
  const stat = (pid: number, state: string) => `${pid} (bash) ${state} ${Array.from({ length: 18 }, () => '0').join(' ')} 4242 0 0\n`;
  fs.readFile = (async (path: unknown, ...rest: unknown[]) => {
    const pid = typeof path === 'string' ? /^\/proc\/([0-9]+)\/stat$/u.exec(path)?.[1] : undefined;
    const state = pid === undefined ? undefined : states.get(Number(pid));
    if (state === undefined) return (readFile as (...args: unknown[]) => unknown)(path, ...rest);
    if (state === 'gone') throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: 'ENOENT' });
    if (state === 'unreadable') throw Object.assign(new Error(`EACCES: ${String(path)}`), { code: 'EACCES' });
    if (state === 'malformed') return `${pid} (bash`;
    return stat(Number(pid), state === 'zombie' ? 'Z' : 'S');
  }) as typeof fs.readFile;
  syncBuiltinESMExports();
  t.after(() => { fs.readFile = readFile; syncBuiltinESMExports(); });
}

export const report = (pid: number, namespace = 4026532000) => JSON.stringify({ 'child-pid': pid, 'pid-namespace': namespace });
