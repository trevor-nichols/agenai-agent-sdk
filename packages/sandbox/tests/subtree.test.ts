// ------------------------------------------------------------------------------------------------
//                subtree.test.ts - Single-root coverage and existing streaming ownership boundaries
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { SandboxDriverReady } from '../src/backend/contracts.js';
import { fileFromBytes, SandboxCleanupError, SandboxOperationError, SandboxValidationError } from '../src/index.js';
import type { SandboxExportConsumer, SandboxExportEntry } from '../src/index.js';
import { MetadataConflictError } from '../src/files/metadata/index.js';
import { entryBytes, fixture, gate, nextTurn, request } from './fixtures/backend.js';

const recovery = { kind: 'in_process' as const };
const root = 'reports/selected';
const directory: SandboxExportEntry = { kind: 'directory', path: root };

function file(path: string, bytes = Uint8Array.of(23)): Extract<SandboxExportEntry, { kind: 'file' }> {
  return { kind: 'file', path, byteLength: bytes.byteLength, executable: false,
    bytes: { async *[Symbol.asyncIterator]() { yield bytes; } } };
}

function emit(entries: readonly SandboxExportEntry[]): SandboxDriverReady['exportTree'] {
  return async (_selection, consume, options) => {
    let files = 0n; let directories = 0n; let symlinks = 0n; let payloadBytes = 0n;
    for (const entry of entries) {
      await consume(entry, { signal: options.signal });
      if (entry.kind === 'directory') directories += 1n;
      else if (entry.kind === 'symlink') symlinks += 1n;
      else { files += 1n; payloadBytes += BigInt(entry.byteLength); }
    }
    return { files, directories, symlinks, payloadBytes, archiveBytes: payloadBytes };
  };
}

async function started(t: TestContext, exportTree?: SandboxDriverReady['exportTree']) {
  const physical = fixture(exportTree ? { decorateReady: (ready) => ({ ...ready, exportTree }) } : {});
  const sandbox = await physical.backend.reserve(request({ cleanupMs: 20 }), recovery).start();
  t.after(() => sandbox.destroy());
  return { physical, sandbox };
}

test('subtree selection preserves the workspace-relative root and all selected descendants', async (t) => {
  const { physical, sandbox } = await started(t);
  await sandbox.importTree([
    { kind: 'directory', path: root }, { kind: 'directory', path: `${root}/nested` },
    { kind: 'directory', path: `${root}/empty` }, fileFromBytes(`${root}/nested/result.bin`, Uint8Array.of(0, 255, 7)),
    fileFromBytes('reports/selected-other/outside.bin', Uint8Array.of(99)), fileFromBytes('unrelated', Uint8Array.of(88)),
  ]);
  await sandbox.stop();
  const observed: Array<{ kind: string; path: string; bytes?: number[] }> = [];
  const summary = await sandbox.exportTree({ kind: 'subtree', path: root }, async (entry) => {
    if (entry.kind === 'symlink') assert.fail('Default subtree export cannot expose links.');
    observed.push(entry.kind === 'directory' ? entry : { kind: entry.kind, path: entry.path, bytes: [...await entryBytes(entry)] });
  }, { quotas: { maxPaths: 1, maxFiles: 1, maxTotalBytes: 3 } });
  assert.deepEqual(observed.sort((left, right) => left.path.localeCompare(right.path)), [
    { kind: 'directory', path: root }, { kind: 'directory', path: `${root}/empty` },
    { kind: 'directory', path: `${root}/nested` }, { kind: 'file', path: `${root}/nested/result.bin`, bytes: [0, 255, 7] },
  ]);
  assert.deepEqual(summary, { files: 1n, directories: 3n, symlinks: 0n, payloadBytes: 3n, archiveBytes: 3n });
  assert.equal(physical.spillFiles, 0);
});

test('an empty subtree requires its root directory and counts one selected path before dispatch', async (t) => {
  let dispatches = 0;
  const { sandbox } = await started(t, async (selection, consume, options) => {
    dispatches += 1;
    assert.deepEqual(selection, { kind: 'subtree', path: root });
    return emit([directory])(selection, consume, options);
  });
  await sandbox.stop();
  await assert.rejects(sandbox.exportTree({ kind: 'subtree', path: root }, async () => {}, { quotas: { maxPaths: 0 } }),
    (error: unknown) => error instanceof SandboxOperationError && error.code === 'output_limit');
  assert.equal(dispatches, 0);
  const paths: string[] = [];
  const summary = await sandbox.exportTree({ kind: 'subtree', path: root }, async (entry) => { paths.push(entry.path); }, { quotas: { maxPaths: 1 } });
  assert.deepEqual(paths, [root]);
  assert.deepEqual(summary, { files: 0n, directories: 1n, symlinks: 0n, payloadBytes: 0n, archiveBytes: 0n });
  assert.equal(dispatches, 1);
});

test('invalid subtree roots and mixed selector fields fail before export acquisition without invoking accessors', async (t) => {
  let dispatches = 0;
  let getters = 0;
  const { sandbox, physical } = await started(t, async (...args) => { dispatches += 1; return emit([directory])(...args); });
  await sandbox.stop();
  for (const candidate of [
    { kind: 'subtree', path: '../outside' }, { kind: 'subtree', path: '/absolute' },
    { kind: 'subtree', path: 'reports//selected' }, { kind: 'subtree', path: `${root}/` },
    { kind: 'subtree', path: root, paths: [root] }, { kind: 'subtree', paths: [root] },
    { kind: 'workspace', path: root }, { kind: 'files', paths: [root], path: root },
    { kind: 'subtree', get path() { getters += 1; return root; } },
  ]) {
    await assert.rejects(async () => { await Reflect.apply(sandbox.exportTree, sandbox, [candidate, async () => {}]); },
      (error: unknown) => error instanceof SandboxValidationError || (error instanceof SandboxOperationError && error.code === 'input_limit'));
  }
  assert.deepEqual([dispatches, getters, physical.spillFiles], [0, 0, 0]);
  assert.deepEqual(await sandbox.exportTree({ kind: 'subtree', path: root }, async () => {}),
    { files: 0n, directories: 1n, symlinks: 0n, payloadBytes: 0n, archiveBytes: 0n });
  assert.equal(dispatches, 1);
});

for (const [name, path, kind] of [
  ['unrelated file', 'unrelated/secret', 'file'], ['lookalike sibling', 'reports/selected-other/secret', 'file'],
  ['ancestor directory', 'reports', 'directory'], ['stripped root', 'selected', 'directory'],
  ['file at selected root', root, 'file'],
] as const) {
  test(`${name} is rejected before consumer or body exposure`, async (t) => {
    let bodies = 0;
    let callbacks = 0;
    const entry: SandboxExportEntry = kind === 'directory' ? { kind, path } : { kind, path, byteLength: 1, executable: false,
      bytes: { async *[Symbol.asyncIterator]() { bodies += 1; yield Uint8Array.of(7); } } };
    const { sandbox, physical } = await started(t, emit([entry]));
    await sandbox.stop();
    await assert.rejects(sandbox.exportTree({ kind: 'subtree', path: root }, async () => { callbacks += 1; }),
      (error: unknown) => error instanceof SandboxOperationError && error.code === 'driver_failure');
    assert.deepEqual([callbacks, bodies, physical.spillFiles], [0, 0, 0]);
  });
}

for (const [name, entries, count, expected] of [
  ['missing root', [file(`${root}/result`)], 1, 'missing'],
  ['missing empty root', [], 0, 'missing'],
  ['duplicate root', [directory, directory], 2, 'duplicate_path'],
  ['duplicate descendant', [directory, file(`${root}/same`), file(`${root}/same`)], 3, 'duplicate_path'],
  ['regular-file ancestor', [directory, file(`${root}/file`), file(`${root}/file/child`)], 3, 'file_ancestor'],
] as const) {
  test(`${name} invalidates provisional callbacks at final validation`, async (t) => {
    const { sandbox, physical } = await started(t, emit(entries));
    await sandbox.stop();
    let callbacks = 0;
    await assert.rejects(sandbox.exportTree({ kind: 'subtree', path: root }, async (entry) => {
      callbacks += 1;
      if (entry.kind === 'file') await entryBytes(entry);
    }), (error: unknown) => expected === 'missing'
      ? error instanceof SandboxOperationError && error.code === 'driver_failure' && error.message.includes('omitted')
      : error instanceof MetadataConflictError && error.code === expected);
    assert.equal(callbacks, count);
    assert.equal(physical.spillFiles, 0);
  });
}

test('descendants before their root remain provisional and successful callback scope retires once complete', async (t) => {
  let retained: SandboxExportConsumer | undefined;
  const { sandbox, physical } = await started(t, async (selection, consume, options) => {
    retained = consume;
    return emit([file(`${root}/result`), directory])(selection, consume, options);
  });
  await sandbox.stop();
  const paths: string[] = [];
  assert.deepEqual(await sandbox.exportTree({ kind: 'subtree', path: root }, async (entry) => {
    paths.push(entry.path);
    if (entry.kind === 'file') assert.deepEqual(await entryBytes(entry), Uint8Array.of(23));
  }), { files: 1n, directories: 1n, symlinks: 0n, payloadBytes: 1n, archiveBytes: 1n });
  assert.deepEqual(paths.sort(), [root, `${root}/result`]);
  assert.ok(retained);
  const callback = retained;
  await assert.rejects(callback(directory, { signal: new AbortController().signal }), /sequentially within the transfer/u);
  assert.equal(physical.spillFiles, 0);
});

test('late malformed subtree metadata rejects before its consumer and keeps earlier callbacks provisional', async (t) => {
  const invalid = { kind: 'directory' as const, path: `${root}/../escape` };
  const { sandbox, physical } = await started(t, emit([directory, file(`${root}/result`), invalid]));
  await sandbox.stop();
  const paths: string[] = [];
  await assert.rejects(sandbox.exportTree({ kind: 'subtree', path: root }, async (entry) => {
    paths.push(entry.path);
    if (entry.kind === 'file') await entryBytes(entry);
  }), SandboxValidationError);
  assert.deepEqual(paths, [root, `${root}/result`]);
  assert.equal(physical.spillFiles, 0);
});

test('subtree cancellation retains an entered consumer and storage until actual settlement', { timeout: 3000 }, async (t) => {
  const entered = gate();
  const release = gate();
  const abort = new AbortController();
  const physical = fixture({ decorateReady: (ready) => ({ ...ready, exportTree: emit([directory, file(`${root}/result`)]) }) });
  const sandbox = await physical.backend.reserve(request({ cleanupMs: 20 }), recovery).start();
  await sandbox.stop();
  t.after(async () => { release.resolve(); await sandbox.destroy(); });
  const exporting = sandbox.exportTree({ kind: 'subtree', path: root }, async (entry) => {
    if (entry.kind === 'file') { entered.resolve(); await release.promise; await entryBytes(entry); }
  }, { signal: abort.signal });
  const rejected = assert.rejects(exporting, (error: unknown) => error instanceof SandboxOperationError && error.code === 'cancelled');
  await entered.promise;
  abort.abort();
  await rejected;
  await assert.rejects(sandbox.destroy(), SandboxCleanupError);
  await nextTurn();
  assert.deepEqual([...physical.resources], ['storage']);
  assert(physical.spillFiles > 0);
  release.resolve();
  await sandbox.destroy();
  assert.deepEqual([...physical.resources], []);
  assert.equal(physical.spillFiles, 0);
});
