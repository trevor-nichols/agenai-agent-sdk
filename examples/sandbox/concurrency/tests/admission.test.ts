import assert from 'node:assert/strict';
import test from 'node:test';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import type { DockerDesktopCoordinator } from '@agen-ai/sandbox-docker';
import { isolatedSandboxRequest } from '../../policy.js';
import { runConcurrentSandboxWorkflow } from '../index.js';
import type { ConcurrentForbiddenFixture, ConcurrentMemberInput } from '../index.js';

test('aggregate command and reply overflow reject public workflow admission before reservation or coordinator effects', async () => {
  let reservations = 0; let coordinatorEffects = 0;
  const unavailable = async () => { coordinatorEffects++; throw new Error('Unexpected coordinator effect.'); };
  const coordinator: DockerDesktopCoordinator = { state: { kind: 'inert' }, initialize: unavailable, activate: unavailable,
    reopenCleanup: unavailable, closeAdmission() { coordinatorEffects++; throw new Error('Unexpected coordinator effect.'); },
    settle: unavailable, close: unavailable };
  function member(label: 'a' | 'b' | 'c', forbidden: readonly ConcurrentForbiddenFixture[]): ConcurrentMemberInput {
    const hostname = label + '.example.test';
    const original = createDockerSandboxBackend({ profile: 'linux-x64', endpoint: 'unix:///explicit-unopened/engine.sock',
      namespace: 'concurrency-admission-' + label, imageDigest: 'sha256:' + '1'.repeat(64),
      user: { uid: 1000, gid: 1000 }, spillDirectory: '/explicit-unopened/spill/' + label });
    return { backend: { support: original.support, reconcile: (...input) => original.reconcile(...input),
      reserve() { reservations++; throw new Error('Unexpected sandbox reservation.'); } },
    request: { policy: { ...isolatedSandboxRequest().policy, files: { kind: 'read_write' },
      network: { kind: 'restricted_https', destinations: [{ hostname, port: 443 }] } } },
    recovery: { kind: 'in_process' }, positive: { hostname, port: 443, path: '/', status: 200, bodyBytes: 1, bodySha256: '0'.repeat(64) },
    forbidden, destination: '/explicit-unopened/export/' + label };
  }
  const fixture: ConcurrentForbiddenFixture = { hostname: 'forbidden.example.test', address: '192.0.2.10', port: 8080,
    transport: 'tcp', probe: 'probe', marker: 'marker' };
  for (const [forbidden, message] of [
    [Array.from({ length: 12 }, () => ({ ...fixture, probe: 'p'.repeat(4096), marker: 'm'.repeat(4096) })),
      'Concurrent network command exceeds the aggregate 16 KiB protocol bound.'],
    [Array.from({ length: 12 }, () => ({ ...fixture, marker: 'm'.repeat(1024) })),
      'Concurrent network observation exceeds the aggregate 32 KiB protocol bound.'],
  ] satisfies readonly (readonly [readonly ConcurrentForbiddenFixture[], string])[]) {
    await assert.rejects(runConcurrentSandboxWorkflow({ coordinator, members: [member('a', forbidden), member('b', [])],
      replacement: member('c', []), startMode: 'prepare_both', removalOrder: ['a', 'b'], operationTimeoutMs: 1000 }),
    { name: 'AssertionError', message });
  }
  assert.equal(reservations, 0); assert.equal(coordinatorEffects, 0); assert.deepEqual(coordinator.state, { kind: 'inert' });
});
