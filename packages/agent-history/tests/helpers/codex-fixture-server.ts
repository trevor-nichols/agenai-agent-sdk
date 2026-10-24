import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { CodexNativeFixture } from './codex-fixture.js';

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type CodexFixtureRead = (method: 'thread/read' | 'thread/list', params: unknown) => Promise<unknown>;

/** Native setup and independent observations for owned synthetic fixtures only. */
async function withCodexFixtureServer<Value>(fixture: CodexNativeFixture, executable: string, mode: 'catalog' | 'indexed',
  operation: (request: CodexFixtureRead) => Promise<Value>): Promise<Value> {
  const child = spawn('/usr/bin/prlimit', [
    '--as=2147483648', '--cpu=30', '--nofile=256', '--core=0', '--',
    '/usr/bin/bwrap', '--die-with-parent', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/',
    '--bind', fixture.root, fixture.root, '--proc', '/proc', '--dev', '/dev', '--chdir', fixture.projectPath,
    executable, 'app-server', '--listen', 'stdio://',
    '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false',
    '-c', 'features.sqlite=true', '-c', 'features.apps=false', '-c', 'features.plugins=false',
    '-c', 'features.local_thread_store_compression=false', '-c', `features.background_paginated_rollout_migration=${mode === 'indexed'}`,
  ], { cwd: fixture.root, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    PATH: '/usr/bin:/bin', HOME: fixture.root, CODEX_HOME: fixture.configHome,
    XDG_CONFIG_HOME: fixture.root, XDG_CACHE_HOME: fixture.root, XDG_DATA_HOME: fixture.root,
    LANG: 'C.UTF-8', RUST_LOG: 'error',
  } });
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  let nextId = 0, buffer = Buffer.alloc(0), outputBytes = 0;
  let failure: Error | undefined;
  const exited = Promise.withResolvers<void>();
  const kill = () => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (!missing(error)) throw error; }
  };
  const fail = (error: Error) => {
    failure ??= error;
    for (const result of pending.values()) result.reject(failure);
    pending.clear();
    kill();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', () => { fail(new Error('Fixture migration process closed before a response.')); exited.resolve(); });
  child.stderr.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 16 * 1024 * 1024) fail(new Error('Fixture migration output limit exceeded.'));
  });
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    buffer = Buffer.concat([buffer, chunk]);
    if (outputBytes > 16 * 1024 * 1024 || buffer.length > 2 * 1024 * 1024) {
      fail(new Error('Fixture migration response limit exceeded.')); return;
    }
    let newline: number;
    while ((newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      let message: unknown;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
      catch { fail(new Error('Fixture migration emitted malformed JSON.')); return; }
      if (!record(message) || typeof message.id !== 'number') continue;
      const response = pending.get(message.id);
      if (response === undefined) { fail(new Error('Fixture migration emitted an uncorrelated response.')); return; }
      pending.delete(message.id);
      if ('error' in message) response.reject(Object.assign(new Error('Fixture native request failed.'),
        { code: record(message.error) ? message.error.code : undefined }));
      else response.resolve(message.result);
    }
  });
  const request = async (method: 'initialize' | 'thread/read' | 'thread/list', params: unknown): Promise<unknown> => {
    if (failure !== undefined) throw failure;
    const id = ++nextId, response = Promise.withResolvers<unknown>();
    pending.set(id, response);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return response.promise;
  };
  const timer = setTimeout(() => fail(new Error('Fixture migration deadline exceeded.')), 20_000);
  try {
    await request('initialize', { clientInfo: { name: 'agenai_fixture_migration', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return await operation(request);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    const reapTimer = setTimeout(kill, 2000);
    try { await exited.promise; } finally { clearTimeout(reapTimer); }
    kill();
    if (child.pid !== undefined) {
      const deadline = performance.now() + 2000;
      for (;;) {
        try { process.kill(-child.pid, 0); }
        catch (error) { if (missing(error)) break; throw error; }
        if (performance.now() > deadline) throw new Error('Fixture migration process group was not reaped.');
        await delay(20);
      }
    }
  }
}

async function prepareCodexFixture(fixture: CodexNativeFixture, executable: string, mode: 'catalog' | 'indexed'): Promise<void> {
  await withCodexFixtureServer(fixture, executable, mode, async (request) => {
    if (mode === 'catalog') {
      const listed = await request('thread/list', { limit: 100, modelProviders: [],
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent'], useStateDbOnly: false });
      if (!record(listed) || !Array.isArray(listed.data) || listed.data.length !== 5) {
        throw new Error('Native fixture setup did not establish all five catalog metadata rows.');
      }
      const read = await request('thread/read', { threadId: fixture.ids.cli, includeTurns: false });
      if (!record(read) || !record(read.thread) || read.thread.historyMode !== 'legacy') {
        throw new Error('Catalog fixture setup must preserve the legacy transcript format.');
      }
      return;
    }
    const deadline = performance.now() + 10_000;
    for (const threadId of [fixture.ids.cli, fixture.ids.vscode]) {
      for (;;) {
        const response = await request('thread/read', { threadId, includeTurns: false });
        if (record(response) && record(response.thread) && response.thread.historyMode === 'paginated') break;
        if (performance.now() > deadline) throw new Error('Native migration did not establish an indexed fixture store.');
        await delay(25);
      }
    }
  });
}

export function inspectCodexFixture<Value>(fixture: CodexNativeFixture, executable: string,
  inspect: (request: CodexFixtureRead) => Promise<Value>): Promise<Value> {
  return withCodexFixtureServer(fixture, executable, 'catalog', inspect);
}

export async function prepareCodexMetadataFixture(fixture: CodexNativeFixture, executable: string): Promise<void> {
  await prepareCodexFixture(fixture, executable, 'catalog');
}

/** Explicit fixture-only migration. The public history constructor never enables this feature. */
export async function prepareCodexIndexedFixture(fixture: CodexNativeFixture, executable: string): Promise<void> {
  await prepareCodexFixture(fixture, executable, 'indexed');
}
