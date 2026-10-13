// ------------------------------------------------------------------------------------------------
//                state.ts - Owned durable-demo directory and synchronized bounded identity
// ------------------------------------------------------------------------------------------------

import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DelegationParentScope } from '@agen-ai/agent-orchestration';
import type { ParentDestination } from '../inbox/index.js';

export type Scenario = 'normal' | 'lost-ack' | 'revoked' | 'uncertain';
export interface DemoState {
  readonly schemaVersion: 1;
  readonly kind: 'agenai-durable-delegation-example';
  readonly root: string;
  readonly identity: Readonly<{ dev: string; ino: string }>;
  readonly scenario: Scenario;
  readonly operationId: string;
  readonly parent: DelegationParentScope;
  readonly storeId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly notificationId?: string;
  readonly inboxId?: string;
}
export const stateName = 'demo.json';
const files = new Set([stateName, 'authority.json', 'effects.json', 'parent-input.json', 'database', 'children']);
const databaseFiles = new Set(['owner.sqlite', 'owner.sqlite-journal', 'task.sqlite', 'task.sqlite-wal', 'task.sqlite-shm']);
const maximumJsonBytes = 16_384;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const scenarios: readonly string[] = ['normal', 'lost-ack', 'revoked', 'uncertain'];

function reject(): never { throw new Error('The durable example directory or bounded state is unavailable or unfamiliar.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) reject();
}
function privateIdentity(path: string, directory: boolean) {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== BigInt(process.getuid!())
    || (stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n) || (!directory && stat.nlink !== 1n)) reject();
  return { dev: String(stat.dev), ino: String(stat.ino), size: stat.size };
}
function syncDirectory(root: string) {
  const descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function readJson(root: string, name: string): unknown {
  if (privateIdentity(join(root, name), false).size > BigInt(maximumJsonBytes)) reject();
  const bytes = readFileSync(join(root, name));
  if (bytes.length > maximumJsonBytes) reject();
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
export function writeJson(root: string, name: string, value: unknown) {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > maximumJsonBytes) reject();
  const temporary = join(root, `.${name}-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, join(root, name));
  syncDirectory(root);
}
export function qualifiedTuple(root: string) {
  const filesystem = statfsSync(root).type;
  if (process.platform !== 'linux' || process.version !== 'v24.18.0' || process.versions.sqlite !== '3.53.1' || filesystem !== 0xEF53) {
    throw new Error('The durable example requires Linux, Node 24.18.0, SQLite 3.53.1 and local filesystem 0xEF53.');
  }
  return { node: process.version, sqlite: process.versions.sqlite, filesystem: `0x${filesystem.toString(16)}` };
}
export function createDemo(base: string | undefined, scenario: Scenario): DemoState {
  if (base !== undefined && (!isAbsolute(base) || Buffer.byteLength(base) > 4096)) reject();
  const requested = base ?? join(process.cwd(), '.agent');
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(requested);
  qualifiedTuple(canonical);
  const root = mkdtempSync(join(canonical, 'delegation-demo-'));
  const identity = privateIdentity(root, true);
  const state: DemoState = { schemaVersion: 1, kind: 'agenai-durable-delegation-example', root,
    identity: { dev: identity.dev, ino: identity.ino }, scenario, operationId: randomUUID(),
    parent: { parentId: 'example-parent', scopeId: 'example-host', revision: 1 } };
  writeJson(root, stateName, state);
  writeJson(root, 'authority.json', { revision: 1, lifecycle: 'idle', resultAccess: true, executionAllowed: true });
  writeJson(root, 'effects.json', { child: 0, parent: 0 });
  syncDirectory(canonical);
  return state;
}
export function readState(input: string): DemoState {
  if (!isAbsolute(input) || Buffer.byteLength(input) > 4096 || resolve(input) !== input || realpathSync(input) !== input) reject();
  const identity = privateIdentity(input, true);
  if (readdirSync(input).some((name) => !files.has(name))) reject();
  for (const name of readdirSync(input)) privateIdentity(join(input, name), name === 'database' || name === 'children');
  const value = record(readJson(input, stateName));
  exact(value, ['schemaVersion', 'kind', 'root', 'identity', 'scenario', 'operationId', 'parent', 'storeId', 'taskId', 'runId', 'notificationId', 'inboxId']);
  const retained = record(value.identity);
  exact(retained, ['dev', 'ino']);
  const parent = record(value.parent);
  exact(parent, ['parentId', 'scopeId', 'revision']);
  if (value.schemaVersion !== 1 || value.kind !== 'agenai-durable-delegation-example' || value.root !== input
    || retained.dev !== identity.dev || retained.ino !== identity.ino || typeof value.scenario !== 'string' || !scenarios.includes(value.scenario)
    || parent.parentId !== 'example-parent' || parent.scopeId !== 'example-host' || parent.revision !== 1) reject();
  for (const key of ['operationId', 'storeId', 'taskId', 'runId', 'notificationId', 'inboxId']) {
    if ((key === 'operationId' || value[key] !== undefined) && (typeof value[key] !== 'string' || !uuid.test(value[key]))) reject();
  }
  if ((value.taskId === undefined) !== (value.runId === undefined) || (value.notificationId !== undefined && value.taskId === undefined)
    || (value.inboxId !== undefined && value.notificationId === undefined)) reject();
  if (readdirSync(input).includes('database')) for (const name of readdirSync(join(input, 'database'))) {
    if (!databaseFiles.has(name)) reject();
    privateIdentity(join(input, 'database', name), false);
  }
  if (readdirSync(input).includes('children')) for (const name of readdirSync(join(input, 'children'))) {
    if (name !== value.taskId) reject();
    const child = join(input, 'children', name);
    privateIdentity(child, true);
    if (readdirSync(child).length !== 0) reject();
  }
  return value as unknown as DemoState;
}
export function updateState(root: string, update: Partial<DemoState>) {
  const state = { ...readState(root), ...update };
  writeJson(root, stateName, state);
  return state;
}
export function readAuthority(root: string): ParentDestination {
  const value = record(readJson(root, 'authority.json'));
  exact(value, ['revision', 'lifecycle', 'resultAccess', 'executionAllowed']);
  if (value.revision !== 1 || value.lifecycle !== 'idle' || typeof value.resultAccess !== 'boolean' || typeof value.executionAllowed !== 'boolean') reject();
  return value as unknown as ParentDestination;
}
export function readEffects(root: string): { child: number; parent: number } {
  const value = record(readJson(root, 'effects.json'));
  exact(value, ['child', 'parent']);
  for (const key of ['child', 'parent']) if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0) reject();
  return value as { child: number; parent: number };
}
export function recordEffect(root: string, actor: 'child' | 'parent') {
  const effects = readEffects(root);
  writeJson(root, 'effects.json', { ...effects, [actor]: effects[actor] + 1 });
}
export function readParentInput(root: string): { text: string } | undefined {
  if (!readdirSync(root).includes('parent-input.json')) return undefined;
  const value = record(readJson(root, 'parent-input.json'));
  exact(value, ['text']);
  if (typeof value.text !== 'string') reject();
  return { text: value.text };
}
