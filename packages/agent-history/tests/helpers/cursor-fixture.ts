import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CURSOR_NATIVE_VERSION = '1.0.40';
export const CURSOR_ESM_SHA256 = 'fa955abb770bd70961ce878e184adf431b3bf6ba034f8ffce69ff2104b2a5bfe';
export const CURSOR_FIXTURE_IDS = {
  alpha: 'agent-ms006-alpha', beta: 'agent-ms006-beta', empty: 'agent-ms006-empty',
  foreign: 'agent-ms006-foreign', missing: 'agent-ms006-missing', oversized: 'agent-ms006-oversized',
} as const;
export const CURSOR_FIXTURE_RUN_IDS = {
  first: 'agent-ms006-alpha-run-0', second: 'agent-ms006-alpha-run-1', checkpointOnly: 'agent-ms006-alpha-run-2',
  foreign: 'agent-ms006-foreign-run-0', running: 'agent-ms006-alpha-run-active', missing: 'run-ms006-missing',
} as const;

export interface CursorFixture {
  readonly root: string;
  readonly storeRoot: string;
  readonly temporaryRoot: string;
  readonly projectPath: string;
  readonly otherProjectPath: string;
  readonly backend: 'jsonl' | 'sqlite';
  readonly label: string;
  readonly sdkEntry: string;
  readonly ids: typeof CURSOR_FIXTURE_IDS;
  readonly runIds: typeof CURSOR_FIXTURE_RUN_IDS;
  replaceCheckpoint(agentId: string, options?: { label?: string; assistantBytes?: number; malformed?: boolean }): Promise<void>;
  replaceAgentName(agentId: string, name: unknown): Promise<void>;
  cleanup(): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function cursorFileSha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export async function resolveCursorFixtureSdkEntry(): Promise<string> {
  const entry = fileURLToPath(import.meta.resolve('@cursor/sdk'));
  const manifest: unknown = JSON.parse(await readFile(join(dirname(entry), '..', '..', 'package.json'), 'utf8'));
  if (!record(manifest) || manifest.version !== CURSOR_NATIVE_VERSION) throw new Error('Native fixture requires exact @cursor/sdk 1.0.40.');
  return entry;
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value > 0);
  return Buffer.from(bytes);
}
function field(number: number, bytes: Uint8Array): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.byteLength), bytes]);
}

async function withStore<Value>(fixture: Pick<CursorFixture, 'backend' | 'sdkEntry' | 'storeRoot' | 'projectPath'>,
  operation: (store: Awaited<ReturnType<typeof nativeStore>>['store'], sdk: Awaited<ReturnType<typeof nativeStore>>['sdk']) => Promise<Value>): Promise<Value> {
  const { store, sdk } = await nativeStore(fixture);
  try { return await operation(store, sdk); }
  finally { if (fixture.backend === 'sqlite') await store.dispose(); }
}

async function nativeStore(fixture: Pick<CursorFixture, 'backend' | 'sdkEntry' | 'storeRoot' | 'projectPath'>) {
  const sdk = await import(pathToFileURL(fixture.sdkEntry).href);
  const store = fixture.backend === 'jsonl' ? new sdk.JsonlLocalAgentStore(fixture.storeRoot)
    : await (await import(pathToFileURL(join(dirname(fixture.sdkEntry), 'sqlite.js')).href)).SqliteLocalAgentStore.open({
      stateRoot: fixture.storeRoot, workspaceRef: fixture.projectPath,
    });
  return { sdk, store };
}

async function checkpoint(store: Awaited<ReturnType<typeof nativeStore>>['store'], agentId: string,
  label: string, assistantBytes?: number): Promise<{ schemaVersion: 1; rootBlobId: string }> {
  const save = async (bytes: Buffer): Promise<Buffer> => {
    const blobId = createHash('sha256').update(bytes).digest('hex');
    if (await store.checkpoints.get({ agentId, blobId }) === null) await store.checkpoints.create({ agentId, blobId, data: bytes });
    return Buffer.from(blobId, 'hex');
  };
  const turns: Buffer[] = [];
  for (let index = 0; index < 4; index += 1) {
    const user = await save(Buffer.concat([field(1, Buffer.from(`${label} checkpoint user ${index}`)),
      field(2, Buffer.from(`${agentId}-user-${index}`))]));
    const assistant = await save(field(1, field(1, Buffer.from(index === 0 && assistantBytes !== undefined
      ? 'x'.repeat(assistantBytes) : `${label} checkpoint assistant ${index}`))));
    const tool = index === 0 ? [field(2, await save(field(2, field(8, field(1, field(1, Buffer.from('/synthetic/never-opened.txt')))))))] : [];
    turns.push(await save(field(1, Buffer.concat([field(1, user), field(2, assistant), ...tool]))));
  }
  await save(field(1, Buffer.from('ORPHAN HISTORY IS NOT CURRENT CHECKPOINT')));
  const summary = await save(field(1, Buffer.from('Stored checkpoint summary is not an exposed compaction event')));
  const root = await save(Buffer.concat([...turns.map((turn) => field(8, turn)), field(6, summary)]));
  return { schemaVersion: 1, rootBlobId: root.toString('hex') };
}

/** Synthetic native SDK store setup; no Agent.create, resume, send, model or IDE-store access. */
export async function createCursorFixture(options: { backend: 'jsonl' | 'sqlite'; label?: string; sdkEntry?: string; seed?: boolean }): Promise<CursorFixture> {
  const sdkEntry = options.sdkEntry ?? await resolveCursorFixtureSdkEntry();
  if (await cursorFileSha256(sdkEntry) !== CURSOR_ESM_SHA256) throw new Error('Cursor fixture SDK entry differs from qualified 1.0.40 bytes.');
  const root = await mkdtemp(join(tmpdir(), 'agent-cursor-history-'));
  const storeRoot = join(root, 'store'), temporaryRoot = join(root, 'workers');
  const projectPath = join(root, 'project'), otherProjectPath = join(root, 'other-project');
  const label = options.label ?? 'STORE-A';
  const fixture: CursorFixture = { root, storeRoot, temporaryRoot, projectPath, otherProjectPath,
    backend: options.backend, label, sdkEntry, ids: CURSOR_FIXTURE_IDS, runIds: CURSOR_FIXTURE_RUN_IDS,
    replaceCheckpoint: async (agentId, replacement = {}) => withStore(fixture, async (store) => {
      const agent = await store.agents.get({ agentId });
      if (agent === null) throw new Error('Cannot replace a missing synthetic native checkpoint.');
      let latestCheckpoint;
      if (replacement.malformed) {
        const data = Buffer.from([0xff]), blobId = createHash('sha256').update(data).digest('hex');
        await store.checkpoints.create({ agentId, blobId, data });
        latestCheckpoint = { schemaVersion: 1, rootBlobId: blobId };
      } else latestCheckpoint = await checkpoint(store, agentId, replacement.label ?? `${label} changed`, replacement.assistantBytes);
      await store.agents.update({ agent: { ...agent, latestCheckpoint, updatedAt: agent.updatedAt + 1 } });
    }),
    replaceAgentName: (agentId, name) => withStore(fixture, async (store) => {
      const agent = await store.agents.get({ agentId });
      if (agent === null) throw new Error('Cannot replace missing synthetic agent metadata.');
      await store.agents.update({ agent: { ...agent, name } });
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
  try {
    await Promise.all([storeRoot, temporaryRoot, projectPath, otherProjectPath].map((path) => mkdir(path, { mode: 0o700 })));
    if (options.seed === false) return fixture;
    await withStore(fixture, async (store, sdk) => {
      const specs = [
        { id: fixture.ids.alpha, name: `${label} Alpha`, updatedAt: 100, cwd: projectPath },
        { id: fixture.ids.beta, name: `${label} Beta`, updatedAt: 90, cwd: projectPath },
        { id: fixture.ids.empty, name: `${label} Empty`, updatedAt: 80, cwd: projectPath },
        { id: fixture.ids.foreign, name: `${label} Foreign`, updatedAt: 70, cwd: otherProjectPath },
      ];
      for (const spec of specs) {
        const latestCheckpoint = spec.id === fixture.ids.empty ? null : await checkpoint(store, spec.id, spec.name);
        await store.agents.create({ agent: { agentId: spec.id, cwd: spec.cwd, status: 'idle', activeRunId: null,
          name: spec.name, createdAt: 1, updatedAt: spec.updatedAt, latestCheckpoint } });
      }
      for (const [index, runId] of [fixture.runIds.first, fixture.runIds.second, fixture.runIds.checkpointOnly].entries()) {
        const agent = await store.agents.get({ agentId: fixture.ids.alpha });
        await store.runs.create({ run: { runId, agentId: fixture.ids.alpha, turnNumber: index + 1, status: 'finished',
          createdAt: index + 1, updatedAt: 100 + index, latestCheckpointRef: agent.latestCheckpoint } });
        if (runId === fixture.runIds.checkpointOnly) continue;
        for (const type of ['user', 'assistant'] as const) {
          await store.runEvents.append({ runId, eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
            payload: sdk.createSdkMessageRunStreamEvent({ type, agent_id: fixture.ids.alpha, run_id: runId,
              message: { role: type, content: [{ type: 'text', text: `${label} run ${index} ${type}` }] } }) });
        }
        await store.runEvents.append({ runId, eventType: sdk.LOCAL_RUN_STREAM_EVENT_TYPE,
          payload: sdk.createSdkMessageRunStreamEvent({ type: 'status', agent_id: fixture.ids.alpha, run_id: runId, status: 'FINISHED' }) });
      }
      await store.runs.create({ run: { runId: fixture.runIds.foreign, agentId: fixture.ids.foreign, turnNumber: 1,
        status: 'finished', createdAt: 1, updatedAt: 70 } });
      await store.runs.create({ run: { runId: fixture.runIds.running, agentId: fixture.ids.alpha, turnNumber: 4,
        status: 'running', createdAt: 4, updatedAt: 103 } });
    });
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}

export async function cursorFixtureDigests(root: string): Promise<readonly (readonly [string, string])[]> {
  const files: [string, string][] = [];
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${prefix}${entry.name}/`);
      else files.push([`${prefix}${entry.name}`, await cursorFileSha256(join(directory, entry.name))]);
    }
  }
  await visit(root, '');
  return files.sort(([first], [second]) => first.localeCompare(second));
}

export async function cursorFixtureRows(fixture: CursorFixture): Promise<{ agents: readonly unknown[]; runs: readonly unknown[] }> {
  return withStore(fixture, async (store) => ({
    agents: (await store.agents.list({ filter: { limit: 100 } })).items,
    runs: (await store.runs.list({ filter: { limit: 100 } })).items,
  }));
}

export async function cursorFixtureAgent(fixture: CursorFixture, agentId: string): Promise<unknown> {
  return withStore(fixture, (store) => store.agents.get({ agentId }));
}

export async function cursorFixtureActiveRun(fixture: CursorFixture, agentId: string, activeRunId: string | null): Promise<void> {
  await withStore(fixture, async (store) => {
    const agent = await store.agents.get({ agentId });
    if (agent === null) throw new Error('The disposable native agent is missing.');
    await store.agents.update({ agent: { ...agent, activeRunId, status: activeRunId === null ? 'idle' : 'running' } });
  });
}

export async function cursorFixtureDependencies(fixture: CursorFixture, agentId: string, runId: string): Promise<{
  readonly runs: readonly unknown[]; readonly checkpoints: readonly unknown[]; readonly events: readonly unknown[];
}> {
  return withStore(fixture, async (store) => ({
    runs: (await store.runs.list({ filter: { agentIds: [agentId], limit: 100 } })).items,
    checkpoints: (await store.checkpoints.list({ filter: { agentIds: [agentId], limit: 1000 } })).items,
    events: (await store.runEvents.list({ runId, limit: 100 })).items,
  }));
}

/** Streamed synthetic JSONL ingress used only to prove bounded worker failure. */
export async function writeCursorOversizedCatalog(root: string, projectPath: string, paddingBytes: number): Promise<void> {
  const file = await open(join(root, 'agents.ndjson'), 'w', 0o600);
  try {
    await file.write(`{"agentId":"agent-ms006-large","cwd":${JSON.stringify(projectPath)},"status":"idle","createdAt":1,"updatedAt":2,"sdkMetadata":{"padding":"`);
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    for (let remaining = paddingBytes; remaining > 0; remaining -= chunk.length) await file.write(chunk.subarray(0, Math.min(remaining, chunk.length)));
    await file.write('"}}\n');
  } finally { await file.close(); }
}
