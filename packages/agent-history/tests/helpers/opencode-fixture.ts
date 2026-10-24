import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const OPENCODE_NATIVE_VERSION = '2.1.2';
export const OPENCODE_LINUX_X64_SHA256 = '22636c800ba6c8dc5353e264183bb3927725d824cba412f007dea9c694740f52';
export const OPENCODE_FIXTURE_PROVENANCE = 'https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/protocol/src/groups/session.ts';
export const OPENCODE_FIXTURE_IDS = {
  alpha: 'ses_ms005_alpha', beta: 'ses_ms005_beta', child: 'ses_ms005_child',
  empty: 'ses_ms005_empty', archived: 'ses_ms005_archived', oversized: 'ses_ms005_oversized', missing: 'ses_ms005_missing',
} as const;

export interface OpenCodeFixtureResponse { readonly status: number; readonly body: unknown }
export interface OpenCodeFixture {
  readonly root: string;
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly projectPath: string;
  readonly otherProjectPath: string;
  readonly ids: typeof OPENCODE_FIXTURE_IDS;
  readonly pid: number;
  request(path: string, init?: RequestInit): Promise<OpenCodeFixtureResponse>;
  stopServer(): Promise<void>;
  cleanup(): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionData(response: OpenCodeFixtureResponse): Record<string, unknown> {
  if (response.status !== 200 || !record(response.body) || !record(response.body.data)) {
    throw new Error(`Native fixture session setup failed with HTTP ${response.status}.`);
  }
  return response.body.data;
}

function missing(error: unknown): boolean {
  return record(error) && error.code === 'ESRCH';
}

export async function openCodeFileSha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export async function resolveOpenCodeFixtureExecutable(): Promise<string> {
  const require = createRequire(import.meta.url);
  const wrapperPath = require.resolve('@opencode/cli/package.json');
  const wrapper: unknown = JSON.parse(await readFile(wrapperPath, 'utf8'));
  if (!record(wrapper) || wrapper.version !== OPENCODE_NATIVE_VERSION) {
    throw new Error('Native fixtures require exact @opencode/cli 2.1.2.');
  }
  const manifestPath = createRequire(wrapperPath).resolve('@opencode/cli-linux-x64-baseline/package.json');
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!record(manifest) || manifest.version !== OPENCODE_NATIVE_VERSION) {
    throw new Error('Native fixtures require exact @opencode/cli-linux-x64-baseline 2.1.2.');
  }
  return join(dirname(manifestPath), 'bin', 'opencode');
}

export function openCodeFixtureMessages(): readonly Record<string, unknown>[] {
  return [
    { id: 'msg_ms005_user', type: 'user', text: 'Stored OpenCode question',
      files: [{ data: 'aGlzdG9yeQ==', mime: 'text/plain', source: { type: 'inline' }, name: 'fixture.txt' }], time: { created: 1000 } },
    { id: 'msg_ms005_assistant', type: 'assistant', agent: 'build', model: { id: 'fixture-model', providerID: 'fixture-provider' },
      content: [
        { type: 'reasoning', text: 'Stored OpenCode reasoning' },
        { type: 'text', text: 'Stored answer before tool' },
        { type: 'tool', id: 'call_ms005_read', name: 'read', executed: true,
          state: { status: 'completed', input: { path: '/synthetic/never-opened.txt' }, content: [{ type: 'text', text: 'Stored native tool result' }] },
          time: { created: 2000, ran: 2000, completed: 3000 } },
        { type: 'text', text: 'Stored answer after tool' },
      ], time: { created: 2000, completed: 3000 } },
    { id: 'msg_ms005_system', type: 'system', text: 'Stored system context', time: { created: 4000 } },
    { id: 'msg_ms005_compaction', type: 'compaction', status: 'completed', reason: 'manual',
      summary: 'Imported native compaction summary', time: { created: 5000 } },
    { id: 'msg_ms005_final_user', type: 'user', text: 'Stored follow-up question', time: { created: 6000 } },
    { id: 'msg_ms005_final_answer', type: 'assistant', agent: 'build', model: { id: 'fixture-model', providerID: 'fixture-provider' },
      content: [{ type: 'text', text: 'Stored final OpenCode answer' }], time: { created: 7000, completed: 8000 } },
  ];
}

/** Test-only native API setup. Production never launches this server or imports synthetic sessions. */
export async function createOpenCodeFixture(executable: string, options: { oversizedMessageBytes?: number; childInOtherProject?: boolean } = {}): Promise<OpenCodeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'agent-opencode-history-'));
  const projectPath = join(root, 'project'), otherProjectPath = join(root, 'other-project');
  try { await Promise.all([projectPath, otherProjectPath].map((path) => mkdir(path, { mode: 0o700 }))); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const password = randomBytes(24).toString('base64url');
  const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: projectPath, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TMPDIR: root,
      XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'), LANG: 'C.UTF-8', OPENCODE_PASSWORD: password,
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    },
  });
  const listening = Promise.withResolvers<string>(), exited = Promise.withResolvers<void>();
  let startupOutput = '', outputBytes = 0, stopped: Promise<void> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (!missing(error)) throw error; }
  };
  const fail = (error: Error) => { listening.reject(error); signalGroup('SIGKILL'); };
  child.on('error', (error) => { fail(error); exited.resolve(); });
  child.on('close', () => { listening.reject(new Error('Native OpenCode fixture exited before listening.')); exited.resolve(); });
  child.stdout.on('data', (bytes: Buffer) => {
    outputBytes += bytes.length;
    if (outputBytes > 128 * 1024) { fail(new Error('Native OpenCode fixture output exceeded its bound.')); return; }
    startupOutput = `${startupOutput}${bytes.toString('utf8')}`.slice(-8192);
    const match = startupOutput.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/u);
    if (match?.[1] !== undefined) listening.resolve(match[1]);
  });
  child.stderr.on('data', (bytes: Buffer) => {
    outputBytes += bytes.length;
    if (outputBytes > 128 * 1024) fail(new Error('Native OpenCode fixture output exceeded its bound.'));
  });
  const startupTimer = setTimeout(() => fail(new Error('Native OpenCode fixture startup exceeded thirty seconds.')), 30000);
  const lifetimeTimer = setTimeout(() => signalGroup('SIGKILL'), 120000);
  lifetimeTimer.unref();
  const stopServer = () => stopped ??= (async () => {
    clearTimeout(startupTimer); clearTimeout(lifetimeTimer);
    signalGroup('SIGINT');
    const reapTimer = setTimeout(() => signalGroup('SIGKILL'), 1500);
    try { await exited.promise; } finally { clearTimeout(reapTimer); }
    signalGroup('SIGKILL');
    if (child.pid !== undefined) {
      const deadline = performance.now() + 2000;
      for (;;) {
        try { process.kill(-child.pid, 0); }
        catch (error) { if (missing(error)) break; throw error; }
        if (performance.now() > deadline) throw new Error('Native OpenCode fixture process group did not exit.');
        await delay(20);
      }
    }
  })();
  const cleanup = async () => { try { await stopServer(); } finally { await rm(root, { recursive: true, force: true }); } };
  try {
    const endpoint = await listening.promise;
    clearTimeout(startupTimer);
    if (child.pid === undefined) throw new Error('Native OpenCode fixture has no owned PID.');
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
    const request = async (path: string, init: RequestInit = {}): Promise<OpenCodeFixtureResponse> => {
      if (!path.startsWith('/api/')) throw new Error('Native fixture requests must remain in the owned API.');
      const requestHeaders = new Headers(headers);
      if (init.body !== undefined) requestHeaders.set('content-type', 'application/json');
      new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
      const response = await fetch(`${endpoint}${path}`, { ...init, headers: requestHeaders,
        signal: init.signal ?? AbortSignal.timeout(10000) });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      try {
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Native fixture setup response exceeded four MiB.'); }
          chunks.push(chunk.value);
        }
      } finally { reader?.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8');
      return { status: response.status, body: text === '' ? null : JSON.parse(text) };
    };
    const fixture: OpenCodeFixture = { root, endpoint, headers, projectPath, otherProjectPath, ids: OPENCODE_FIXTURE_IDS,
      pid: child.pid, request, stopServer, cleanup };
    for (const directory of [projectPath, otherProjectPath]) {
      const template = sessionData(await request('/api/session', { method: 'POST', body: JSON.stringify({ title: 'Synthetic history setup template', location: { directory } }) }));
      if (typeof template.id !== 'string' || !record(template.time)) throw new Error('Native setup template is malformed.');
      const child = { id: fixture.ids.child, title: 'Child OpenCode history', parentID: fixture.ids.alpha,
        messages: [{ id: 'msg_ms005_child', type: 'user', text: 'Stored child question', time: { created: 1000 } }] };
      const specs = directory === projectPath
        ? [{ id: fixture.ids.alpha, title: 'Alpha OpenCode history', messages: openCodeFixtureMessages() },
          ...(options.childInOtherProject ? [] : [child]),
          { id: fixture.ids.empty, title: 'Empty OpenCode history', messages: [] },
          { id: fixture.ids.archived, title: 'Archived OpenCode history', archived: true,
            messages: [{ id: 'msg_ms005_archived', type: 'user', text: 'Stored archived question', time: { created: 1000 } }] },
          ...(options.oversizedMessageBytes === undefined ? [] : [{ id: fixture.ids.oversized, title: 'Oversized OpenCode history',
            messages: [{ id: 'msg_ms005_oversized', type: 'user', text: 'x'.repeat(options.oversizedMessageBytes), time: { created: 1000 } }] }])]
        : [{ id: fixture.ids.beta, title: 'Beta other-project history',
          messages: [{ id: 'msg_ms005_beta', type: 'user', text: 'Stored other-project question', time: { created: 1000 } }] },
          ...(options.childInOtherProject ? [child] : [])];
      let previousUpdatedAt: number | undefined;
      for (const [index, spec] of specs.entries()) {
        if (previousUpdatedAt !== undefined) await delay(2);
        const at = 1767268800000 + index * 10000;
        const imported = sessionData(await request('/api/experimental/session/import', { method: 'POST', body: JSON.stringify({
          info: { ...template, id: spec.id, title: spec.title, ...('parentID' in spec ? { parentID: spec.parentID } : {}),
            time: { ...template.time, created: at, updated: at, ...('archived' in spec ? { archived: at } : {}) } },
          messages: spec.messages, location: { directory },
        }) }));
        if (!record(imported.time) || typeof imported.time.updated !== 'number'
          || (previousUpdatedAt !== undefined && imported.time.updated <= previousUpdatedAt)) {
          throw new Error('Native fixture imports must have distinct ascending update timestamps.');
        }
        previousUpdatedAt = imported.time.updated;
      }
      const removed = await request(`/api/session/${template.id}`, { method: 'DELETE' });
      if (removed.status !== 204) throw new Error('Native fixture template cleanup failed.');
    }
    return fixture;
  } catch (error) { await cleanup(); throw error; }
}
