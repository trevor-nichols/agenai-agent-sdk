// ------------------------------------------------------------------------------------------------
//                run.test.ts - Consumer-visible bounds, lifecycle truth and cleanup ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { createSandboxClaudeRun, type ClaudeSdk } from '../index.js';
import { fixture, request, sdkFixture } from './fixture.js';

async function attached(physical: ReturnType<typeof fixture>, sdk: ReturnType<typeof sdkFixture>) {
  await physical.started; assert(sdk.child);
  const observed = once(sdk.child.stdout, 'readable'); physical.stdout.push(Buffer.from('attached\n')); await observed;
}

test('closed configuration rejects host callbacks, ambient options and malformed data before SDK or process entry', { timeout: 2000 }, async () => {
  const physical = fixture(); const sdk = sdkFixture(); const sandbox = await physical.owner.start();
  let getterCalls = 0;
  const secret = 'synthetic-secret-must-not-appear-in-validation';
  const malformed = [
    ...['hooks', 'canUseTool', 'mcpServers', 'plugins', 'skills', 'settings', 'sessionStore', 'env', 'extraArgs', 'cwd', 'spawnClaudeCodeProcess', 'stderr'].map((key) => ({ ...request, [key]: () => {} })),
    { ...request, tools: ['Read', 'Read'] }, { ...request, tools: ['Agent'] }, { ...request, maxTurns: 0 },
    { ...request, guestExecutable: '/tmp/controller.mjs' }, { ...request, model: 'model\n--extra' },
    { ...request, prompt: '\u0000'.repeat(6000) }, { ...request, [Symbol('hidden')]: true },
    Object.defineProperty({ ...request }, 'hooks', { value: [], enumerable: false }),
    Object.defineProperty({ ...request }, 'prompt', { enumerable: true, get() { getterCalls++; return 'untrusted'; } }),
    ...[undefined, null, {}, { kind: 'oauth_token', value: secret }, { kind: 'api_key' },
      { kind: 'api_key', value: secret, token: secret }, { kind: 'api_key', value: secret, env: { ANTHROPIC_API_KEY: secret } },
      { kind: 'api_key', value: secret, [Symbol('hidden')]: secret },
      Object.defineProperty({ kind: 'api_key', value: secret }, 'token', { value: secret, enumerable: false }),
      Object.defineProperty({ kind: 'api_key' }, 'value', { enumerable: true, get() { getterCalls++; return secret; } }),
      ...['', `${secret}\u0000`, `${secret}\r`, `${secret}\n`, '\ud800', 'é'.repeat(4096) + 'a', 1]
        .map((value) => ({ kind: 'api_key', value })),
    ].map((credential) => ({ ...request, credential })),
  ];
  try {
    for (const input of malformed) assert.throws(() => Reflect.apply(createSandboxClaudeRun, undefined, [sdk.sdk, sandbox, input]), (error: unknown) => {
      assert(error instanceof TypeError); assert(!String(error).includes(secret)); return true;
    });
    assert.equal(getterCalls, 0); assert.equal(sdk.calls, 0); assert.equal(physical.processCalls, 0);
    assert.deepEqual([...physical.resources], ['compute', 'storage']);
  } finally { await physical.owner.destroy(); }
});

test('the explicit key is captured before SDK entry and reaches the reserved guest environment unchanged', { timeout: 2000 }, async () => {
  for (const value of [' synthetic-claude-key-preserves-spaces ', 'é'.repeat(4096)]) {
    const physical = fixture(); const sandbox = await physical.owner.start();
    const credential = { kind: 'api_key' as const, value };
    const supplied = { ...request, credential };
    const fixtureSdk = sdkFixture((child, options) => {
      assert.equal(options.env?.ANTHROPIC_API_KEY, value); child.stdin.end();
    });
    const sdk: ClaudeSdk = { query(input) {
      credential.value = 'caller-mutation-after-boundary';
      supplied.credential = { kind: 'api_key', value: 'caller-replacement-after-boundary' };
      return fixtureSdk.sdk.query(input);
    } };
    const run = createSandboxClaudeRun(sdk, sandbox, supplied);
    try {
      for await (const _message of run.messages) { /* keep the sole reader active through settlement */ }
      assert.equal(physical.specification?.env.ANTHROPIC_API_KEY, value);
      assert.equal(physical.specification?.env.HOME, '/home/sandbox');
      assert.equal(physical.specification?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(physical.specification?.env.OPENAI_API_KEY, undefined);
      assert.equal(physical.processCalls, 1);
      assert.deepEqual(await run.settled, { kind: 'receipt', receipt: { kind: 'exited', code: 7 } });
    } finally { await run.cleanup(); await physical.owner.destroy(); }
  }
});

test('restricted HTTPS must admit the Anthropic API and the SDK passes the relay variables to the guest', { timeout: 2000 }, async () => {
  const restricted = fixture({ network: { kind: 'restricted_https', destinations: [{ hostname: 'api.anthropic.com', port: 443 }] } });
  const run = createSandboxClaudeRun(sdkFixture((child) => { child.stdin.end(); }).sdk, await restricted.owner.start(), request);
  try {
    for await (const _message of run.messages) { /* keep the sole reader active through settlement */ }
    const env = restricted.specification?.env;
    assert.equal(env?.HTTPS_PROXY, 'http://127.0.0.1:3128'); assert.equal(env?.NO_PROXY, '127.0.0.1,localhost');
    assert.equal(env?.ANTHROPIC_API_KEY, request.credential.value);
  } finally { await run.cleanup(); await restricted.owner.destroy(); }
  const unrelated = fixture({ network: { kind: 'restricted_https', destinations: [{ hostname: 'unrelated.example.com', port: 443 }] } });
  try {
    const sandbox = await unrelated.owner.start();
    assert.throws(() => createSandboxClaudeRun(sdkFixture().sdk, sandbox, request), (error: unknown) => error instanceof TypeError
      && error.message === 'The sandbox restricted HTTPS policy does not admit the Anthropic API.');
    assert.equal(unrelated.processCalls, 0);
  } finally { await unrelated.owner.destroy(); }
});

test('exact spawn admission refuses changed command, argv and undeclared controller environment without disclosing values', { timeout: 2000 }, async () => {
  for (const change of [
    (input: SpawnOptions) => ({ ...input, command: '/usr/bin/controller' }),
    (input: SpawnOptions) => ({ ...input, args: [...input.args, '--plugin-dir', '/host'] }),
    (input: SpawnOptions) => ({ ...input, env: { ...input.env, PRIVATE_HOST_TOKEN: 'must-never-be-printed' } }),
    (input: SpawnOptions) => ({ ...input, env: { ...input.env, ANTHROPIC_API_KEY: 'must-never-be-printed' } }),
    (input: SpawnOptions) => ({ ...input, env: { ...input.env, CLAUDE_CODE_OAUTH_TOKEN: 'must-never-be-printed' } }),
  ]) {
    const physical = fixture(); const sandbox = await physical.owner.start(); const sdk = sdkFixture(undefined, change);
    try {
      const run = createSandboxClaudeRun(sdk.sdk, sandbox, request);
      const result = await run.settled; assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') {
        assert(!String(result.error).includes('must-never-be-printed'));
        assert(!String(result.error).includes(request.credential.value));
      }
      assert.equal(physical.processCalls, 0); assert.throws(() => run.messages[Symbol.asyncIterator]()); await run.cleanup();
    } finally { await physical.owner.destroy(); }
  }
});

test('synchronous bounded input and EOF preserve binary output, stderr and exactly one observed numeric exit', { timeout: 2000 }, async () => {
  const start = Promise.withResolvers<void>(); const physical = fixture({ startGate: start.promise, echo: true });
  const sandbox = await physical.owner.start(); let backpressure = true;
  const expected = Buffer.alloc(32 * 1024, 0xa5);
  const sdk = sdkFixture((child) => { backpressure = child.stdin.write(expected); child.stdin.end(); });
  const run = createSandboxClaudeRun(sdk.sdk, sandbox, request);
  physical.stderr.push(Buffer.from([0, 255, 10]));
  const reading = (async () => { for await (const _message of run.messages) { /* sole native reader */ } })();
  try {
    assert.equal(backpressure, false); start.resolve(); await reading;
    assert.equal(physical.owner.state.kind, 'ready');
    assert.deepEqual([...physical.resources], ['compute', 'storage']);
    await run.cleanup();
    assert.equal(physical.owner.state.kind, 'stopped');
    assert.deepEqual(Buffer.concat(physical.received), expected); assert.deepEqual(Buffer.concat(sdk.bytes), expected);
    assert.deepEqual(run.stderr, Buffer.from([0, 255, 10]));
    assert.deepEqual(await run.settled, { kind: 'receipt', receipt: { kind: 'exited', code: 7 } });
    assert.deepEqual(sdk.events, [{ kind: 'exit', code: 7, signal: null }]); assert.equal(sdk.child?.exitCode, 7);
    assert.equal(sdk.child?.kill('SIGTERM'), false); assert.deepEqual([...physical.resources], ['storage']);
  } finally { start.resolve(); await run.cleanup(); await physical.owner.destroy(); }
});

test('end payload cannot bypass the 64 KiB pre-start staging bound and retains the original overflow failure', { timeout: 2000 }, async () => {
  const physical = fixture(); const sandbox = await physical.owner.start(); let callbacks = 0;
  const sdk = sdkFixture((child) => {
    child.stdin.write(Buffer.alloc(32 * 1024));
    child.stdin.end(Buffer.alloc(40 * 1024), (error?: Error | null) => { callbacks++; assert(error); });
  });
  const run = createSandboxClaudeRun(sdk.sdk, sandbox, request);
  try {
    const result = await run.settled; await run.cleanup();
    assert.equal(result.kind, 'failed'); if (result.kind === 'failed') assert.match(result.error.message, /input staging exceeded 64 KiB/u);
    assert.equal(callbacks, 1); assert.equal(Buffer.concat(physical.received).length, 0);
    assert.equal(sdk.events.filter(({ kind }) => kind === 'error').length, 1); assert.equal(sdk.events.filter(({ kind }) => kind === 'exit').length, 0);
    assert.equal(sdk.child?.exitCode, null); assert.deepEqual([...physical.resources], ['storage']);
  } finally { await run.cleanup(); await physical.owner.destroy(); }
});

test('destroying paused native output settles the blocked pump and stops the whole workload', { timeout: 2000 }, async () => {
  const physical = fixture({ finishOnEof: false }); const sandbox = await physical.owner.start(); const sdk = sdkFixture();
  const run = createSandboxClaudeRun(sdk.sdk, sandbox, request);
  try {
    await physical.started; assert(sdk.child);
    const readable = once(sdk.child.stdout, 'readable'); physical.stdout.push(Buffer.alloc(64 * 1024)); await readable;
    sdk.child.stdout.destroy();
    const result = await run.settled; assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.match(result.error.message, /consumer closed/u);
    await run.cleanup(); assert.deepEqual([...physical.resources], ['storage']); assert.equal(sdk.events.filter(({ kind }) => kind === 'exit').length, 0);
  } finally { await run.cleanup(); await physical.owner.destroy(); }
});

test('kill acknowledges teardown dispatch once and forced stop never fabricates a native code or signal', { timeout: 2000 }, async () => {
  const physical = fixture({ finishOnEof: false }); const sandbox = await physical.owner.start(); const sdk = sdkFixture();
  const run = createSandboxClaudeRun(sdk.sdk, sandbox, request);
  try {
    await attached(physical, sdk); assert(sdk.child);
    assert.equal(sdk.child.kill('SIGINT'), false); assert.equal(sdk.child.kill('SIGTERM'), true); assert.equal(sdk.child.kill('SIGKILL'), false);
    const result = await run.settled; assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.deepEqual(result.receipt, { kind: 'unavailable', reason: 'sandbox_stopped' });
    assert.equal(sdk.child.exitCode, null); assert.equal(sdk.child.signalCode, null); assert.equal(sdk.child.killed, true);
    assert.equal(sdk.events.filter(({ kind }) => kind === 'error').length, 1); assert.equal(sdk.events.filter(({ kind }) => kind === 'exit').length, 0);
    await run.cleanup(); assert.deepEqual([...physical.resources], ['storage']);
  } finally { await run.cleanup(); await physical.owner.destroy(); }
});

test('caller cancellation after observed activity closes the query and joins its sole reader and workload', { timeout: 2000 }, async () => {
  const physical = fixture({ finishOnEof: false }); const sandbox = await physical.owner.start(); const sdk = sdkFixture();
  const controller = new AbortController(); const run = createSandboxClaudeRun(sdk.sdk, sandbox, { ...request, signal: controller.signal });
  const activity = Promise.withResolvers<void>();
  const reading = (async () => { try { for await (const _message of run.messages) activity.resolve(); } catch { /* native stop error is expected */ } })();
  try {
    await physical.started; physical.stdout.push(Buffer.from('actual controlled guest activity\n')); await activity.promise;
    controller.abort(new Error('caller cancellation')); await run.cleanup(); await reading;
    assert.equal(sdk.closed, true); assert.equal(physical.stopAttempts, 1); assert.deepEqual([...physical.resources], ['storage']);
    assert.throws(() => run.messages[Symbol.asyncIterator](), /one reader/u);
  } finally { await run.cleanup(); await physical.owner.destroy(); }
});

test('cleanup failure retains this run for explicit retry and cannot claim process settlement before physical stop', { timeout: 2000 }, async () => {
  const physical = fixture({ firstStopFails: true, finishOnEof: false }); const sandbox = await physical.owner.start(); const sdk = sdkFixture();
  const run = createSandboxClaudeRun(sdk.sdk, sandbox, request);
  try {
    await attached(physical, sdk); let settled = false; void run.settled.then(() => { settled = true; });
    await assert.rejects(run.cleanup(), AggregateError); await setImmediate();
    assert.equal(settled, false); assert.deepEqual([...physical.resources], ['compute', 'storage']);
    await run.cleanup(); assert.equal(physical.stopAttempts, 2); assert.deepEqual([...physical.resources], ['storage']);
    assert.equal((await run.settled).kind, 'failed');
  } finally { await run.cleanup(); await physical.owner.destroy(); }
});

test('one reader cannot queue concurrent pulls and cleanup retires an unadvanced iterator', { timeout: 2000 }, async () => {
  for (const advance of [false, true]) {
    const physical = fixture({ finishOnEof: false }); const sandbox = await physical.owner.start(); const sdk = sdkFixture();
    const run = createSandboxClaudeRun(sdk.sdk, sandbox, request);
    try {
      const reader = run.messages[Symbol.asyncIterator]();
      const pending = advance ? reader.next().catch(() => ({ done: true })) : undefined;
      if (advance) await assert.rejects(reader.next(), /one outstanding read/u);
      await run.cleanup(); await pending;
      assert.deepEqual([...physical.resources], ['storage']); assert.equal(sdk.closed, true);
    } finally { await run.cleanup(); await physical.owner.destroy(); }
  }
});

test('stdout frame exhaustion stops native production before the supplied SDK can accumulate unbounded messages', { timeout: 2000 }, async () => {
  const physical = fixture({ finishOnEof: false }); const sandbox = await physical.owner.start(); const sdk = sdkFixture();
  const run = createSandboxClaudeRun(sdk.sdk, sandbox, request);
  try {
    await attached(physical, sdk); physical.stdout.push(Buffer.from('\n'.repeat(4096)));
    const result = await run.settled; assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.match(result.error.message, /byte or frame bound/u);
    await run.cleanup(); assert.deepEqual([...physical.resources], ['storage']);
  } finally { await run.cleanup(); await physical.owner.destroy(); }
});

test('stderr exhaustion keeps only observed diagnostic bytes and joins whole-workload cleanup', { timeout: 2000 }, async () => {
  const physical = fixture({ finishOnEof: false }); const sandbox = await physical.owner.start(); const sdk = sdkFixture();
  const run = createSandboxClaudeRun(sdk.sdk, sandbox, request);
  try {
    await attached(physical, sdk);
    for (let index = 0; index < 16; index++) {
      physical.stderr.push(Buffer.alloc(64 * 1024, 0xa5));
      for (let attempt = 0; run.stderr.byteLength < (index + 1) * 64 * 1024 && attempt < 20; attempt++) await setImmediate();
      assert.equal(run.stderr.byteLength, (index + 1) * 64 * 1024);
    }
    physical.stderr.push(Buffer.from([0xff]));
    const result = await run.settled; assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.match(result.error.message, /stderr exceeded 1 MiB/u);
    assert.deepEqual(run.stderr, Buffer.alloc(1024 * 1024, 0xa5));
    await run.cleanup(); assert.deepEqual([...physical.resources], ['storage']);
  } finally { await run.cleanup(); await physical.owner.destroy(); }
});
