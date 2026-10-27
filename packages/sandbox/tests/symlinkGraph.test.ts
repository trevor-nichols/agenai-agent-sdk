import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createMetadataLedger, MetadataConflictError } from '../src/files/metadata/index.js';
import type { MetadataRecord } from '../src/files/metadata/index.js';
import { parseSandboxRelativePath, parseSandboxSymlinkTarget, SandboxStateError, SandboxValidationError } from '../src/index.js';
import { createSandboxSpillStore } from '../src/node/index.js';
import { spillDescriptors, spillDirectory } from './fixtures/metadataSpill.js';
import { mapSpillFiles } from './fixtures/metadataSpill.js';
import { gate, nextTurn } from './fixtures/backend.js';

const path = parseSandboxRelativePath;
const link = (member: string, target: string): MetadataRecord => ({ kind: 'symlink', path: path(member), target: parseSandboxSymlinkTarget(target) });
const directory = (member: string): MetadataRecord => ({ kind: 'directory', path: path(member) });
const file = (member: string): MetadataRecord => ({ kind: 'file', path: path(member) });

async function graph(context: TestContext, records: readonly MetadataRecord[]) {
  const root = await spillDirectory(context);
  const ledger = await createMetadataLedger({ openSpill: () => createSandboxSpillStore({ directory: root }), batchBytes: 8192, fanIn: 2 });
  context.after(() => ledger.close());
  for (const record of records) await ledger.append(record);
  return { ledger, root };
}

test('sealed disk graph preserves raw targets, safe parent chains and inert dangling/cyclic links', async (context) => {
  const { ledger, root } = await graph(context, [
    link('tree/chain', 'nested/parent'), link('tree/nested/parent', '../data'), file('tree/data'), directory('tree'), directory('tree/nested'),
    link('tree/raw', './nested//../data'), link('tree/dangling', 'missing/../absent'), link('tree/cycle-a', 'cycle-b'), link('tree/cycle-b', 'cycle-a'),
  ]);
  await ledger.finish(); await ledger.validateSymlinks({ root: path('tree') });
  assert.deepEqual(await ledger.get(path('tree/raw')), { kind: 'symlink', path: 'tree/raw', target: './nested//../data' });
  const targets: Array<readonly [string, string]> = [];
  for await (const record of ledger.records()) if (record.kind === 'symlink') targets.push([record.path, record.target]);
  assert.deepEqual(targets, [['tree/chain', 'nested/parent'], ['tree/cycle-a', 'cycle-b'], ['tree/cycle-b', 'cycle-a'],
    ['tree/dangling', 'missing/../absent'], ['tree/nested/parent', '../data'], ['tree/raw', './nested//../data']]);
  if (process.platform === 'linux') {
    const descriptors = await spillDescriptors(root); assert.equal(descriptors.length, 4);
    assert(descriptors.every(({ links }) => links === 0));
  }
  await ledger.close();
  if (process.platform === 'linux') assert.deepEqual(await spillDescriptors(root), []);
});

test('maximum path and target records survive spill sorting and indexed lookup without rewriting target text', async (context) => {
  const member = `${Array(15).fill('p'.repeat(255)).join('/')}/${'q'.repeat(239)}`;
  const target = `${'../'.repeat(15)}${Array(15).fill('t'.repeat(255)).join('/')}/${'u'.repeat(194)}`;
  assert.equal(Buffer.byteLength(member), 4079); assert.equal(Buffer.byteLength(target), 4079);
  const { ledger } = await graph(context, [link(member, target), file('last'), link('short', './last')]);
  await ledger.finish(); await ledger.validateSymlinks();
  assert.deepEqual(await ledger.get(path(member)), { kind: 'symlink', path: member, target });
  assert.deepEqual(await ledger.get(path('short')), { kind: 'symlink', path: 'short', target: './last' });
});

test('complete namespace validation rejects aliases used as member parents and duplicate type collisions', async (context) => {
  for (const [records, code] of [
    [[link('alias', 'destination'), file('alias/child')], 'symlink_ancestor'],
    [[directory('same'), link('same', 'target')], 'duplicate_path'],
  ] as const) {
    const { ledger } = await graph(context, records);
    await assert.rejects(ledger.finish(), (error: unknown) => error instanceof MetadataConflictError && error.code === code);
    assert.throws(() => ledger.records(), SandboxStateError);
  }
});

test('resolution checks chain expansion and missing suffixes rather than lexical target text alone', async (context) => {
  for (const records of [
    [link('entry', 'base/dir/alias/..'), directory('base'), directory('base/dir'), link('base/dir/alias', '../..')],
    [link('entry', 'missing/../..')],
    [file('ordinary'), link('entry', 'ordinary/..')],
  ]) {
    const { ledger } = await graph(context, records);
    await ledger.finish();
    await assert.rejects(ledger.validateSymlinks(), SandboxValidationError);
    assert.throws(() => ledger.records(), SandboxStateError);
  }
});

test('subtree publication can reject a link that is confined in the complete workspace', async (context) => {
  const records = [directory('selected'), link('selected/alias', '../outside')];
  const full = await graph(context, records); await full.ledger.finish(); await full.ledger.validateSymlinks();
  assert.deepEqual(await full.ledger.get(path('selected/alias')), { kind: 'symlink', path: 'selected/alias', target: '../outside' });
  const subtree = await graph(context, records); await subtree.ledger.finish();
  await assert.rejects(subtree.ledger.validateSymlinks({ root: path('selected') }), SandboxValidationError);
});

test('resolution has a forty-expansion working bound while an exact repeated state terminates as an inert cycle', async (context) => {
  for (const length of [40, 41]) {
    const records: MetadataRecord[] = [];
    for (let index = 0; index < length; index++) records.push(link(`link-${index}`, index + 1 === length ? 'absent' : `link-${index + 1}`));
    const { ledger } = await graph(context, records); await ledger.finish();
    if (length === 40) {
      await ledger.validateSymlinks(); assert.deepEqual(await ledger.get(path('link-0')), { kind: 'symlink', path: 'link-0', target: 'link-1' });
    } else await assert.rejects(ledger.validateSymlinks(), SandboxValidationError);
  }
  const growing = await graph(context, [link('loop', 'loop/child')]); await growing.ledger.finish();
  await assert.rejects(growing.ledger.validateSymlinks(), SandboxValidationError);
});

test('graph close retains an entered noncooperating read before releasing its anonymous spill files', { timeout: 3000 }, async (context) => {
  const root = await spillDirectory(context); const store = await createSandboxSpillStore({ directory: root });
  const entered = gate(); const release = gate(); let armed = false;
  const wrapped = mapSpillFiles(store, (file) => ({ ...file, read: async (...args) => {
    if (armed) { armed = false; entered.resolve(); await release.promise; }
    return file.read(...args);
  }, write: (...args) => file.write(...args), truncate: (size) => file.truncate(size), close: () => file.close() }));
  const ledger = await createMetadataLedger({ openSpill: async () => wrapped, batchBytes: 8192, fanIn: 2 });
  context.after(async () => { release.resolve(); await ledger.close(); });
  await ledger.append(link('alias', './absent')); await ledger.finish();
  assert.deepEqual(await ledger.get(path('alias')), { kind: 'symlink', path: 'alias', target: './absent' });
  armed = true;
  const validating = ledger.validateSymlinks(); const rejected = assert.rejects(validating);
  await entered.promise;
  let closed = false; const closing = ledger.close().then(() => { closed = true; }); await nextTurn();
  assert.equal(closed, false);
  if (process.platform === 'linux') assert.equal((await spillDescriptors(root)).length, 4);
  await assert.rejects(ledger.get(path('alias')), SandboxStateError);
  release.resolve(); await rejected; await closing;
  assert.equal(closed, true);
  if (process.platform === 'linux') assert.deepEqual(await spillDescriptors(root), []);
});
