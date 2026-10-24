// ------------------------------------------------------------------------------------------------
//                transfer.test.ts - Public streaming transfer validation and actual-work ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileFromBytes, SandboxCleanupError, SandboxOperationError, SandboxStateError, SandboxValidationError } from '../src/index.js';
import type { SandboxTreeEntry, SandboxTreeSource } from '../src/index.js';
import { entryBytes, fixture, gate, nextTurn, processSpec, request } from './fixtures/backend.js';

const bounded = { timeout: 3000 };
const recovery = { kind: 'in_process' as const };
const failure = (error: unknown) => error instanceof SandboxOperationError && error.code === 'driver_failure';
const emptySummary = { files: 0n, directories: 0n, payloadBytes: 0n, archiveBytes: 0n };

async function started(options: Parameters<typeof fixture>[0] = {}) {
  const physical = fixture(options);
  const sandbox = await physical.backend.reserve(request({ cleanupMs: 20 }), recovery).start();
  return { physical, sandbox };
}

function input(byteLength: number, chunks: Iterable<Uint8Array>): SandboxTreeEntry {
  return { kind: 'file', path: 'payload.bin', byteLength, executable: false, open: () => chunks };
}

test('mixed trees stream binary payloads and more than the retired collection ceiling without a logical quota', bounded, async (t) => {
  const { physical, sandbox } = await started();
  t.after(() => sandbox.destroy());
  const payload = Uint8Array.from([0, 255, 17, 128, 0]);
  const summary = await sandbox.importTree({ *[Symbol.iterator]() {
    yield { kind: 'directory' as const, path: 'empty' };
    for (let index = 0; index < 300; index += 1) yield fileFromBytes(`files/${index}`, new Uint8Array());
    yield fileFromBytes('payload.bin', payload, { chunkBytes: 2 });
  } });
  assert.deepEqual(summary, { files: 301n, directories: 1n, payloadBytes: 5n, archiveBytes: 5n });
  assert.deepEqual(Uint8Array.from(physical.files.get('payload.bin') ?? []), payload);
  assert.equal(physical.spillFiles, 0);
  await sandbox.stop();
  let exported = 0;
  let directories = 0;
  const observed = await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
    if (entry.kind === 'directory') { directories += 1; assert.equal(entry.path, 'empty'); return; }
    const bytes = await entryBytes(entry);
    if (entry.path === 'payload.bin') assert.deepEqual(bytes, payload);
    else assert.equal(bytes.byteLength, 0);
    exported += 1;
  }, { quotas: { maxFiles: 301, maxTotalBytes: 5n } });
  assert.deepEqual(observed, summary);
  assert.deepEqual([exported, directories, physical.spillFiles], [301, 1, 0]);
});

test('transfer slot is reserved before a caller iterator getter can reenter the sandbox', bounded, async (t) => {
  const { sandbox } = await started();
  t.after(() => sandbox.destroy());
  let checked = false;
  const source: SandboxTreeSource = {
    get [Symbol.iterator]() {
      assert.throws(() => sandbox.importTree([]), SandboxStateError);
      assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError);
      checked = true;
      return function* () { yield fileFromBytes('entry', Uint8Array.from([3])); };
    },
  };
  const summary = await sandbox.importTree(source);
  assert.equal(checked, true);
  assert.equal(summary.payloadBytes, 1n);
});

for (const [name, source] of [
  ['short body', input(2, [Uint8Array.from([1])])],
  ['long chunk', input(1, [Uint8Array.from([1, 2])])],
  ['extra chunk after declared bytes', input(1, [Uint8Array.from([1]), Uint8Array.from([2])])],
  ['nonempty zero-byte body', input(0, [Uint8Array.from([1])])],
  ['oversized transport chunk', input(65_537, [new Uint8Array(65_537)])],
] as const) {
  test(`import rejects ${name}, fences execution and releases spill resources`, bounded, async () => {
    const { physical, sandbox } = await started();
    try {
      await assert.rejects(sandbox.importTree([source]), failure);
      assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError);
      assert.equal(physical.spillFiles, 0);
    } finally { await sandbox.destroy(); }
    assert.deepEqual([...physical.resources], []);
  });
}

test('metadata accessors and unknown fields are rejected without calling their getters', bounded, async () => {
  for (const candidate of [
    { kind: 'directory' as const, get path(): string { throw new Error('metadata getter ran'); } },
    { kind: 'directory' as const, path: 'safe', extra: true },
  ]) {
    const { physical, sandbox } = await started();
    try {
      await assert.rejects(sandbox.importTree([candidate]), SandboxValidationError);
      assert.equal(physical.files.size, 0);
      assert.equal(physical.spillFiles, 0);
    } finally { await sandbox.destroy(); }
  }
});

test('duplicate and regular-file ancestor selections fail before backend export dispatch', bounded, async () => {
  for (const paths of [['same', 'same'], ['parent/child', 'parent']]) {
    let dispatched = false;
    const { physical, sandbox } = await started({ decorateReady: (ready) => ({ ...ready,
      async exportTree() { dispatched = true; return emptySummary; },
    }) });
    try {
      await sandbox.stop();
      await assert.rejects(sandbox.exportTree({ kind: 'files', paths }, async () => {}));
      assert.equal(dispatched, false);
      assert.equal(physical.spillFiles, 0);
    } finally { await sandbox.destroy(); }
  }
});

test('late duplicate or regular-file ancestor input invalidates the import and fences execution', bounded, async () => {
  for (const paths of [['same', 'same'], ['parent/child', 'parent']]) {
    const { physical, sandbox } = await started();
    try {
      await assert.rejects(sandbox.importTree(paths.map((path) => fileFromBytes(path, Uint8Array.from([1])))));
      assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError);
      assert.equal(physical.spillFiles, 0);
    } finally { await sandbox.destroy(); }
  }
});

test('logical quotas are caller choices normalized before dispatch and independently enforced', bounded, async () => {
  for (const quotas of [{ maxFiles: 0 }, { maxFileBytes: 1n }, { maxTotalBytes: 1 }, { maxArchiveBytes: 1n }]) {
    const { physical, sandbox } = await started();
    try {
      await assert.rejects(sandbox.importTree([input(2, [Uint8Array.from([7, 8])])], { quotas }),
        (error: unknown) => error instanceof SandboxOperationError && error.code === 'input_limit');
      assert.equal(physical.spillFiles, 0);
    } finally { await sandbox.destroy(); }
  }
  const { sandbox } = await started();
  try {
    assert.throws(() => sandbox.importTree([], { quotas: { maxFiles: 1.5 } }), SandboxValidationError);
    await sandbox.stop();
    await assert.rejects(sandbox.exportTree({ kind: 'files', paths: ['a', 'b'] }, async () => {}, { quotas: { maxPaths: 1 } }),
      (error: unknown) => error instanceof SandboxOperationError && error.code === 'output_limit');
  } finally { await sandbox.destroy(); }
});

test('backend success cannot hide incomplete input consumption or a false transfer summary', bounded, async () => {
  for (const mode of ['incomplete', 'summary'] as const) {
    const { sandbox } = await started({ decorateReady: (ready) => ({ ...ready,
      async importTree(entries, options) {
        if (mode === 'incomplete') return emptySummary;
        const summary = await ready.importTree(entries, options);
        return { ...summary, payloadBytes: summary.payloadBytes + 1n };
      },
    }) });
    try {
      await assert.rejects(sandbox.importTree([input(1, [Uint8Array.from([9])])]), failure);
      assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError);
    } finally { await sandbox.destroy(); }
  }
});

test('cancellation starts physical stop while retaining noncooperating source pulls and source return', bounded, async () => {
  const next = gate<IteratorResult<SandboxTreeEntry>>(); const returning = gate(); const entered = gate(); const returnEntered = gate();
  const { physical, sandbox } = await started();
  const controller = new AbortController();
  let nextCalls = 0; let returnCalls = 0;
  const source: SandboxTreeSource = { [Symbol.asyncIterator]() { return {
    next() { nextCalls += 1; entered.resolve(); return next.promise; },
    async return() { returnCalls += 1; returnEntered.resolve(); await returning.promise; return { done: true, value: undefined }; },
  }; } };
  const importing = sandbox.importTree(source, { signal: controller.signal });
  const cancelled = assert.rejects(importing, (error: unknown) => error instanceof SandboxOperationError && error.code === 'cancelled');
  try {
    await entered.promise;
    controller.abort(); await cancelled;
    await physical.stopping.promise;
    await assert.rejects(sandbox.destroy(), SandboxCleanupError);
    assert.deepEqual([...physical.resources], ['storage']);
    next.resolve({ done: false, value: fileFromBytes('late', new Uint8Array()) });
    await returnEntered.promise;
    await assert.rejects(sandbox.destroy(), SandboxCleanupError);
    assert.deepEqual([physical.destroyAttempts, nextCalls, returnCalls], [0, 1, 1]);
    returning.resolve();
    await sandbox.destroy();
    assert.deepEqual([...physical.resources], []);
  } finally { next.resolve({ done: true, value: undefined }); returning.resolve(); await sandbox.destroy(); }
});

for (const value of [undefined, null, false, 0, '']) {
  test(`source and export callback preserve ${String(value)} failures and finish cleanup`, bounded, async () => {
    const { physical, sandbox } = await started();
    try {
      await assert.rejects(sandbox.importTree({ *[Symbol.iterator]() { throw value; } }), (error: unknown) => error === value);
      assert.equal(physical.spillFiles, 0);
      await sandbox.stop();
      physical.files.set('value', Uint8Array.from([1]));
      await assert.rejects(sandbox.exportTree({ kind: 'workspace' }, async () => { throw value; }), (error: unknown) => error === value);
      assert.equal(physical.spillFiles, 0);
    } finally { await sandbox.destroy(); }
  });
}

test('export completion owns noncooperating consumers and their entered body pulls until actual settlement', bounded, async () => {
  const release = gate(); const entered = gate();
  const { physical, sandbox } = await started();
  physical.files.set('value', Uint8Array.from([7]));
  await sandbox.stop();
  const exporting = sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
    assert.equal(entry.kind, 'file');
    if (entry.kind !== 'file') return;
    assert.deepEqual(await entryBytes(entry), Uint8Array.from([7]));
    entered.resolve(); await release.promise;
  });
  const cancelled = assert.rejects(exporting, (error: unknown) => error instanceof SandboxOperationError && error.code === 'cancelled');
  try {
    await entered.promise;
    await assert.rejects(sandbox.destroy(), SandboxCleanupError); await cancelled;
    assert.deepEqual([physical.destroyAttempts, physical.spillFiles], [0, 4]);
    assert.deepEqual([...physical.resources], ['storage']);
    release.resolve(); await sandbox.destroy();
    assert.deepEqual([physical.spillFiles, physical.resources.size], [0, 0]);
  } finally { release.resolve(); await sandbox.destroy(); }
});

test('export frames retire on their last known byte without an EOF-only pull, including empty files', bounded, async () => {
  let pulls = 0; let returns = 0;
  const { sandbox } = await started({ decorateReady: (ready) => ({ ...ready,
    async exportTree(_selection, consume, options) {
      for (const byteLength of [0, 1]) await consume({ kind: 'file', path: `value-${byteLength}`, executable: false, byteLength,
        bytes: { [Symbol.asyncIterator]() { return {
          async next() { pulls += 1; if (pulls > 1) throw new Error('EOF-only pull'); return { done: false, value: Uint8Array.from([42]) }; },
          async return() { returns += 1; return { done: true, value: undefined }; },
        }; } } }, { signal: options.signal });
      return { files: 2n, directories: 0n, payloadBytes: 1n, archiveBytes: 1n };
    },
  }) });
  try {
    await sandbox.stop();
    const lengths: number[] = [];
    await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
      if (entry.kind === 'file') lengths.push((await entryBytes(entry)).byteLength);
    });
    assert.deepEqual([lengths, pulls, returns], [[0, 1], 1, 1]);
  } finally { await sandbox.destroy(); }
});

test('failed source return preserves its exact primary failure and waits for the next owner cleanup before retry', bounded, async () => {
  const primary = new Error('source return failed');
  let returns = 0;
  const { physical, sandbox } = await started({ decorateReady: (ready) => ({ ...ready,
    async exportTree(_selection, consume, options) {
      await consume({ kind: 'file', path: 'value', executable: false, byteLength: 1,
        bytes: { [Symbol.asyncIterator]() { return {
          async next() { return { done: false, value: Uint8Array.from([3]) }; },
          async return() { returns += 1; if (returns === 1) throw primary; return { done: true, value: undefined }; },
        }; } } }, { signal: options.signal });
      return { files: 1n, directories: 0n, payloadBytes: 1n, archiveBytes: 1n };
    },
  }) });
  try {
    await sandbox.stop();
    await assert.rejects(sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
      if (entry.kind === 'file') assert.deepEqual(await entryBytes(entry), Uint8Array.from([3]));
    }), (error: unknown) => error === primary);
    assert.deepEqual([returns, physical.spillFiles, physical.destroyAttempts], [1, 0, 0]);
    assert.throws(() => sandbox.exportTree({ kind: 'workspace' }, async () => {}), SandboxStateError);
    await sandbox.destroy();
    assert.deepEqual([returns, physical.resources.size], [2, 0]);
  } finally { await sandbox.destroy(); }
});

test('cleanup entered before a source return failure joins that attempt and leaves retry to the next cleanup operation', bounded, async () => {
  const next = gate<IteratorResult<SandboxTreeEntry>>(); const entered = gate();
  const primary = new Error('source return failed during destruction');
  let returns = 0;
  const { physical, sandbox } = await started();
  const controller = new AbortController();
  const importing = sandbox.importTree({ [Symbol.asyncIterator]() { return {
    next() { entered.resolve(); return next.promise; },
    async return() { returns += 1; if (returns === 1) throw primary; return { done: true, value: undefined }; },
  }; } }, { signal: controller.signal });
  const cancelled = assert.rejects(importing, (error: unknown) => error instanceof SandboxOperationError && error.code === 'cancelled');
  try {
    await entered.promise;
    controller.abort(); await cancelled;
    const destroyed = sandbox.destroy();
    const retained = assert.rejects(destroyed, SandboxCleanupError);
    next.resolve({ done: false, value: fileFromBytes('late', new Uint8Array()) });
    await retained;
    assert.deepEqual([returns, physical.destroyAttempts, [...physical.resources]], [1, 0, ['storage']]);
    await sandbox.destroy();
    assert.deepEqual([returns, physical.resources.size], [2, 0]);
  } finally { next.resolve({ done: true, value: undefined }); await sandbox.destroy(); }
});

test('bounded body copies use actual byte-array storage without invoking a replacement iterator', bounded, async () => {
  const { physical, sandbox } = await started();
  const chunk = Uint8Array.from([0, 255, 7]);
  Object.defineProperty(chunk, Symbol.iterator, { value() { throw new Error('replacement iterator must not run'); } });
  try {
    const summary = await sandbox.importTree([input(3, [chunk])]);
    assert.equal(summary.payloadBytes, 3n);
    assert.deepEqual(physical.files.get('payload.bin'), Buffer.from([0, 255, 7]));
  } finally { await sandbox.destroy(); }
});

test('swallowed concurrent body pull failures and unawaited export callbacks cannot become success', bounded, async () => {
  for (const mode of ['concurrent-body', 'unawaited-callback'] as const) {
    const release = gate(); const entered = gate();
    const { sandbox } = await started({ decorateReady: (ready) => ({ ...ready,
      async exportTree(_selection, consume, options) {
        const pending = consume({ kind: 'file', path: 'value', executable: false, byteLength: 1,
          bytes: { async *[Symbol.asyncIterator]() { entered.resolve(); await release.promise; yield Uint8Array.from([1]); } } }, { signal: options.signal });
        if (mode === 'concurrent-body') await pending.catch(() => {});
        else { void pending.catch(() => {}); await entered.promise; }
        return { files: 1n, directories: 0n, payloadBytes: 1n, archiveBytes: 1n };
      },
    }) });
    try {
      await sandbox.stop();
      const exported = sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
        if (entry.kind !== 'file') return;
        const iterator = entry.bytes[Symbol.asyncIterator]();
        const first = iterator.next();
        void first.catch(() => {});
        if (mode === 'concurrent-body') await iterator.next().catch(() => {});
        entered.resolve(); await release.promise;
        await first.catch(() => {});
      });
      const rejected = assert.rejects(exported, failure);
      await entered.promise; await nextTurn(); release.resolve(); await rejected;
    } finally { release.resolve(); await sandbox.destroy(); }
  }
});

test('failed spill closure retains a retryable transfer owner before storage destruction', bounded, async () => {
  const { physical, sandbox } = await started({ failFirstSpillClose: true });
  await assert.rejects(sandbox.importTree([]), AggregateError);
  assert.equal(physical.spillFiles, 4);
  assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError);
  await sandbox.destroy();
  assert.deepEqual([physical.spillCloseAttempts, physical.spillFiles, physical.resources.size], [2, 0, 0]);
});
