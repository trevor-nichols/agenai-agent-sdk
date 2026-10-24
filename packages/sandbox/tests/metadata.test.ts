// ------------------------------------------------------------------------------------------------
//                metadata.test.ts - Sealed metadata behavior, bounded spill and joined failures
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { SandboxStateError } from '../src/errors.js';
import { createMetadataLedger, MetadataCleanupError, MetadataConflictError } from '../src/files/metadata/index.js';
import type { MetadataLedger, MetadataRecord } from '../src/files/metadata/index.js';
import { createSandboxSpillStore } from '../src/node/index.js';
import { mapSpillFiles, record, spillDescriptors, spillDirectory } from './fixtures/metadataSpill.js';

async function collect(ledger: MetadataLedger): Promise<readonly MetadataRecord[]> {
  const result: MetadataRecord[] = [];
  for await (const value of ledger.records()) result.push(value);
  return result;
}

test('unordered Unicode metadata seals in component order and supports sequential exclusive replay', async (t) => {
  const directory = await spillDirectory(t);
  const ledger = await createMetadataLedger({ openSpill: () => createSandboxSpillStore({ directory }), batchBytes: 1030, fanIn: 2 });
  t.after(() => ledger.close());
  for (const path of ['é/β', 'a-else', 'a/z', 'a', 'é', 'é', 'a/é', 'a/😀']) {
    await ledger.append(record(path, path === 'a' || path === 'é' ? 'directory' : 'file'));
  }
  assert.throws(() => ledger.records(), SandboxStateError);
  await ledger.finish();
  const expected = ['a', 'a/z', 'a/é', 'a/😀', 'a-else', 'é', 'é', 'é/β']
    .map((path) => record(path, path === 'a' || path === 'é' ? 'directory' : 'file'));
  const iterator = ledger.records()[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: record('a', 'directory') });
  assert.throws(() => ledger.records(), SandboxStateError);
  assert.ok(iterator.return);
  await iterator.return();
  const replay = ledger.records()[Symbol.asyncIterator]();
  await iterator.return();
  assert.throws(() => ledger.records(), SandboxStateError);
  assert.deepEqual(await replay.next(), { done: false, value: record('a', 'directory') });
  assert.ok(replay.return);
  await replay.return();
  assert.deepEqual(await collect(ledger), expected);
  assert.deepEqual(await collect(ledger), expected);
  await assert.rejects(ledger.append(record('late')), SandboxStateError);
  await assert.rejects(ledger.finish(), SandboxStateError);
  if (process.platform === 'linux') {
    const handles = await spillDescriptors(directory);
    assert.equal(handles.length, 4);
    assert(handles.every((value) => value.links === 0 && value.target.endsWith(' (deleted)')));
  }
  await ledger.close();
  await ledger.close();
  assert.deepEqual(await readdir(directory), []);
  if (process.platform === 'linux') assert.deepEqual(await spillDescriptors(directory), []);
});

test('20,017 reverse records survive bounded batches and repeated fan-in merges using four native files', { timeout: 60_000 }, async (t) => {
  const directory = await spillDirectory(t);
  const store = await createSandboxSpillStore({ directory });
  let created = 0;
  const wrapped = mapSpillFiles(store, (file) => { created += 1; return file; });
  const ledger = await createMetadataLedger({ openSpill: async () => wrapped, batchBytes: 4096, fanIn: 4 });
  t.after(() => ledger.close());
  for (let index = 20_016; index >= 0; index -= 1) await ledger.append(record(`tree/${String(index).padStart(6, '0')}`));
  await ledger.finish();
  let next = 0;
  for await (const actual of ledger.records()) {
    assert.deepEqual(actual, record(`tree/${String(next).padStart(6, '0')}`));
    next += 1;
  }
  assert.equal(next, 20_017);
  assert.equal(created, 4);
  await ledger.close();
  if (process.platform === 'linux') assert.deepEqual(await spillDescriptors(directory), []);
});

for (const [code, initial, last, path] of [
  ['duplicate_path', record('a', 'directory'), record('a'), 'a'],
  ['file_ancestor', record('a/child'), record('a'), 'a/child'],
] as const) {
  test(`${code} discovered after streamed appends rejects sealing across separate sort runs`, async (t) => {
    const directory = await spillDirectory(t);
    const ledger = await createMetadataLedger({ openSpill: () => createSandboxSpillStore({ directory }), batchBytes: 1030, fanIn: 2 });
    t.after(() => ledger.close());
    await ledger.append(initial);
    for (let index = 0; index < 200; index += 1) await ledger.append(record(`a-else/${index}`));
    await ledger.append(last);
    await assert.rejects(ledger.finish(), (error: unknown) => error instanceof MetadataConflictError && error.code === code && error.path === path);
    assert.throws(() => ledger.records(), SandboxStateError);
    await ledger.close();
    assert.deepEqual(await readdir(directory), []);
    if (process.platform === 'linux') assert.deepEqual(await spillDescriptors(directory), []);
  });
}

test('partial backend reads and writes preserve exact metadata records', async (t) => {
  const directory = await spillDirectory(t);
  const store = await createSandboxSpillStore({ directory });
  const partial = mapSpillFiles(store, (file) => ({
    read: (buffer, offset, length, position) => file.read(buffer, offset, Math.min(2, length), position),
    write: (buffer, offset, length, position) => file.write(buffer, offset, Math.min(2, length), position),
    truncate: (size) => file.truncate(size), close: () => file.close(),
  }));
  const ledger = await createMetadataLedger({ openSpill: async () => partial, batchBytes: 1030, fanIn: 2 });
  t.after(() => ledger.close());
  for (const path of ['λ/β', 'λ', 'a']) await ledger.append(record(path, path === 'λ' ? 'directory' : 'file'));
  await ledger.finish();
  assert.deepEqual(await collect(ledger), [record('a'), record('λ', 'directory'), record('λ/β')]);
});

test('close retains an entered noncooperating spill write and rejects overlapping operations', { timeout: 3000 }, async (t) => {
  const directory = await spillDirectory(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const store = await createSandboxSpillStore({ directory });
  const wrapped = mapSpillFiles(store, (file, index) => ({
    read: (...args) => file.read(...args),
    async write(...args) {
      if (index === 0) { entered.resolve(); await release.promise; }
      return file.write(...args);
    },
    truncate: (size) => file.truncate(size), close: () => file.close(),
  }));
  const ledger = await createMetadataLedger({ openSpill: async () => wrapped, batchBytes: 1030, fanIn: 2 });
  t.after(async () => { release.resolve(); await ledger.close(); });
  await ledger.append(record('one'));
  const sealing = ledger.finish();
  const rejected = assert.rejects(sealing, SandboxStateError);
  await entered.promise;
  await assert.rejects(ledger.append(record('overlap')), SandboxStateError);
  await assert.rejects(ledger.finish(), SandboxStateError);
  let closed = false;
  const cleanup = ledger.close().then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false);
  if (process.platform === 'linux') assert.equal((await spillDescriptors(directory)).length, 4);
  release.resolve();
  await rejected;
  await cleanup;
  assert.equal(closed, true);
  if (process.platform === 'linux') assert.deepEqual(await spillDescriptors(directory), []);
});

test('cancellation retains late store acquisition and closes the acquired owner before rejection', { timeout: 3000 }, async (t) => {
  const directory = await spillDirectory(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  const reason = new Error('caller stopped metadata');
  const store = await createSandboxSpillStore({ directory });
  const opening = createMetadataLedger({ async openSpill() { entered.resolve(); await release.promise; return store; },
    batchBytes: 1030, fanIn: 2, signal: abort.signal });
  let settled = false;
  void opening.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(opening, (error: unknown) => error === reason);
  await entered.promise;
  abort.abort(reason);
  await nextTurn();
  assert.equal(settled, false);
  release.resolve();
  await rejected;
  assert.throws(() => store.createFile(), SandboxStateError);
});

test('failed acquisition cleanup retains real file ownership and exact primary error for retry', async (t) => {
  const directory = await spillDirectory(t);
  const store = await createSandboxSpillStore({ directory });
  t.after(() => store.close());
  const primary = new Error('third file unavailable');
  const cleanup = new Error('native cleanup temporarily unavailable');
  let creates = 0;
  let closes = 0;
  let retained: MetadataCleanupError | undefined;
  await assert.rejects(createMetadataLedger({ openSpill: async () => ({
    createFile() { creates += 1; if (creates === 3) return Promise.reject(primary); return store.createFile(); },
    close() { closes += 1; if (closes === 1) return Promise.reject(cleanup); return store.close(); },
  }), batchBytes: 1030, fanIn: 2 }), (error: unknown) => {
    assert.ok(error instanceof MetadataCleanupError);
    retained = error;
    assert.equal(error.primaryError, primary);
    assert.equal(error.cleanupError, cleanup);
    return true;
  });
  if (process.platform === 'linux') assert.equal((await spillDescriptors(directory)).length, 2);
  assert.ok(retained);
  await retained.retryCleanup();
  await retained.retryCleanup();
  assert.equal(retained.primaryError, primary);
  assert.equal(retained.cleanupError, cleanup);
  if (process.platform === 'linux') assert.deepEqual(await spillDescriptors(directory), []);
});
