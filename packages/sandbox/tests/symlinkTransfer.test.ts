import assert from 'node:assert/strict';
import test from 'node:test';
import { fileFromBytes, parseSandboxSupport, parseSandboxSymlinkTarget, SandboxCleanupError, SandboxOperationError,
  SandboxStateError, SandboxUnsupportedError, SandboxValidationError } from '../src/index.js';
import type { SandboxTreeEntry } from '../src/index.js';
import { fixture, gate, nextTurn, processSpec, request } from './fixtures/backend.js';

const recovery = { kind: 'in_process' as const };
const preserve = { symlinks: 'preserve_internal' as const };
const bounded = { timeout: 3000 };
const link = (path: string, target: string): SandboxTreeEntry => ({ kind: 'symlink', path, target });

test('transfer support and target parsing expose explicit preservation without rewriting raw target text', () => {
  const input = { backendId: 'fixture', backendRevision: '1', networkModes: ['isolated'], workspaceDiskQuota: false,
    networkAllowlist: false, independentProcessTermination: false };
  assert.equal(parseSandboxSupport(input).transferSymlinks, false);
  assert.deepEqual(parseSandboxSupport({ ...input, transferSymlinks: { kind: 'preserve_internal', import: 'empty_workspace' } }).transferSymlinks,
    { kind: 'preserve_internal', import: 'empty_workspace' });
  for (const transferSymlinks of [true, 'preserve_internal', { kind: 'preserve_internal' }, { kind: 'preserve_internal', import: 'any_workspace' }]) {
    assert.throws(() => parseSandboxSupport({ ...input, transferSymlinks }), SandboxValidationError);
  }
  assert.equal(parseSandboxSymlinkTarget('./nested//../file'), './nested//../file');
  assert.equal(parseSandboxSymlinkTarget('../sibling'), '../sibling');
  for (const target of ['', '/absolute', 'a\\b', 'a\0b', 'a\nb', 'a\u0085b', '\ud800', 'é'.repeat(128), Array(129).fill('.').join('/')]) {
    assert.throws(() => parseSandboxSymlinkTarget(target), SandboxValidationError);
  }
});

test('unsupported preservation rejects before source/spill/backend entry while ordinary imports remain usable', bounded, async () => {
  const physical = fixture(); const owner = physical.backend.reserve(request(), recovery); const sandbox = await owner.start();
  let opened = 0;
  const source = { *[Symbol.iterator]() { opened++; yield link('alias', 'missing'); } };
  assert.throws(() => sandbox.importTree(source, preserve), SandboxUnsupportedError);
  // @ts-expect-error Runtime caller data cannot use a non-enumerated transfer mode.
  assert.throws(() => sandbox.importTree([], { symlinks: 'follow' }), SandboxValidationError);
  // @ts-expect-error Explicit null is malformed rather than omitted authority.
  assert.throws(() => sandbox.importTree([], { symlinks: null }), SandboxValidationError);
  assert.equal(opened, 0); assert.equal(physical.importCount, 0); assert.equal(physical.spillFiles, 0);
  const summary = await sandbox.importTree([fileFromBytes('ordinary', Uint8Array.of(5))]);
  assert.deepEqual(summary, { files: 1n, directories: 0n, symlinks: 0n, payloadBytes: 1n, archiveBytes: 1n });
  assert.deepEqual(physical.files.get('ordinary'), Buffer.from([5]));
  await sandbox.stop();
  assert.throws(() => sandbox.exportTree({ kind: 'workspace' }, async () => {}, preserve), SandboxUnsupportedError);
  await owner.destroy(); assert.deepEqual([...physical.resources], []);
});

test('imports emit validated links last and count symlinks independently from regular files and bytes', bounded, async () => {
  const delivered: string[] = [];
  const physical = fixture({ transferSymlinks: true, decorateReady: (ready) => ({ ...ready,
    importTree(entries, options) {
      assert.equal(options.symlinks, 'preserve_internal');
      return ready.importTree({ async *[Symbol.asyncIterator]() {
        for await (const entry of entries) { delivered.push(`${entry.kind}:${entry.path}`); yield entry; }
      } }, options);
    },
  }) });
  const owner = physical.backend.reserve(request(), recovery); const sandbox = await owner.start();
  const summary = await sandbox.importTree([link('alias', './data.bin'), link('cycle', 'cycle'),
    { kind: 'directory', path: 'empty' }, fileFromBytes('data.bin', Uint8Array.of(0, 255, 7)), link('chain', 'alias')], preserve);
  assert.deepEqual(delivered, ['directory:empty', 'file:data.bin', 'symlink:alias', 'symlink:chain', 'symlink:cycle']);
  assert.deepEqual(summary, { files: 1n, directories: 1n, symlinks: 3n, payloadBytes: 3n, archiveBytes: 3n });
  assert.deepEqual([...physical.symlinks], [['alias', './data.bin'], ['chain', 'alias'], ['cycle', 'cycle']]);
  assert.deepEqual(physical.files.get('data.bin'), Buffer.from([0, 255, 7])); assert.equal(physical.spillFiles, 0);
  await owner.destroy();
  const onlyLinks = fixture({ transferSymlinks: true }); const linkOwner = onlyLinks.backend.reserve(request(), recovery); const linkSandbox = await linkOwner.start();
  assert.deepEqual(await linkSandbox.importTree([link('dangling', 'absent')], { ...preserve, quotas: { maxFiles: 0, maxTotalBytes: 0 } }),
    { files: 0n, directories: 0n, symlinks: 1n, payloadBytes: 0n, archiveBytes: 0n });
  await linkOwner.destroy();
});

test('late invalid/default/quota link input never publishes links and fences execution while retaining prior regular effects', bounded, async () => {
  for (const mode of ['escape', 'default', 'quota', 'metadata'] as const) {
    const physical = fixture({ transferSymlinks: true }); const owner = physical.backend.reserve(request(), recovery); const sandbox = await owner.start();
    const entry = mode === 'escape' ? link('alias', '../outside') : mode === 'metadata'
      ? { kind: 'symlink' as const, path: 'alias', target: 'missing', executable: false } : link('alias', 'missing');
    const options = mode === 'default' ? {} : mode === 'quota' ? { ...preserve, quotas: { maxSymlinks: 0 } } : preserve;
    await assert.rejects(sandbox.importTree([fileFromBytes('provisional', Uint8Array.of(9)), entry], options),
      (error: unknown) => error instanceof SandboxValidationError || (error instanceof SandboxOperationError && error.code === 'input_limit'));
    assert.deepEqual(physical.files.get('provisional'), Buffer.from([9])); assert.deepEqual([...physical.symlinks], []);
    assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError); assert.equal(physical.spillFiles, 0);
    await owner.destroy(); assert.deepEqual([...physical.resources], []);
  }
});

test('export defers early link headers until regular callbacks and graph validation complete; exact-file export never follows links', bounded, async () => {
  const callbacks: string[] = []; let decoded = false;
  const physical = fixture({ transferSymlinks: true, decorateReady: (ready) => ({ ...ready,
    async exportTree(_selection, consume, options) {
      await consume({ kind: 'symlink', path: 'alias', target: './data.bin' }, { signal: options.signal });
      assert.deepEqual(callbacks, []);
      await consume({ kind: 'file', path: 'data.bin', byteLength: 3, executable: true,
        bytes: { async *[Symbol.asyncIterator]() { yield Uint8Array.of(0, 255, 7); } } }, { signal: options.signal });
      decoded = true;
      assert.deepEqual(callbacks, ['file:data.bin']);
      return { files: 1n, directories: 0n, symlinks: 1n, payloadBytes: 3n, archiveBytes: 1024n };
    },
  }) });
  const owner = physical.backend.reserve(request(), recovery); const sandbox = await owner.start(); await sandbox.stop();
  await assert.rejects(sandbox.exportTree({ kind: 'workspace' }, async () => { assert.fail('Default rejection must precede callbacks.'); }), SandboxValidationError);
  const result = await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
    callbacks.push(`${entry.kind}:${entry.path}`);
    if (entry.kind === 'file') { const bytes = []; for await (const chunk of entry.bytes) bytes.push(...chunk); assert.deepEqual(bytes, [0, 255, 7]); }
    else if (entry.kind === 'symlink') { assert.equal(decoded, true); assert.equal(entry.target, './data.bin'); }
  }, preserve);
  assert.deepEqual(callbacks, ['file:data.bin', 'symlink:alias']); assert.equal(result.symlinks, 1n); assert.equal(result.files, 1n);
  await assert.rejects(sandbox.exportTree({ kind: 'files', paths: ['alias'] }, async () => { assert.fail('Exact regular-file selection cannot expose a link.'); }, preserve), SandboxOperationError);
  await owner.destroy();
});

test('late export graph rejection withholds link callbacks while retaining provisional regular-file delivery', bounded, async () => {
  const callbacks: string[] = [];
  const physical = fixture({ transferSymlinks: true, decorateReady: (ready) => ({ ...ready,
    async exportTree(_selection, consume, options) {
      await consume({ kind: 'symlink', path: 'alias', target: 'missing/../..' }, { signal: options.signal });
      await consume({ kind: 'file', path: 'data.bin', byteLength: 3, executable: false,
        bytes: { async *[Symbol.asyncIterator]() { yield Uint8Array.of(0, 255, 7); } } }, { signal: options.signal });
      return { files: 1n, directories: 0n, symlinks: 1n, payloadBytes: 3n, archiveBytes: 1024n };
    },
  }) });
  const owner = physical.backend.reserve(request(), recovery); const sandbox = await owner.start(); await sandbox.stop();
  await assert.rejects(sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
    callbacks.push(`${entry.kind}:${entry.path}`);
    assert.equal(entry.kind, 'file');
    if (entry.kind === 'file') {
      const bytes = []; for await (const chunk of entry.bytes) bytes.push(...chunk);
      assert.deepEqual(bytes, [0, 255, 7]);
    }
  }, preserve), (error: unknown) => error instanceof SandboxValidationError
    && error.issues.some((issue) => issue.message.includes('target escapes the selected publication root')));
  assert.deepEqual(callbacks, ['file:data.bin']); assert.equal(physical.spillFiles, 0);
  await owner.destroy(); assert.deepEqual([...physical.resources], []);
});

test('stopped export retains a cancelled deferred-link callback and its spill owner until explicit cleanup joins it', bounded, async () => {
  const entered = gate(); const release = gate(); let decoded = false;
  const physical = fixture({ transferSymlinks: true, decorateReady: (ready) => ({ ...ready,
    async exportTree(_selection, consume, options) {
      await consume({ kind: 'symlink', path: 'loop', target: 'loop' }, { signal: options.signal }); decoded = true;
      return { files: 0n, directories: 0n, symlinks: 1n, payloadBytes: 0n, archiveBytes: 512n };
    },
  }) });
  const owner = physical.backend.reserve(request({ cleanupMs: 20 }), recovery); const sandbox = await owner.start(); await sandbox.stop();
  const abort = new AbortController();
  const exporting = sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
    assert.equal(decoded, true); assert.deepEqual(entry, { kind: 'symlink', path: 'loop', target: 'loop' }); entered.resolve(); await release.promise;
  }, { ...preserve, signal: abort.signal });
  const rejected = assert.rejects(exporting, (error: unknown) => error instanceof SandboxOperationError && error.code === 'cancelled');
  await entered.promise; abort.abort(); await rejected;
  await assert.rejects(owner.destroy(), (error: unknown) => error instanceof SandboxCleanupError && error.owner === owner);
  assert.deepEqual([...physical.resources], ['storage']); assert.equal(physical.destroyAttempts, 0); assert.equal(physical.spillFiles, 4);
  release.resolve(); await nextTurn(); await owner.destroy();
  assert.deepEqual([...physical.resources], []); assert.equal(physical.spillFiles, 0);
});
