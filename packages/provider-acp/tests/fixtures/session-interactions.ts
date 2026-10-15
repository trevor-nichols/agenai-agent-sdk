import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId,
} from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type MaterializedAgentProviderInstance } from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver, type CreateNodeAcpProviderDriverOptions } from '../../src/node/index.js';
import { controlledPeerExecutionBoundary } from '../node-fixtures/execution-boundary.js';

export { fixtureDeferred } from '../node-fixtures/host-peer.js';
export { bindingFixture, server } from './session-mcp.js';
export const posix = { skip: process.platform === 'win32', timeout: 10_000 };
export const providerKey = parseAgentProviderKey('controlled-session-interactions');
export const definition = { providerKey, instanceId: parseAgentInstanceId('controlled:session-interactions'), driverConfiguration: {} };
export const context = (cwd: string) => ({ sessionId: parseAgentSessionId('logical-session'), workingDirectory: cwd,
  configuration: { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('controlled:configuration') }, onBindingCreated() {} });

export interface Frame {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}
interface Entry { readonly kind: string; readonly pid?: number; readonly argv?: string[]; readonly frame?: Frame }
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH';
function groupPresent(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
}
export function assertProcessGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), missing);
  assert.equal(groupPresent(pid), false, 'The independently probed owned process group must be absent.');
}
export async function waitFor<Value>(read: () => Value | undefined, description: string): Promise<Value> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await setTimeout(5);
  }
  throw new Error(`Controlled ACP peer did not reach ${description}.`);
}

export function sessionInteractionFixture(t: TestContext, mode = 'late', cleanup: () => void = () => {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'agenai-session-interactions-'));
  const executable = path.join(cwd, 'controlled-peer.mjs');
  const log = path.join(cwd, 'events.jsonl');
  const source = readFileSync(new URL('../node-fixtures/session-interaction-peer.mjs', import.meta.url), 'utf8');
  writeFileSync(executable, `#!${process.execPath}\n${source}`);
  chmodSync(executable, 0o700);
  writeFileSync(log, '');
  const entries = (): Entry[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Entry);
  const frames = (direction: 'inbound' | 'outbound' = 'inbound') => entries().flatMap((entry) => entry.kind === direction && entry.frame ? [entry.frame] : []);
  const options: CreateNodeAcpProviderDriverOptions = { providerKey, sessionInteractions: { mapping: 'grok-folder-trust-v1' },
    executionBoundary: controlledPeerExecutionBoundary(),
    launch: { executable, args: ['agent', '--no-leader', 'stdio'], cwd,
      env: { ACP_SESSION_FIXTURE_LOG: log, ACP_SESSION_FIXTURE_MODE: mode }, shutdownTimeoutMs: 100 },
    limits: { initializationTimeoutMs: 3_000 },
  };
  let owner: { dispose: () => Promise<void> | void } | undefined;
  t.after(async () => {
    cleanup();
    let failure: unknown;
    try { await owner?.dispose(); } catch (error) { failure = error; }
    for (const entry of entries().filter((entry) => entry.kind === 'started')) {
      assert.ok(entry.pid);
      if (groupPresent(entry.pid)) {
        process.kill(-entry.pid, 'SIGKILL');
        await waitFor(() => groupPresent(entry.pid!) ? undefined : true, 'emergency group cleanup');
      }
      assertProcessGone(entry.pid);
    }
    rmSync(cwd, { recursive: true, force: true });
    if (failure !== undefined) throw failure;
  });
  return { cwd, options, entries, frames,
    pid() { const value = entries().find((entry) => entry.kind === 'started')?.pid; assert.ok(value); return value; },
    signal() { process.kill(this.pid(), 'SIGUSR1'); },
    async materialize(overrides: Partial<CreateNodeAcpProviderDriverOptions> = {}): Promise<MaterializedAgentProviderInstance> {
      const instance = await createNodeAcpProviderDriver({ ...options, ...overrides }).materialize(definition);
      owner = instance;
      return instance;
    },
    async registered(overrides: Partial<CreateNodeAcpProviderDriverOptions> = {}) {
      const registry = await createAgentProviderRegistry({ drivers: [createNodeAcpProviderDriver({ ...options, ...overrides })], definitions: [definition] });
      owner = registry;
      const instance = registry.requireInstance(definition.instanceId);
      return { registry, instance, adapter: instance.adapter };
    },
  };
}
