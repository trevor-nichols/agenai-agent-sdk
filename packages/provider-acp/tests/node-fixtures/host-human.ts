import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver, type CreateNodeAcpProviderDriverOptions } from '../../src/node/index.js';
import { assertProcessGone, context } from '../fixtures/session-interactions.js';
import { controlledPeerExecutionBoundary } from './execution-boundary.js';
import { hostDefinition, hostProviderKey, type HostPeerFrame } from './host-peer.js';

interface Entry { readonly kind: string; readonly pid?: number; readonly frame?: HostPeerFrame }

export function hostHumanFixture(t: TestContext, cleanup: () => void) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'agenai-host-human-'));
  const executable = path.join(cwd, 'peer.mjs');
  const log = path.join(cwd, 'events.jsonl');
  const commands = path.join(cwd, 'commands.jsonl');
  writeFileSync(executable, `#!${process.execPath}\n${readFileSync(new URL('./host-human-peer.mjs', import.meta.url), 'utf8')}`);
  chmodSync(executable, 0o700); writeFileSync(log, ''); writeFileSync(commands, '');
  const entries = (): Entry[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Entry);
  const frames = () => entries().flatMap((entry) => entry.kind === 'inbound' && entry.frame ? [entry.frame] : []);
  const pid = () => { const value = entries().find((entry) => entry.kind === 'started')?.pid; assert.ok(value); return value; };
  const send = (frame: unknown) => { appendFileSync(commands, JSON.stringify(frame) + '\n'); process.kill(pid(), 'SIGUSR1'); };
  const wait = async (predicate: (frame: HostPeerFrame) => boolean): Promise<HostPeerFrame> => {
    const deadline = performance.now() + 3_000;
    for (;;) {
      const frame = frames().find(predicate);
      if (frame) return frame;
      if (performance.now() >= deadline) throw new Error('The controlled native host peer did not reach its expected frame.');
      await setTimeout(5);
    }
  };
  let registry: Awaited<ReturnType<typeof createAgentProviderRegistry>> | undefined;
  const nativeClosed = Promise.withResolvers<void>();
  const boundary = controlledPeerExecutionBoundary();
  t.after(async () => {
    cleanup();
    try { await registry?.dispose(); }
    finally {
      const processId = entries().find((entry) => entry.kind === 'started')?.pid;
      if (processId) {
        try { process.kill(-processId, 'SIGKILL'); } catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) throw cause; }
        assertProcessGone(processId);
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  return {
    context: context(cwd),
    nativeClosed: nativeClosed.promise,
    peer: { send, wait, get frames() { return frames(); },
      request(method: string, params: AcpJsonObject, id: string | number) {
        const response = wait((frame) => frame.id === id && frame.method === undefined);
        send({ jsonrpc: '2.0', id, method, params }); return response;
      },
    },
    async registered(options: Pick<CreateNodeAcpProviderDriverOptions, 'host' | 'limits'>) {
      registry = await createAgentProviderRegistry({ definitions: [hostDefinition], drivers: [createNodeAcpProviderDriver({
        ...options, providerKey: hostProviderKey, sessionInteractions: { mapping: 'grok-folder-trust-v1' },
        executionBoundary: { reserve(input) {
          const reservation = boundary.reserve(input);
          return { start: reservation.start.bind(reservation), async release() { await reservation.release(); nativeClosed.resolve(); } };
        } }, launch: { executable, args: ['agent', '--no-leader', 'stdio'], cwd,
          env: { ACP_HUMAN_LOG: log, ACP_HUMAN_COMMANDS: commands }, shutdownTimeoutMs: 100 },
      })] });
      return registry;
    },
  };
}
