import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandboxBackend } from '../src/backend/index.js';
import type { SandboxDriverReadWriteFiles } from '../src/backend/index.js';
import { parseSandboxRelativePath, parseSandboxRequest, SandboxCleanupError, SandboxOperationError, SandboxStartError,
  SandboxStateError, SandboxUnsupportedError, SandboxValidationError } from '../src/index.js';
import type { Sandbox, SandboxFileEntry, SandboxLivePath } from '../src/index.js';
import { fixture, gate, nextTurn, request } from './fixtures/backend.js';
import type { FixtureOptions } from './fixtures/backend.js';

const recovery = { kind: 'in_process' as const };
const bounded = { timeout: 3000 };
function metadata(path: SandboxLivePath, length = 3): SandboxFileEntry {
  return { kind: path === '.' ? 'directory' : 'file', path, byteLength: length, permissions: 0o644 };
}

function liveFixture(overrides: Partial<Omit<SandboxDriverReadWriteFiles, 'kind'>> = {}, options: FixtureOptions = {}) {
  const physical = fixture({ ...options, decorateReady: (ready) => ({ ...ready,
    effective: { ...ready.effective, files: { kind: 'read_write' } }, files: port,
  }) });
  const port: SandboxDriverReadWriteFiles = {
    kind: 'read_write',
    async stat(path) {
      const bytes = physical.files.get(path);
      return path === '.' || bytes !== undefined ? { kind: 'completed', entry: metadata(path, bytes?.byteLength ?? 0) } : { kind: 'missing' };
    },
    async list(path, consume, operation) {
      let entries = 0n;
      for (const [name, bytes] of physical.files) {
        if (path !== '.' && !name.startsWith(`${path}/`)) continue;
        if ((path === '.' ? name : name.slice(path.length + 1)).includes('/')) continue;
        if (operation.quotas.maxEntries !== undefined && entries >= operation.quotas.maxEntries) return { kind: 'rejected', reason: 'quota_exceeded', entries };
        await consume(metadata(parseSandboxRelativePath(name), bytes.byteLength), { signal: operation.signal });
        entries += 1n;
      }
      return { kind: 'completed', entries };
    },
    async readFile(path, consume, operation) {
      const payload = physical.files.get(path);
      if (!payload) return { kind: 'missing', bytes: 0n };
      let bytes = 0n;
      let limited = false;
      await consume({ entry: { ...metadata(path, payload.byteLength), kind: 'file' }, chunks: { async *[Symbol.asyncIterator]() {
        for (let offset = 0; offset < payload.byteLength; offset += operation.chunkBytes) {
          operation.signal.throwIfAborted();
          const chunk = payload.subarray(offset, offset + operation.chunkBytes);
          if (operation.quotas.maxBytes !== undefined && bytes + BigInt(chunk.byteLength) > operation.quotas.maxBytes) { limited = true; return; }
          bytes += BigInt(chunk.byteLength);
          yield chunk;
        }
      } } }, { signal: operation.signal });
      return limited ? { kind: 'rejected', reason: 'quota_exceeded', bytes } : { kind: 'completed', bytes };
    },
    async writeFile(path, source, operation) {
      if (operation.mode === 'create' && physical.files.has(path)) return { kind: 'rejected', reason: 'already_exists', effect: 'none', bytes: 0n };
      let bytes = 0n;
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) {
        operation.signal.throwIfAborted();
        if (operation.quotas.maxBytes !== undefined && bytes + BigInt(chunk.byteLength) > operation.quotas.maxBytes) return { kind: 'rejected', reason: 'quota_exceeded', effect: 'none', bytes };
        chunks.push(chunk);
        bytes += BigInt(chunk.byteLength);
      }
      physical.files.set(path, Buffer.concat(chunks));
      return { kind: 'completed', effect: 'published', bytes, permissions: 0o644 };
    },
    ...overrides,
  };
  const backend = createSandboxBackend({ ...physical.driver, support: { ...physical.driver.support, files: { read: true, write: true } } });
  const owner = backend.reserve({ policy: { ...request({ cleanupMs: 20 }).policy, files: { kind: 'read_write' } } }, recovery);
  return Object.assign(physical, { owner, port, backend });
}

function writable(sandbox: Sandbox) {
  assert.equal(sandbox.files.kind, 'read_write');
  if (sandbox.files.kind !== 'read_write') throw new Error('Fixture expected write authority.');
  return sandbox.files;
}

test('live authority defaults disabled and unsupported requests reject before inert reservation', bounded, async () => {
  for (const files of [{ kind: 'enabled' }, { kind: 'disabled', write: true }, { kind: 'read_only', paths: ['allowed'] }, null]) {
    assert.throws(() => parseSandboxRequest({ policy: { ...request().policy, files } }), SandboxValidationError);
  }
  const physical = fixture();
  let reservations = 0;
  const backend = createSandboxBackend({ ...physical.driver, reserve(input) { reservations++; return physical.driver.reserve(input); } });
  for (const kind of ['read_only', 'read_write'] as const) {
    assert.throws(() => backend.reserve({ policy: { ...request().policy, files: { kind } } }, recovery), SandboxUnsupportedError);
  }
  assert.equal(reservations, 0);
  const owner = backend.reserve(request(), recovery);
  const sandbox = await owner.start();
  assert.deepEqual(sandbox.files, { kind: 'disabled' });
  assert.deepEqual(sandbox.effective.files, { kind: 'disabled' });
  await sandbox.importTree([{ kind: 'directory', path: 'ordinary' }]);
  assert.equal(physical.importCount, 1);
  await owner.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('malformed or incomplete backend output cannot become a successful public live result', bounded, async () => {
  const cases: readonly Readonly<{ name: string; port: Partial<Omit<SandboxDriverReadWriteFiles, 'kind'>>; operation: 'stat' | 'list' | 'read' | 'write' }>[] = [
    { name: 'stat path substitution', operation: 'stat', port: { async stat() { return { kind: 'completed', entry: metadata(parseSandboxRelativePath('other')) }; } } },
    { name: 'nested listing child', operation: 'list', port: { async list(_path, consume, options) {
      await consume(metadata(parseSandboxRelativePath('child/nested')), { signal: options.signal }); return { kind: 'completed', entries: 1n };
    } } },
    { name: 'false listing counter', operation: 'list', port: { async list() { return { kind: 'completed', entries: 1n }; } } },
    { name: 'read completion without callback', operation: 'read', port: { async readFile() { return { kind: 'completed', bytes: 0n }; } } },
    { name: 'short complete read', operation: 'read', port: { async readFile(path, consume, options) {
      await consume({ entry: { ...metadata(path, 3), kind: 'file' }, chunks: { async *[Symbol.asyncIterator]() { yield Uint8Array.of(1); } } }, { signal: options.signal });
      return { kind: 'completed', bytes: 1n };
    } } },
    { name: 'oversized read chunk', operation: 'read', port: { async readFile(path, consume, options) {
      await consume({ entry: { ...metadata(path, 65_537), kind: 'file' }, chunks: { async *[Symbol.asyncIterator]() { yield new Uint8Array(65_537); } } }, { signal: options.signal });
      return { kind: 'completed', bytes: 65_537n };
    } } },
    { name: 'published unconsumed write', operation: 'write', port: { async writeFile() { return { kind: 'completed', effect: 'published', permissions: 0o644, bytes: 0n }; } } },
    { name: 'false write byte count', operation: 'write', port: { async writeFile(_path, source) {
      for await (const _chunk of source) { /* Physical sink accepts the bounded source. */ }
      return { kind: 'completed', effect: 'published', permissions: 0o644, bytes: 2n };
    } } },
  ];
  for (const scenario of cases) {
    const physical = liveFixture(scenario.port); const files = writable(await physical.owner.start());
    const operation = scenario.operation === 'stat' ? files.stat('selected') : scenario.operation === 'list' ? files.list('.', async () => {})
      : scenario.operation === 'read' ? files.readFile('selected', async ({ chunks }) => { for await (const _chunk of chunks) { /* Drain the actual callback stream. */ } })
      : files.writeFile('selected', [Uint8Array.of(8)], { mode: 'create' });
    await assert.rejects(operation, (error: unknown) => error instanceof SandboxOperationError, scenario.name);
    assert.throws(() => files.stat('.'), SandboxStateError, scenario.name);
    await physical.owner.destroy();
    assert.deepEqual([...physical.resources], [], scenario.name);
  }
});

test('swallowed concurrent pulls remain failures and unawaited callbacks retain the owner until joined', bounded, async () => {
  const physical = liveFixture(); physical.files.set('one', Uint8Array.of(7));
  const files = writable(await physical.owner.start());
  await assert.rejects(files.readFile('one', async ({ chunks }) => {
    const iterator = chunks[Symbol.asyncIterator]();
    const first = iterator.next();
    await assert.rejects(iterator.next(), /Concurrent/);
    await first.catch(() => {});
  }), SandboxOperationError);
  await physical.owner.destroy();
  const entered = gate(); const release = gate();
  const second = liveFixture({ async list(_path, consume, options) {
    void consume(metadata(parseSandboxRelativePath('held')), { signal: options.signal }).catch(() => {});
    return { kind: 'completed', entries: 1n };
  } });
  const secondFiles = writable(await second.owner.start());
  const listing = secondFiles.list('.', async () => { entered.resolve(); await release.promise; });
  const rejected = assert.rejects(listing, /before its live callback settled/);
  await entered.promise;
  await assert.rejects(second.owner.destroy(), SandboxCleanupError);
  assert.equal(second.destroyAttempts, 0);
  release.resolve(); await rejected;
  await second.owner.destroy();
  assert.deepEqual([...second.resources], []);
});

test('arbitrary callback failures survive retirement and source cleanup failure retains retry ownership', bounded, async () => {
  const physical = liveFixture(); physical.files.set('one', Uint8Array.of(1));
  const files = writable(await physical.owner.start());
  await assert.rejects(files.readFile('one', async () => { throw false; }), (error: unknown) => error === false);
  await physical.owner.destroy();
  let allowReturn = false; let returns = 0;
  const returnFailure = new Error('source return unavailable');
  const source = { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { return {
    async next() { return { done: false, value: Uint8Array.of(1) }; },
    async return() { returns++; if (!allowReturn) throw returnFailure; return { done: true, value: undefined }; },
  }; } };
  const second = liveFixture({ async writeFile(_path, chunks) {
    const iterator = Symbol.asyncIterator in chunks ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
    assert.deepEqual(await iterator.next(), { done: false, value: Uint8Array.of(1) });
    return { kind: 'uncertain', effect: 'unknown', bytes: null };
  } });
  const secondFiles = writable(await second.owner.start());
  await assert.rejects(secondFiles.writeFile('unsettled', source, { mode: 'replace' }), (error: unknown) => error === returnFailure);
  await assert.rejects(second.owner.destroy(), SandboxCleanupError);
  assert.deepEqual([...second.resources], ['storage']); assert.equal(second.destroyAttempts, 0);
  assert(returns >= 1);
  allowReturn = true;
  await second.owner.destroy();
  assert.deepEqual([...second.resources], []);
});

test('effective grant and acquired port must exactly match requested read-only authority', bounded, async () => {
  for (const variant of ['valid', 'missing', 'stronger', 'effective'] as const) {
    const port = liveFixture().port;
    const physical = fixture({ decorateReady: (ready) => ({ ...ready,
      effective: { ...ready.effective, files: { kind: variant === 'effective' ? 'disabled' : 'read_only' } },
      ...(variant === 'missing' ? {} : { files: variant === 'stronger' ? port : { ...port, kind: 'read_only' as const } }),
    }) });
    const backend = createSandboxBackend({ ...physical.driver, support: { ...physical.driver.support, files: { read: true, write: false } } });
    assert.throws(() => backend.reserve({ policy: { ...request().policy, files: { kind: 'read_write' } } }, recovery), SandboxUnsupportedError);
    const owner = backend.reserve({ policy: { ...request().policy, files: { kind: 'read_only' } } }, recovery);
    if (variant === 'valid') {
      const sandbox = await owner.start();
      assert.equal(sandbox.files.kind, 'read_only');
      assert.equal(Object.hasOwn(sandbox.files, 'writeFile'), false);
      if (sandbox.files.kind === 'read_only') assert.deepEqual(await sandbox.files.stat('.'), { kind: 'completed', entry: metadata('.', 0) });
    } else await assert.rejects(owner.start(), SandboxStartError);
    await owner.destroy();
    assert.deepEqual([...physical.resources], []);
  }
});

test('stat/list/read/write settle exact binary bytes and sequential callbacks before publishing completion', bounded, async () => {
  const physical = liveFixture();
  const sandbox = await physical.owner.start();
  const files = writable(sandbox);
  const payload = Uint8Array.of(0, 255, 7);
  assert.deepEqual(await files.writeFile('one.bin', [payload], { mode: 'create' }), { kind: 'completed', effect: 'published', bytes: 3n, permissions: 0o644 });
  assert.deepEqual(physical.files.get('one.bin'), Buffer.from([0, 255, 7]));
  assert.deepEqual(await files.stat('one.bin'), { kind: 'completed', entry: metadata(parseSandboxRelativePath('one.bin')) });
  assert.deepEqual(await files.stat('missing'), { kind: 'missing' });
  assert.deepEqual(await files.writeFile('one.bin', [Uint8Array.of(99)], { mode: 'create' }), { kind: 'rejected', reason: 'already_exists', effect: 'none', bytes: 0n });
  const listed: string[] = [];
  const gateEntry = gate(); const continueEntry = gate();
  const listing = files.list('.', async (entry) => { listed.push(entry.path); gateEntry.resolve(); await continueEntry.promise; });
  await gateEntry.promise;
  assert.throws(() => files.stat('.'), SandboxStateError);
  assert.deepEqual(listed, ['one.bin']);
  continueEntry.resolve();
  assert.deepEqual(await listing, { kind: 'completed', entries: 1n });
  let escaped: AsyncIterator<Uint8Array> | undefined;
  const read = await files.readFile('one.bin', async ({ entry, chunks }) => {
    assert.deepEqual(entry, metadata(parseSandboxRelativePath('one.bin')));
    escaped = chunks[Symbol.asyncIterator]();
    const first = await escaped.next();
    assert.deepEqual(first, { done: false, value: Uint8Array.of(0, 255, 7) });
    if (!first.done) first.value[0] = 42;
    assert.deepEqual(await escaped.next(), { done: true, value: undefined });
  });
  assert.deepEqual(read, { kind: 'completed', bytes: 3n });
  assert.deepEqual(physical.files.get('one.bin'), Buffer.from([0, 255, 7]));
  assert(escaped);
  await assert.rejects(escaped.next(), /retired/);
  assert.deepEqual(await files.writeFile('one.bin', [Uint8Array.of(9, 8)], { mode: 'replace' }), { kind: 'completed', effect: 'published', bytes: 2n, permissions: 0o644 });
  await sandbox.stop();
  assert.throws(() => files.stat('.'), SandboxStateError);
  const final: number[] = [];
  await sandbox.exportTree({ kind: 'files', paths: ['one.bin'] }, async (entry) => {
    if (entry.kind === 'file') for await (const chunk of entry.bytes) final.push(...chunk);
  });
  assert.deepEqual(final, [9, 8]);
  await physical.owner.destroy();
});

test('caller quotas return exact partial counters without publishing an over-quota write', bounded, async () => {
  const physical = liveFixture();
  physical.files.set('one', Uint8Array.of(1, 2, 3)); physical.files.set('two', Uint8Array.of(4));
  const files = writable(await physical.owner.start());
  const names: string[] = [];
  assert.deepEqual(await files.list('.', async (entry) => { names.push(entry.path); }, { quotas: { maxEntries: 1 } }), { kind: 'rejected', reason: 'quota_exceeded', entries: 1n });
  assert.deepEqual(names, ['one']);
  assert.deepEqual(await files.readFile('one', async ({ chunks }) => { for await (const chunk of chunks) assert.fail(`Unexpected bytes ${chunk}`); }, { quotas: { maxBytes: 2n } }),
    { kind: 'rejected', reason: 'quota_exceeded', bytes: 0n });
  assert.deepEqual(await files.writeFile('new', [Uint8Array.of(5), Uint8Array.of(6, 7)], { mode: 'create', quotas: { maxBytes: 2 } }),
    { kind: 'rejected', reason: 'quota_exceeded', effect: 'none', bytes: 1n });
  assert.equal(physical.files.has('new'), false);
  assert.deepEqual(await files.writeFile('new', [Uint8Array.of(8)], { mode: 'create' }), { kind: 'completed', effect: 'published', bytes: 1n, permissions: 0o644 });
  await physical.owner.destroy();
});

test('changed and missing reads retain their terminal truth and callback exit retires an incomplete stream', bounded, async () => {
  for (const outcome of ['changed', 'missing', 'callback'] as const) {
    let returned = 0;
    const physical = liveFixture({ async readFile(path, consume, options) {
      if (outcome === 'missing') return { kind: 'missing', bytes: 0n };
      await consume({ entry: { ...metadata(path, 5), kind: 'file' }, chunks: { [Symbol.asyncIterator]() {
        let used = false;
        return { async next() { if (used) return { done: true, value: undefined }; used = true; return { done: false, value: Uint8Array.of(2, 4) }; },
          async return() { returned++; return { done: true, value: undefined }; } };
      } } }, { signal: options.signal });
      return { kind: 'changed', bytes: outcome === 'callback' ? 0n : 2n };
    } });
    const files = writable(await physical.owner.start());
    const bytes: number[] = [];
    const result = await files.readFile('changing', async ({ chunks }) => {
      if (outcome !== 'callback') for await (const chunk of chunks) bytes.push(...chunk);
    });
    assert.deepEqual(result, outcome === 'callback' ? { kind: 'cancelled', reason: 'callback_closed', bytes: 0n }
      : outcome === 'changed' ? { kind: 'changed', bytes: 2n } : { kind: 'missing', bytes: 0n });
    assert.deepEqual(bytes, outcome === 'changed' ? [2, 4] : []);
    assert.equal(returned, 0); // No iterator is acquired when its callback never pulls.
    await physical.owner.destroy();
  }
});

test('invalid paths, callback fields and write modes fail before driver or source entry', bounded, async () => {
  let dispatched = 0; let sourceEntries = 0;
  const physical = liveFixture({ async stat() { dispatched++; return { kind: 'missing' }; },
    async writeFile() { dispatched++; return { kind: 'missing', effect: 'none', bytes: 0n }; } });
  const files = writable(await physical.owner.start());
  const source = { [Symbol.iterator]() { sourceEntries++; return [Uint8Array.of(1)][Symbol.iterator](); } };
  for (const path of ['../outside', '/absolute', 'a//b', 'a/./b', '\ud800']) assert.throws(() => files.stat(path), SandboxValidationError);
  for (const options of [{ mode: 'append' }, { mode: 'create', permissions: 0o777 }, { mode: 'replace', quotas: { maxBytes: -1 } }, { mode: 'create', deadlineAt: 'tomorrow' }]) {
    // @ts-expect-error Runtime boundary rejects untyped caller input.
    assert.throws(() => files.writeFile('valid', source, options), SandboxValidationError);
  }
  assert.throws(() => files.readFile('.', async () => {}), SandboxValidationError);
  assert.equal(dispatched, 0); assert.equal(sourceEntries, 0);
  assert.deepEqual(await files.stat('valid'), { kind: 'missing' });
  assert.equal(dispatched, 1);
  await physical.owner.destroy();
});

test('uncertain and renamed-parent publications keep their receipts while synchronously stopping new mutations', bounded, async () => {
  for (const kind of ['uncertain', 'changed'] as const) {
    let writes = 0;
    const physical = liveFixture({ async writeFile(_path, source) {
      writes++;
      for await (const chunk of source) assert.deepEqual(chunk, Uint8Array.of(9));
      return kind === 'uncertain' ? { kind, effect: 'unknown', bytes: 1n } : { kind, effect: 'published', bytes: 1n, permissions: 0o751 };
    } });
    const files = writable(await physical.owner.start());
    assert.deepEqual(await files.writeFile('result', [Uint8Array.of(9)], { mode: 'replace' }),
      kind === 'uncertain' ? { kind, effect: 'unknown', bytes: 1n } : { kind, effect: 'published', bytes: 1n, permissions: 0o751 });
    assert.throws(() => files.writeFile('result', [Uint8Array.of(7)], { mode: 'replace' }), SandboxStateError);
    assert.equal(writes, 1);
    await physical.owner.stop();
    assert.deepEqual([...physical.resources], ['storage']);
    await physical.owner.destroy();
  }
});

test('abort fences immediately, starts physical shutdown and retains a noncooperating callback until cleanup retry', bounded, async () => {
  const entered = gate(); const release = gate();
  const physical = liveFixture(); physical.files.set('held', Uint8Array.of(5));
  const files = writable(await physical.owner.start());
  const controller = new AbortController();
  const reading = files.readFile('held', async ({ chunks }) => {
    const iterator = chunks[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { done: false, value: Uint8Array.of(5) });
    entered.resolve(); await release.promise;
  }, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  assert.throws(() => files.stat('.'), SandboxStateError);
  assert.deepEqual(await reading, { kind: 'cancelled', reason: 'signal', bytes: 1n });
  await physical.stopping.promise;
  await assert.rejects(physical.owner.destroy(), (error: unknown) => error instanceof SandboxCleanupError && error.owner === physical.owner);
  assert.deepEqual([...physical.resources], ['storage']); assert.equal(physical.destroyAttempts, 0);
  release.resolve();
  await physical.owner.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('cancelled writes with a pending source retain unknown effects and prevent stopped export until the source joins', bounded, async () => {
  const pulling = gate(); const release = gate<IteratorResult<Uint8Array>>();
  let returned = 0;
  const physical = liveFixture(); const sandbox = await physical.owner.start(); const files = writable(sandbox);
  const source = { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { return { next() { pulling.resolve(); return release.promise; }, async return() { returned++; return { done: true, value: undefined }; } }; } };
  const abort = new AbortController();
  const writing = files.writeFile('pending', source, { mode: 'create', signal: abort.signal });
  await pulling.promise; abort.abort();
  assert.deepEqual(await writing, { kind: 'cancelled', reason: 'signal', effect: 'unknown', bytes: null });
  await assert.rejects(physical.owner.stop(), SandboxCleanupError);
  assert.throws(() => sandbox.exportTree({ kind: 'workspace' }, async () => {}), SandboxStateError);
  assert.equal(physical.files.has('pending'), false);
  release.resolve({ done: true, value: undefined });
  await physical.owner.stop();
  assert.equal(returned, 0); // The joined source actually ended; no redundant return is needed.
  const result = await sandbox.exportTree({ kind: 'workspace' }, async () => {});
  assert.deepEqual(result, { files: 0n, directories: 0n, symlinks: 0n, payloadBytes: 0n, archiveBytes: 0n });
  await physical.owner.destroy();
});

test('live operations have no implicit timer, while an explicit deadline owns cancellation and physical cleanup', bounded, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  context.mock.method(Date, 'now', () => now);
  context.mock.method(performance, 'now', () => now);
  const entered = gate(); const release = gate();
  const physical = liveFixture({ async stat() { entered.resolve(); await release.promise; return { kind: 'missing' }; } });
  const files = writable(await physical.owner.start());
  const stat = files.stat('later');
  await entered.promise;
  now += 10 * 86400_000; context.mock.timers.tick(10 * 86400_000); await nextTurn();
  assert.equal(physical.owner.state.kind, 'ready'); assert.equal(physical.stopAttempts, 0);
  release.resolve(); assert.deepEqual(await stat, { kind: 'missing' });
  await physical.owner.destroy();
  const pending = gate(); const finish = gate();
  const timed = liveFixture({ async stat() { pending.resolve(); await finish.promise; return { kind: 'missing' }; } });
  const timedFiles = writable(await timed.owner.start());
  const operation = timedFiles.stat('deadline', { deadlineAt: new Date(now + 10).toISOString() });
  await pending.promise; now += 10; context.mock.timers.tick(10); await nextTurn();
  assert.deepEqual(await operation, { kind: 'cancelled', reason: 'deadline' });
  assert.equal(timed.stopAttempts, 1);
  finish.resolve(); await timed.owner.destroy();
  assert.deepEqual([...timed.resources], []);
});
