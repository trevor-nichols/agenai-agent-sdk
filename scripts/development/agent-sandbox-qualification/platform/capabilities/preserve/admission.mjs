import assert from 'node:assert/strict';
import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxStateError } from '@agen-ai/sandbox';
import { exportSandboxDirectory } from '@agen-ai/sandbox/node';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';
import { sentinel } from '../live/sentinel.mjs';
import { assertAbsent, denial, directory, file, link, metadata, preserve, ready, send, sha, startGuestAfterImport, variantCases } from './shared.mjs';

async function fenced(run, reserved) {
  assert.throws(() => reserved.sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: ['-e', '0'],
    env: {}, cwd: reserved.sandbox.workspace }), SandboxStateError);
  await run.settleCleanup(reserved.entry, 'stop');
}

const invalidGraphs = [
  ['absolute', (variant) => [link('unsafe', variant.hostRoot.sentinel.path)], /bounded raw relative symbolic-link target/u],
  ['parent-escape', () => [link('unsafe', '../outside')], /target escapes the selected publication root/u],
  ['dangling-suffix-escape', () => [link('unsafe', 'missing/../../outside')], /target escapes the selected publication root/u],
  ['chain-escape', () => [directory('d'), link('alias', '.'), link('d/unsafe', '../alias/../outside')], /target escapes the selected publication root/u],
  ['link-member-parent', () => [link('alias', 'real'), file('alias/child.bin'), directory('real')], /Metadata symlink_ancestor/u],
  ['file-link-collision', () => [file('same'), link('same', 'target')], /Metadata duplicate_path/u],
  ['forty-one-expansions', () => Array.from({ length: 41 }, (_, index) => link(`chain-${index}`, index === 40 ? 'missing' : `chain-${index + 1}`)),
    /exceeds forty symbolic-link expansions/u],
  ['growing-cycle', () => [link('loop', 'loop/child')], /exceeds forty symbolic-link expansions|bounded path working set/u],
  ['resolution-components', () => [link('entry', ['pivot', ...Array(127).fill('x')].join('/')),
    link('pivot', ['nested', ...Array(127).fill('y')].join('/')), link('nested', Array(128).fill('z').join('/'))], /bounded path working set/u],
  ['resolution-bytes', () => {
    const suffix = Array(15).fill('x'.repeat(255)).join('/');
    return [link('entry', `pivot/${suffix}`), link('pivot', `next/${suffix}`), link('next', `missing/${suffix}`)];
  }, /bounded path working set/u],
];

export function admissionCases(context) {
  const definitions = [];
  for (const kind of ['file', 'directory', 'link']) definitions.push([`actual-empty-rejects-existing-${kind}`, async (run, variant) => {
    let archivePuts = 0;
    const proxy = await createTraceProxy({ socketPath: join(run.directory, 'e.sock'), upstreamEndpoint: context.config.endpoint,
      tracePath: join(run.directory, 'trace.jsonl'), observeResponse({ method, target }) {
        if (method === 'PUT' && new URL(target, 'http://engine.invalid').pathname.endsWith('/archive')) archivePuts++;
      } });
    run.proxies.push(proxy); proxy.setRow('preserve-internal');
    const reserved = await ready(run, { ...context, config: { ...context.config, endpoint: proxy.endpoint } }, variant);
    const initial = kind === 'file' ? [file('existing.bin')] : kind === 'directory' ? [directory('existing')] : [link('existing-link', 'missing')];
    await reserved.sandbox.importTree(initial, kind === 'link' ? preserve : undefined);
    const putsBefore = archivePuts; let sourceEntered = false;
    const source = { *[Symbol.iterator]() { sourceEntered = true; yield file('must-not-exist.bin'); } };
    const rejected = await denial(run, reserved.sandbox.importTree(source, preserve), /actually empty workspace/u, 'state');
    assert.equal(sourceEntered, false); assert.equal(archivePuts, putsBefore);
    await fenced(run, reserved); const exported = await metadata(reserved.sandbox);
    assert.equal(exported.entries.length, 1); assert(!exported.entries.some(({ path }) => path === 'must-not-exist.bin'));
    run.evidence.observations.push({ kind: 'actual-nonempty-before-source-and-archive-put', existingKind: kind, rejected,
      sourceEntered, archivePutsBefore: putsBefore, archivePutsAfter: archivePuts, exported }); await run.save();
  }]);
  definitions.push(['actual-empty-import-is-repeatable', async (run, variant) => {
    const reserved = await ready(run, context, variant); const { sandbox } = reserved;
    for (let index = 0; index < 2; index++) {
      const result = await sandbox.importTree([], preserve); assert.equal(result.files, 0n); assert.equal(result.symlinks, 0n);
    }
    const imported = await sandbox.importTree([file('finally.bin')], preserve); assert.equal(imported.files, 1n);
    await run.settleCleanup(reserved.entry, 'stop'); const exported = await metadata(sandbox);
    assert.equal(exported.entries.length, 1); assert.equal(exported.entries[0].path, 'finally.bin');
    run.evidence.observations.push({ kind: 'repeatable-empty-storage-admission', emptyImports: 2, imported, exported }); await run.save();
  }]);
  for (const [name, inputs, pattern] of invalidGraphs) definitions.push([`invalid-${name}-withholds-links`, async (run, variant) => {
    const reserved = await ready(run, context, variant); const entries = inputs(variant); const reached = []; let bodyFinished = false;
    const source = { *[Symbol.iterator]() {
      yield { kind: 'file', path: 'provisional.bin', byteLength: 1, executable: false,
        open: () => ({ *[Symbol.iterator]() { yield Uint8Array.of(73); bodyFinished = true; } }) };
      for (const entry of entries) { reached.push(entry.path); yield entry; }
    } };
    const rejected = await denial(run, reserved.sandbox.importTree(source, preserve), pattern);
    assert.equal(bodyFinished, true); assert.deepEqual(reached, entries.map(({ path }) => path));
    await fenced(run, reserved); const exported = await metadata(reserved.sandbox);
    assert.equal(exported.summary.symlinks, 0n);
    const provisional = exported.entries.find(({ path }) => path === 'provisional.bin');
    if (provisional) assert.equal(provisional.sha256, sha(Uint8Array.of(73)));
    run.evidence.observations.push({ kind: 'entered-invalid-graph-links-withheld-and-execution-fenced', input: name,
      entries: entries.map((entry) => ({ kind: entry.kind, path: entry.path, ...(entry.kind === 'symlink' ? { target: entry.target } : {}) })),
      rejected, bodyFinished, reached, exported, regularEffects: 'Entered regular effects may remain; no import rollback is claimed.' }); await run.save();
  }]);
  definitions.push(['default-import-and-export-reject-links', async (run, variant) => {
    const first = await ready(run, context, variant); let reached = false;
    const rejectedImport = await denial(run, first.sandbox.importTree({ *[Symbol.iterator]() {
      yield file('provisional.bin'); reached = true; yield link('alias', 'provisional.bin');
    } }), /Symbolic links require explicit preserve_internal/u);
    assert.equal(reached, true); await fenced(run, first);
    const importedEffects = await metadata(first.sandbox); assert.equal(importedEffects.summary.symlinks, 0n);
    const second = await ready(run, context, variant);
    await second.sandbox.importTree([file('payload'), link('alias', 'payload')], preserve); await run.settleCleanup(second.entry, 'stop');
    const destination = join(run.hostDirectory, 'default-export');
    const rejectedExport = await denial(run, exportSandboxDirectory(second.sandbox, { kind: 'workspace' }, destination), /symbolic.link/iu, 'operation');
    await assertAbsent(destination);
    run.evidence.observations.push({ kind: 'omitted-preservation-denied-at-both-directions', rejectedImport, reached,
      importedEffects, rejectedExport, destinationAbsent: true }); await run.save();
  }]);
  definitions.push(['default-import-no-follow-ancestor-and-leaf', async (run, variant) => {
    const reserved = await ready(run, context, variant); const { sandbox } = reserved;
    await sandbox.importTree([directory('real'), file('real/sentinel.bin', Uint8Array.of(21)), link('alias', 'real')], preserve);
    const rejected = await denial(run, sandbox.importTree([file('alias/new.bin')]), /symlink|symbolic|archive|path|Docker/iu, 'operation');
    await fenced(run, reserved); const exported = await metadata(sandbox);
    assert(!exported.entries.some(({ path }) => path === 'real/new.bin' || path === 'alias/new.bin'));
    assert(exported.entries.some(({ path, sha256 }) => path === 'real/sentinel.bin' && sha256 === sha(Uint8Array.of(21))));
    const leaf = await ready(run, context, variant);
    await leaf.sandbox.importTree([file('target.bin', Uint8Array.of(21)), link('leaf', 'target.bin')], preserve);
    await leaf.sandbox.importTree([file('leaf', Uint8Array.of(42)), file('additional.bin', Uint8Array.of(63))]);
    await run.settleCleanup(leaf.entry, 'stop'); const after = await metadata(leaf.sandbox);
    assert.equal(after.summary.files, 3n); assert.equal(after.summary.symlinks, 0n);
    for (const [path, value] of [['target.bin', 21], ['leaf', 42], ['additional.bin', 63]]) {
      assert(after.entries.some((entry) => entry.path === path && entry.sha256 === sha(Uint8Array.of(value))));
    }
    run.evidence.observations.push({ kind: 'ordinary-import-confines-ancestor-and-replaces-only-leaf', rejected, exported, after }); await run.save();
  }]);
  definitions.push(['selected-subtree-confinement', async (run, variant) => {
    const reserved = await ready(run, context, variant); const { sandbox } = reserved;
    await sandbox.importTree([directory('reports/selected'), directory('reports/selected/nested'),
      file('reports/selected/data.bin', Uint8Array.of(8, 0, 255)), link('reports/selected/nested/alias', '../data.bin'),
      link('reports/selected/dangling', './missing'), file('outside.bin')], preserve);
    await run.settleCleanup(reserved.entry, 'stop');
    const selection = { kind: 'subtree', path: 'reports/selected' };
    const result = await exportSandboxDirectory(sandbox, selection, join(run.hostDirectory, 'selected'), preserve);
    assert.equal(result.summary.files, 1n); assert.equal(result.summary.symlinks, 2n);
    const root = join(result.directory, 'reports/selected');
    assert.deepEqual(await readlink(join(root, 'nested/alias'), { encoding: 'buffer' }), Buffer.from('../data.bin'));
    assert.deepEqual(await readlink(join(root, 'dangling'), { encoding: 'buffer' }), Buffer.from('./missing'));
    assert.deepEqual(await readFile(join(root, 'data.bin')), Buffer.from([8, 0, 255])); await assertAbsent(join(result.directory, 'outside.bin'));
    const unsafe = await ready(run, context, variant);
    await unsafe.sandbox.importTree([directory('selected'), file('outside.bin'), file('selected/first.bin'), link('selected/late', '../outside.bin')], preserve);
    await run.settleCleanup(unsafe.entry, 'stop'); const full = await metadata(unsafe.sandbox); assert.equal(full.summary.symlinks, 1n);
    const destination = join(run.hostDirectory, 'unpublished-selected');
    const rejected = await denial(run, exportSandboxDirectory(unsafe.sandbox, { kind: 'subtree', path: 'selected' }, destination, preserve),
      /target escapes the selected publication root/u, 'operation'); await assertAbsent(destination);
    run.evidence.observations.push({ kind: 'selected-root-is-the-link-boundary', selection, result, full, rejected, destinationAbsent: true }); await run.save();
  }]);
  definitions.push(['exact-file-and-live-no-follow', async (run, variant) => {
    const reserved = await ready(run, context, variant); const { sandbox } = reserved;
    await sandbox.importTree([directory('real'), file('real/data.bin', Uint8Array.of(8, 0, 255)), link('leaf', 'real/data.bin'), link('alias', 'real')], preserve);
    const live = [];
    if (variant.layout === 'private') for (const path of ['leaf', 'alias/data.bin']) {
      let delivered = 0;
      const read = await sandbox.files.readFile(path, async ({ chunks }) => { for await (const chunk of chunks) delivered += chunk.byteLength; });
      const write = await sandbox.files.writeFile(path, [Uint8Array.of(99)], { mode: 'replace' });
      assert.equal(read.kind, 'rejected'); assert.equal(delivered, 0); assert.equal(write.kind, 'rejected'); assert.equal(write.effect, 'none');
      live.push({ path, read, delivered, write });
    }
    await run.settleCleanup(reserved.entry, 'stop'); const selections = [];
    for (const path of ['leaf', 'alias/data.bin']) {
      let callbackEntered = false;
      const rejected = await denial(run, sandbox.exportTree({ kind: 'files', paths: [path] }, async () => { callbackEntered = true; }, preserve),
        /symlink|symbolic/u, 'operation'); assert.equal(callbackEntered, false); selections.push({ path, rejected, callbackEntered });
    }
    const final = await metadata(sandbox, undefined, { kind: 'files', paths: ['real/data.bin'] });
    assert.equal(final.summary.files, 1n); assert.equal(final.summary.symlinks, 0n); assert.equal(final.entries[0].sha256, sha(Uint8Array.of(8, 0, 255)));
    run.evidence.observations.push({ kind: 'preservation-does-not-enable-exact-or-live-traversal', layout: variant.layout, live, selections, final }); await run.save();
  }]);
  for (const kind of ['hardlink', 'fifo']) definitions.push([`native-${kind}-has-no-host-publication`, async (run, variant) => {
    const reserved = await ready(run, context, variant);
    await reserved.sandbox.importTree([file('target.bin')], preserve);
    const { session } = await startGuestAfterImport(run, context, reserved);
    await send(session, kind === 'hardlink' ? { kind, from: 'target.bin', path: 'unsupported' } : { kind, path: 'unsupported' });
    const native = await send(session, { kind: 'stat', path: 'unsupported' });
    if (kind === 'hardlink') { assert.equal(native.kind, 'file'); assert.equal(native.links, 2); } else assert.equal(native.kind, 'special');
    await run.settleCleanup(reserved.entry, 'stop'); const destination = join(run.hostDirectory, 'unsupported-publication');
    const rejected = await denial(run, exportSandboxDirectory(reserved.sandbox, { kind: 'workspace' }, destination, preserve),
      /hardlinks and special files are forbidden/u, 'operation'); await assertAbsent(destination);
    run.evidence.observations.push({ kind: 'native-unsupported-archive-type-has-no-publication', type: kind, native, rejected, destinationAbsent: true }); await run.save();
  }]);
  definitions.push(['private-stage-and-other-workspace-sentinels', async (run, variant) => {
    const main = await ready(run, context, variant); const other = await ready(run, context, variant);
    const marker = Buffer.from('independent-other-workspace');
    await other.sandbox.importTree([file('sentinel.bin', marker)], preserve);
    const { session } = await startGuestAfterImport(run, context, other);
    assert.equal((await send(session, { kind: 'digest', path: 'sentinel.bin' })).sha256, sha(marker));
    const outside = variant.layout === 'private' ? await sentinel(run, context, main.owner) : null;
    const before = outside ? await outside.inspect() : null;
    const rejected = await denial(run, main.sandbox.importTree([file('provisional.bin'), link('escape', '../sibling/sentinel')], preserve),
      /target escapes the selected publication root/u);
    await fenced(run, main); const mainAfter = await metadata(main.sandbox); assert.equal(mainAfter.summary.symlinks, 0n);
    const after = outside ? await outside.inspect() : null;
    if (outside) { assert.equal(after.sha256, before.sha256); assert.equal(after.siblingSha256, before.siblingSha256); assert.deepEqual(after.stage, []); }
    await run.settleCleanup(other.entry, 'stop'); const otherAfter = await metadata(other.sandbox);
    assert(otherAfter.entries.some(({ path, sha256 }) => path === 'sentinel.bin' && sha256 === sha(marker)));
    const storageIds = [main.owner, other.owner].map((owner) => owner.recoveryRecord.resources.find(({ role }) => role === 'storage').identity.id);
    assert.notEqual(storageIds[0], storageIds[1]);
    run.evidence.observations.push({ kind: 'private-stage-sibling-and-independent-workspace-preserved', layout: variant.layout,
      storageIds, before, after, rejected, mainAfter, otherAfter, otherSentinelSha256: sha(marker) }); await run.save();
  }]);
  return variantCases(context, definitions);
}
