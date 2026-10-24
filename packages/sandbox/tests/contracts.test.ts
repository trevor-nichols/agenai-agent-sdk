// ------------------------------------------------------------------------------------------------
//                contracts.test.ts - Public immutable-input and finite admission behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SANDBOX_DEFAULT_STREAM_LIMITS,
  SANDBOX_DEFAULT_TRANSFER_BUFFERS,
  SandboxValidationError,
  parseSandboxGuestPath,
  parseSandboxId,
  parseSandboxNamespace,
  parseSandboxProcessExit,
  parseSandboxProcessSpec,
  parseSandboxRelativePath,
  parseSandboxRequest,
  parseSandboxSupport,
} from '../src/index.js';

function request() {
  return {
    policy: {
      resources: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 256 },
      temporaryStorage: { homeBytes: 1024 ** 2, tempBytes: 2 * 1024 ** 2 },
      network: { kind: 'isolated' },
      deadlines: { startupMs: 10, cleanupMs: 30 },
      transfers: { ...SANDBOX_DEFAULT_TRANSFER_BUFFERS },
      streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS },
    },
  };
}

test('request parsing returns isolated immutable policy and admits explicit small deadlines', () => {
  const input = request();
  const parsed = parseSandboxRequest(input);
  input.policy.resources.cpus = 99;
  input.policy.deadlines.startupMs = 600_000;
  assert.deepEqual(parsed.policy.resources, { cpus: 2, memoryBytes: 4_294_967_296, pids: 256 });
  assert.deepEqual(parsed.policy.deadlines, { startupMs: 10, cleanupMs: 30 });
  assert.equal(Reflect.set(parsed.policy.resources, 'cpus', 3), false);
  assert.equal(parsed.policy.resources.cpus, 2);
});

test('request admission rejects unsupported authority, retired policy and invalid buffer bounds', () => {
  const base = request();
  const invalid = [
    { ...base, namespace: 'another-caller' },
    { ...base, mounts: ['/'] },
    { policy: { ...base.policy, independentProcessTermination: true } },
    { policy: { ...base.policy, resources: { ...base.policy.resources, workspaceDiskBytes: 1000 } } },
    { policy: { ...base.policy, network: { kind: 'outbound', allowlist: ['example.com'] } } },
    { policy: { ...base.policy, resources: { ...base.policy.resources, cpus: Number.POSITIVE_INFINITY } } },
    { policy: { ...base.policy, deadlines: { ...base.policy.deadlines, cleanupMs: 0 } } },
    { policy: { ...base.policy, deadlines: { ...base.policy.deadlines, startupMs: 60_001 } } },
    { policy: { ...base.policy, transfers: { ...base.policy.transfers, maxFiles: 257 } } },
    { policy: { ...base.policy, transfers: { ...base.policy.transfers, chunkBytes: 65_537 } } },
    { policy: { ...base.policy, transfers: { ...base.policy.transfers, metadataMergeFanIn: 1 } } },
    { policy: { ...base.policy, deadlines: { ...base.policy.deadlines, operationMs: 300_000 } } },
    { policy: { ...base.policy, streams: { ...base.policy.streams, maxBufferedInputBytes: 1 } } },
  ];
  for (const candidate of invalid) assert.throws(() => parseSandboxRequest(candidate), SandboxValidationError);
});

test('resource sizing and optional traffic quotas remain separate from bounded working memory', () => {
  const base = request();
  const policy = parseSandboxRequest({ policy: {
    ...base.policy,
    temporaryStorage: { homeBytes: 2 * 1024 ** 3, tempBytes: 4 * 1024 ** 3 },
    streams: { ...base.policy.streams, maxStdinBytes: Number.MAX_SAFE_INTEGER, maxOutputBytes: 0 },
  } }).policy;
  assert.deepEqual(policy.temporaryStorage, { homeBytes: 2_147_483_648, tempBytes: 4_294_967_296 });
  assert.equal(policy.streams.maxStdinBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(policy.streams.maxOutputBytes, 0);
  const ordinary = parseSandboxRequest(base).policy;
  assert.equal(ordinary.streams.maxStdinBytes, undefined);
  assert.equal(ordinary.streams.maxOutputBytes, undefined);
  assert.equal(ordinary.streams.maxBufferedInputBytes, 8 * 1024 ** 2);
  assert.equal(ordinary.streams.maxBufferedOutputBytes, 8 * 1024 ** 2);
});

test('workspace disk quota is an optional explicit allocated-block requirement without an SDK size ceiling', () => {
  const base = request();
  assert.deepEqual(parseSandboxRequest(base).policy.workspaceDiskQuota, { kind: 'not_requested' });
  assert.deepEqual(parseSandboxRequest({ policy: { ...base.policy, workspaceDiskQuota: { kind: 'not_requested' } } }).policy.workspaceDiskQuota,
    { kind: 'not_requested' });
  const requirement = { kind: 'required', bytes: Number.MAX_SAFE_INTEGER, accounting: 'allocated_blocks' };
  const parsed = parseSandboxRequest({ policy: { ...base.policy, workspaceDiskQuota: requirement } });
  requirement.bytes = 1;
  assert.deepEqual(parsed.policy.workspaceDiskQuota, { kind: 'required', bytes: Number.MAX_SAFE_INTEGER, accounting: 'allocated_blocks' });
  assert.equal(Reflect.set(parsed.policy.workspaceDiskQuota, 'bytes', 2), false);
  for (const workspaceDiskQuota of [
    null, false, 1024, { kind: 'not_requested', bytes: 1 },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, 1n].map((bytes) => ({ kind: 'required', bytes, accounting: 'allocated_blocks' })),
    { kind: 'required', bytes: 1 }, { kind: 'required', bytes: 1, accounting: 'logical_bytes' },
  ]) assert.throws(() => parseSandboxRequest({ policy: { ...base.policy, workspaceDiskQuota } }), SandboxValidationError);
});

test('plain identity strings grant only parsed identity values and reject ambiguous names', () => {
  assert.equal(parseSandboxNamespace('caller-17'), 'caller-17');
  assert.equal(parseSandboxId('operation-19'), 'operation-19');
  for (const unsafe of ['', 'two names', 'slash/name', 'back\\name', 'x\0y', 'é'.repeat(33)]) {
    assert.throws(() => parseSandboxNamespace(unsafe), SandboxValidationError);
  }
  assert.throws(() => parseSandboxSupport({
    backendId: 'engine', backendRevision: '1', networkModes: ['isolated'],
    workspaceDiskQuota: true, networkAllowlist: false, independentProcessTermination: false,
  }), SandboxValidationError);
});

test('path parsing preserves canonical Unicode and rejects traversal and UTF-8 overflow', () => {
  assert.equal(parseSandboxRelativePath('src/λ.ts'), 'src/λ.ts');
  assert.equal(parseSandboxGuestPath('/workspace/work'), '/workspace/work');
  for (const unsafe of ['', '/absolute', '../escape', 'a/../b', '.', 'a/./b', 'a//b', 'a/', 'a\\b', 'a\0b', 'a\nb', 'é'.repeat(128), Array(65).fill('a').join('/'), '\ud800']) {
    assert.throws(() => parseSandboxRelativePath(unsafe), SandboxValidationError);
  }
  for (const unsafe of ['relative', '//workspace', '/workspace/../host', '/workspace/']) {
    assert.throws(() => parseSandboxGuestPath(unsafe), SandboxValidationError);
  }
});

test('process recipes copy explicit environment and arguments and reject inherited or unsafe inputs', () => {
  const input = { executable: '/usr/bin/agent', cwd: '/workspace/work', args: ['--stdio'], env: { FIXTURE: 'explicit' } };
  const recipe = parseSandboxProcessSpec(input);
  input.args[0] = '--changed';
  input.env.FIXTURE = 'changed';
  assert.deepEqual(recipe, { executable: '/usr/bin/agent', cwd: '/workspace/work', args: ['--stdio'], env: { FIXTURE: 'explicit' } });
  for (const candidate of [
    { ...input, executable: 'agent' },
    { ...input, args: ['bad\0argument'] },
    { ...input, args: Array(129).fill('a') },
    { ...input, env: { TOKEN: 'é'.repeat(8193) } },
    { ...input, env: { 'INVALID=NAME': 'value' } },
    { ...input, inheritEnv: true },
    { ...input, env: Object.create({ PARENT: 'not-owned' }) },
  ]) assert.throws(() => parseSandboxProcessSpec(candidate), SandboxValidationError);
});

test('leader exit receipts distinguish observed status from a receipt lost during sandbox stop', () => {
  assert.deepEqual(parseSandboxProcessExit({ kind: 'exited', code: 7 }), { kind: 'exited', code: 7 });
  assert.deepEqual(parseSandboxProcessExit({ kind: 'signaled', signal: 'SIGTERM' }), { kind: 'signaled', signal: 'SIGTERM' });
  assert.deepEqual(parseSandboxProcessExit({ kind: 'unavailable', reason: 'sandbox_stopped' }), { kind: 'unavailable', reason: 'sandbox_stopped' });
  for (const input of [
    { kind: 'unavailable', reason: 'transport_failure' },
    { kind: 'unavailable', reason: 'sandbox_stopped', code: 0 },
    { kind: 'exited', code: -1 },
    { kind: 'signaled', signal: 'unknown' },
  ]) assert.throws(() => parseSandboxProcessExit(input), SandboxValidationError);
});

test('data boundaries reject getters, symbol fields and cycles without invoking getters', () => {
  let getterCalls = 0;
  const withGetter = { get policy() { getterCalls += 1; return request().policy; } };
  const withSymbol = { ...request(), [Symbol('authority')]: 'secret' };
  const cyclic: Record<string, unknown> = request();
  cyclic.self = cyclic;
  const withPrototypeKey: unknown = Object.assign(JSON.parse('{"__proto__":{"authority":"injected"}}'), request());
  for (const input of [withGetter, withSymbol, cyclic, withPrototypeKey]) assert.throws(() => parseSandboxRequest(input), SandboxValidationError);
  assert.equal(getterCalls, 0);
});
