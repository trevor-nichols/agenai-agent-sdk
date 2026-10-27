import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import { exportSandboxDirectory, importSandboxDirectory } from '@agen-ai/sandbox/node';
import { binary, executable, links, unicode } from '../../../capabilities/symlinks/fixtures.mjs';
import { directory, file, link, metadata, preserve, ready, send, sha, startGuestAfterImport, variantCases } from './shared.mjs';

export function roundTripCases(context) {
  return variantCases(context, [
    ['roundtrip-mixed-tree', async (run, variant) => {
      const reserved = await ready(run, context, variant); const { sandbox } = reserved;
      const source = join(run.hostDirectory, 'source'); await mkdir(source);
      for (const path of ['data', 'scripts', unicode, 'empty-dir']) await mkdir(join(source, path));
      await writeFile(join(source, 'data/blob.bin'), binary); await writeFile(join(source, 'data/empty.bin'), new Uint8Array());
      await writeFile(join(source, 'scripts/run.sh'), executable); await chmod(join(source, 'scripts/run.sh'), 0o700);
      for (const [path, target] of links) await symlink(target, join(source, path));
      const rawSourceNames = (await readdir(source, { encoding: 'buffer' })).sort(Buffer.compare);
      const imported = await importSandboxDirectory(sandbox, source, preserve);
      assert.equal(imported.files, 3n); assert.equal(imported.directories, 4n); assert.equal(imported.symlinks, 9n);
      assert.equal(imported.payloadBytes, BigInt(binary.length + executable.length));
      const { session, facts } = await startGuestAfterImport(run, context, reserved);
      const observed = await send(session, { kind: 'digest', path: 'root-link' }); assert.equal(observed.sha256, sha(binary));
      assert.equal((await send(session, { kind: 'stat', path: 'root-link' })).kind, 'symlink');
      const updatedBytes = Buffer.from([9, 0, 255, 17]);
      const updated = await send(session, { kind: 'write', path: 'data/blob.bin', base64: updatedBytes.toString('base64') });
      assert.equal(updated.sha256, sha(updatedBytes));
      assert.equal((await send(session, { kind: 'digest', path: 'chain' })).sha256, sha(updatedBytes));
      const nativePermissions = await send(session, { kind: 'stat', path: 'scripts/run.sh' });
      assert.notEqual(nativePermissions.permissions & 0o111, 0);
      await run.settleCleanup(reserved.entry, 'stop');
      const exported = await exportSandboxDirectory(sandbox, { kind: 'workspace' }, join(run.hostDirectory, 'published'), preserve);
      const guestSource = run.evidence.observations.find(({ kind }) => kind === 'preserving-workspace-controlled-guest');
      assert.equal(exported.summary.files, 4n); assert.equal(exported.summary.directories, 5n); assert.equal(exported.summary.symlinks, 9n);
      assert.equal(exported.summary.payloadBytes, BigInt(updatedBytes.length + executable.length + guestSource.sourceBytes));
      const actualLinks = [];
      for (const [path, target] of links) {
        const from = await readlink(join(source, path), { encoding: 'buffer' });
        const to = await readlink(join(exported.directory, path), { encoding: 'buffer' });
        assert((await lstat(join(exported.directory, path))).isSymbolicLink());
        assert.deepEqual(from, Buffer.from(target)); assert.deepEqual(to, from);
        actualLinks.push({ path, targetBytes: to.length, targetBase64: to.toString('base64'), sha256: sha(to) });
      }
      assert.deepEqual(await readFile(join(exported.directory, 'data/blob.bin')), updatedBytes);
      assert.deepEqual(await readFile(join(source, 'data/blob.bin')), binary, 'Guest updates cannot modify the caller source.');
      assert.deepEqual(await readFile(join(exported.directory, 'data/empty.bin')), Buffer.alloc(0));
      assert.deepEqual(await readFile(join(exported.directory, 'scripts/run.sh')), executable);
      const executableMode = (await lstat(join(exported.directory, 'scripts/run.sh'))).mode & 0o777;
      const binaryMode = (await lstat(join(exported.directory, 'data/blob.bin'))).mode & 0o777;
      assert.notEqual(executableMode & 0o111, 0); assert.equal(binaryMode & 0o111, 0);
      assert.deepEqual(await readdir(join(exported.directory, 'empty-dir')), []);
      const rawOutputNames = (await readdir(exported.directory, { encoding: 'buffer' })).sort(Buffer.compare);
      assert.deepEqual(rawOutputNames, [...rawSourceNames, Buffer.from('qualification')].sort(Buffer.compare));
      run.evidence.observations.push({ kind: 'installed-host-docker-host-preserving-roundtrip', layout: variant.layout,
        hostRole: variant.hostRoot.role, imported, exported, facts, observed, updated, nativePermissions, executableMode, binaryMode,
        binarySha256: sha(binary), updatedSha256: sha(updatedBytes), executableSha256: sha(executable), links: actualLinks,
        sourceNamesHex: rawSourceNames.map((name) => name.toString('hex')), outputNamesHex: rawOutputNames.map((name) => name.toString('hex')) });
      await run.save();
    }],
    ['maximum-path-and-target-pax', async (run, variant) => {
      const { sandbox, entry } = await ready(run, context, variant);
      const path = `${Array(15).fill('a'.repeat(255)).join('/')}/${'b'.repeat(239)}`;
      const target = `${'../'.repeat(15)}${Array(15).fill('c'.repeat(255)).join('/')}/${'d'.repeat(194)}`;
      assert.equal(Buffer.byteLength(path), 4079); assert.equal(Buffer.byteLength(target), 4079);
      const imported = await sandbox.importTree([link(path, target)], preserve); assert.equal(imported.symlinks, 1n);
      await run.settleCleanup(entry, 'stop'); const exported = await metadata(sandbox);
      assert.deepEqual(exported.entries.filter(({ kind }) => kind === 'symlink'), [link(path, target)]);
      run.evidence.observations.push({ kind: 'maximum-pax-through-native-docker-archive', imported, exported,
        hostRole: variant.hostRoot.role, layout: variant.layout, hostPublication: 'Not attempted; separate exact native host representation cases own that boundary.' });
      await run.save();
    }],
    ['multi-batch-link-graph', async (run, variant) => {
      const { sandbox, entry } = await ready(run, context, variant);
      const count = 1200; const suffix = 'x'.repeat(160); let sourceMetadataBytes = 0; let pathTargetBytes = 0;
      const entries = { *[Symbol.iterator]() {
        yield directory('links'); yield file('target.bin', binary);
        for (let index = count - 1; index >= 0; index--) {
          const value = link(`links/${String(index).padStart(4, '0')}-${suffix}`, '../target.bin');
          sourceMetadataBytes += Buffer.byteLength(JSON.stringify(value));
          pathTargetBytes += Buffer.byteLength(value.path) + Buffer.byteLength(value.target); yield value;
        }
      } };
      const imported = await sandbox.importTree(entries, preserve); assert.equal(imported.symlinks, BigInt(count));
      assert(sourceMetadataBytes > SANDBOX_DEFAULT_TRANSFER_BUFFERS.metadataBatchBytes);
      assert(pathTargetBytes > SANDBOX_DEFAULT_TRANSFER_BUFFERS.metadataBatchBytes);
      await run.settleCleanup(entry, 'stop'); const exported = await metadata(sandbox);
      assert.equal(exported.summary.files, 1n); assert.equal(exported.summary.symlinks, BigInt(count));
      const actual = exported.entries.filter(({ kind }) => kind === 'symlink').sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      assert.deepEqual(actual, Array.from({ length: count }, (_, index) => link(`links/${String(index).padStart(4, '0')}-${suffix}`, '../target.bin')));
      assert.deepEqual(exported.entries.filter(({ kind }) => kind === 'file'), [
        { kind: 'file', path: 'target.bin', bytes: BigInt(binary.length), executable: false, sha256: sha(binary) },
      ]);
      run.evidence.observations.push({ kind: 'bounded-multi-batch-preserving-graph', count, sourceMetadataBytes, pathTargetBytes,
        metadataBatchBytes: SANDBOX_DEFAULT_TRANSFER_BUFFERS.metadataBatchBytes, imported, exportedSummary: exported.summary,
        linkCensus: actual, fileCensus: exported.entries.filter(({ kind }) => kind === 'file'), targetSha256: sha(binary) }); await run.save();
    }],
  ]);
}
