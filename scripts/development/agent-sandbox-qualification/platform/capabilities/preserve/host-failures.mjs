// ------------------------------------------------------------------------------------------------
//                host-failures.mjs - Native host representation, cancellation and publication owners
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxOperationError, SandboxStateError } from '@agen-ai/sandbox';
import { exportSandboxDirectory, importSandboxDirectory, SandboxDirectoryCleanupError } from '@agen-ai/sandbox/node';
import { failure } from '../live/evidence.mjs';
import { assertAbsent, directory, file, link, metadata, preserve, ready, retainDirectoryCleanup, sha, variantCases } from './shared.mjs';

const inode = (stat) => ({ device: String(stat.dev), inode: String(stat.ino) });
const targetIdentity = (target) => ({ utf8Bytes: Buffer.byteLength(target), sha256: sha(Buffer.from(target)) });
const nativeFailure = (error) => ({ ...failure(error), syscall: error.syscall ?? null,
  pathSha256: typeof error.path === 'string' || Buffer.isBuffer(error.path) ? sha(Buffer.from(error.path)) : null });

async function observed(run, value) {
  run.evidence.observations.push(value);
  await run.save();
}

async function rejected(run, operation) {
  try { await operation; }
  catch (error) {
    if (retainDirectoryCleanup(run, error)) throw error;
    return error;
  }
  assert.fail('The selected host failure unexpectedly completed.');
}

async function fileObservation(path) {
  const stat = await lstat(path, { bigint: true });
  assert(stat.isFile() && stat.size <= 64n * 1024n);
  const bytes = await readFile(path);
  return { ...inode(stat), bytes: bytes.length, sha256: sha(bytes), mode: Number(stat.mode & 0o777n) };
}

async function stoppedAfterImportFailure(run, reserved) {
  const { sandbox, entry } = reserved;
  assert.throws(() => sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: ['-e', '0'],
    env: {}, cwd: sandbox.workspace }), SandboxStateError);
  await run.settleCleanup(entry, 'stop');
  const exported = await metadata(sandbox);
  assert.equal(exported.summary.symlinks, 0n, 'A failed host import must withhold its links; regular effects need not roll back.');
  return exported;
}

async function aliases(run, context, variant) {
  const { sandbox, entry } = await ready(run, context, variant);
  const pairs = [['case', 'A', 'a'], ['unicode', '\u00e9', 'e\u0301']];
  const entries = [directory('positive'), file('positive/payload', Uint8Array.of(0, 255, 7)), link('positive/alias', 'payload')];
  for (const [name, first, second] of pairs) entries.push(file(`${name}/${first}/one`, Uint8Array.of(1)), file(`${name}/${second}/two`, Uint8Array.of(2)));
  await sandbox.importTree(entries, preserve); await run.settleCleanup(entry, 'stop');
  const outcomes = [];
  for (const [name, first, second] of pairs) {
    const probe = join(run.hostDirectory, `${name}-probe`); await mkdir(probe); await mkdir(join(probe, first));
    const original = await lstat(join(probe, first), { bigint: true });
    let aliased = false;
    try {
      const other = await lstat(join(probe, second), { bigint: true });
      aliased = original.dev === other.dev && original.ino === other.ino;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const destination = join(run.hostDirectory, `${name}-publication`);
    const publication = exportSandboxDirectory(sandbox, { kind: 'subtree', path: name }, destination, preserve);
    if (aliased) {
      const error = await rejected(run, publication);
      assert(error instanceof SandboxOperationError); assert.equal(error.code, 'output_limit'); assert.match(error.message, /aliases/u);
      await assertAbsent(destination);
      outcomes.push({ name, firstHex: Buffer.from(first).toString('hex'), secondHex: Buffer.from(second).toString('hex'),
        native: 'same-directory-inode', directory: inode(original), sdk: failure(error), publication: 'absent' });
    } else {
      const result = await publication;
      assert.deepEqual(await readFile(join(result.directory, name, first, 'one')), Buffer.from([1]));
      assert.deepEqual(await readFile(join(result.directory, name, second, 'two')), Buffer.from([2]));
      const left = await lstat(join(result.directory, name, first), { bigint: true });
      const right = await lstat(join(result.directory, name, second), { bigint: true });
      assert.notDeepEqual(inode(left), inode(right));
      outcomes.push({ name, firstHex: Buffer.from(first).toString('hex'), secondHex: Buffer.from(second).toString('hex'),
        native: 'distinct-directories', sdk: 'published-distinct', directories: [inode(left), inode(right)], summary: result.summary });
    }
  }
  const control = await exportSandboxDirectory(sandbox, { kind: 'subtree', path: 'positive' }, join(run.hostDirectory, 'positive-publication'), preserve);
  assert.deepEqual(await readFile(join(control.directory, 'positive/payload')), Buffer.from([0, 255, 7]));
  assert.deepEqual(await readlink(join(control.directory, 'positive/alias'), { encoding: 'buffer' }), Buffer.from('payload'));
  await observed(run, { kind: 'native-case-and-unicode-publication', outcomes, positiveControl: control.summary });
}

async function longTarget(run, context, variant) {
  const target = Array.from({ length: 16 }, () => 'x'.repeat(249)).join('/');
  const supportedTarget = Array.from({ length: 4 }, () => 'x'.repeat(249)).join('/');
  assert.equal(Buffer.byteLength(target), 3999); assert.equal(Buffer.byteLength(supportedTarget), 999);
  const probe = join(run.hostDirectory, 'original-target-probe');
  let native;
  try {
    await symlink(target, probe);
    assert.deepEqual(await readlink(probe, { encoding: 'buffer' }), Buffer.from(target));
    await unlink(probe); native = { kind: 'created' };
  } catch (error) {
    assert.equal(error.code, 'ENAMETOOLONG'); assert.equal(error.syscall, 'symlink'); assert.equal(error.path, target);
    await assertAbsent(probe); native = { kind: 'rejected', error: nativeFailure(error) };
  }
  await observed(run, { kind: 'native-original-3999-byte-target-probe', target: targetIdentity(target), native });
  const { sandbox, entry } = await ready(run, context, variant);
  await sandbox.importTree([directory('original'), link('original/long', target),
    directory('supported'), link('supported/long', supportedTarget)], preserve);
  await run.settleCleanup(entry, 'stop');
  const captured = await metadata(sandbox);
  assert.deepEqual(captured.entries.filter(({ kind }) => kind === 'symlink').map(({ path, target: raw }) => ({ path, target: raw }))
    .sort((left, right) => left.path.localeCompare(right.path)),
    [{ path: 'original/long', target }, { path: 'supported/long', target: supportedTarget }]);
  const destination = join(run.hostDirectory, 'original-publication');
  const publication = exportSandboxDirectory(sandbox, { kind: 'subtree', path: 'original' }, destination, preserve);
  let sdk;
  if (native.kind === 'rejected') {
    const error = await rejected(run, publication);
    assert.equal(error.code, 'ENAMETOOLONG'); assert.equal(error.syscall, 'symlink'); assert.equal(error.path, target);
    await assertAbsent(destination); sdk = { kind: 'rejected', error: nativeFailure(error), publication: 'absent' };
  } else {
    const result = await publication;
    assert.deepEqual(await readlink(join(result.directory, 'original/long'), { encoding: 'buffer' }), Buffer.from(target));
    assert.equal((await lstat(join(result.directory, 'original/long'))).size, 3999);
    sdk = { kind: 'published-exact', summary: result.summary };
  }
  const control = await exportSandboxDirectory(sandbox, { kind: 'subtree', path: 'supported' }, join(run.hostDirectory, 'supported-publication'), preserve);
  assert.deepEqual(await readlink(join(control.directory, 'supported/long'), { encoding: 'buffer' }), Buffer.from(supportedTarget));
  assert.equal((await lstat(join(control.directory, 'supported/long'))).size, 999);
  await observed(run, { kind: 'installed-original-target-publication', target: targetIdentity(target), native, sdk,
    positiveControl: { target: targetIdentity(supportedTarget), summary: control.summary } });
}

async function invalidEncoding(run, context, variant, kind) {
  const source = join(run.hostDirectory, 'source'); await mkdir(source);
  const valid = join(source, 'bad\ufffd'); const validBytes = Buffer.from('distinct-valid-name');
  await writeFile(valid, validBytes, { flag: 'wx' }); const before = await fileObservation(valid);
  const invalidPath = kind === 'filename' ? Buffer.concat([Buffer.from(`${source}/bad`), Buffer.from([0xff])]) : join(source, 'raw-link');
  let native;
  try {
    if (kind === 'filename') await writeFile(invalidPath, 'raw-name', { flag: 'wx' });
    else await symlink(Buffer.from([0xff]), invalidPath);
    native = { kind: 'created' };
  } catch (error) {
    assert.equal(error.code, 'EILSEQ'); assert.equal(error.syscall, kind === 'filename' ? 'open' : 'symlink');
    await assertAbsent(invalidPath); native = { kind: 'rejected', error: nativeFailure(error) };
  }
  const rawNames = (await readdir(source, { encoding: 'buffer' })).map((name) => name.toString('hex')).sort();
  await observed(run, { kind: 'native-encoding-probe', boundary: kind, rawNameHex: kind === 'filename' ? '626164ff' : null,
    rawTargetHex: kind === 'link-target' ? 'ff' : null, replacementNameHex: Buffer.from('bad\ufffd').toString('hex'), native, rawNames });
  const reserved = await ready(run, context, variant); const { sandbox } = reserved;
  let sdk;
  if (native.kind === 'created') {
    const error = await rejected(run, importSandboxDirectory(sandbox, source, preserve));
    if (kind === 'filename') { assert(error instanceof TypeError); assert.match(error.message, /encoded data|encoding/iu); }
    else { assert(error instanceof SandboxOperationError); assert.equal(error.code, 'input_limit'); assert.match(error.message, /valid UTF-8/u); }
    if (kind === 'filename') assert.equal(await readFile(invalidPath, 'utf8'), 'raw-name');
    else assert.deepEqual(await readlink(invalidPath, { encoding: 'buffer' }), Buffer.from([0xff]));
    sdk = { kind: 'rejected-during-traversal', error: failure(error), exported: await stoppedAfterImportFailure(run, reserved) };
  } else {
    const imported = await importSandboxDirectory(sandbox, source, preserve); assert.equal(imported.files, 1n);
    await run.settleCleanup(reserved.entry, 'stop'); const exported = await metadata(sandbox);
    assert.deepEqual(exported.entries.filter(({ kind: entryKind }) => entryKind === 'file').map(({ path, sha256 }) => ({ path, sha256 })),
      [{ path: 'bad\ufffd', sha256: sha(validBytes) }]);
    sdk = { kind: 'remaining-valid-source-imported', imported, exported };
  }
  assert.deepEqual(await fileObservation(valid), before);
  assert.deepEqual((await readdir(source, { encoding: 'buffer' })).map((name) => name.toString('hex')).sort(), rawNames);
  await observed(run, { kind: 'installed-encoding-boundary', boundary: kind, native, sdk,
    validSentinel: before, originalRawEntryCensus: rawNames, validSourcePreserved: true });
}

async function changedSource(run, context, variant, mutation) {
  const source = join(run.hostDirectory, 'source'); await mkdir(source);
  const path = join(source, 'payload'); await writeFile(path, 'original'); await symlink('payload', join(source, 'alias'));
  const before = await fileObservation(path); const reserved = await ready(run, context, variant); const { sandbox } = reserved;
  let entered = 0; let mutated = false; let descriptorFailure;
  const forwarding = { ...sandbox, importTree(entries, options) {
    const controlled = { async *[Symbol.asyncIterator]() {
      for await (const entry of entries) {
        if (entry.kind !== 'file' || entry.path !== 'payload') { yield entry; continue; }
        yield { ...entry, open(input) { return { async *[Symbol.asyncIterator]() {
          entered++; assert.equal(entered, 1);
          if (mutation === 'replacement') { await rename(path, join(run.hostDirectory, 'retained-original')); await writeFile(path, 'replaced', { flag: 'wx' }); }
          else if (mutation === 'truncate') await truncate(path, 2);
          else await writeFile(path, 'original-plus');
          mutated = true;
          try { yield* entry.open(input); }
          catch (error) { descriptorFailure = error; throw error; }
        } }; } };
      }
    } };
    return sandbox.importTree(controlled, options);
  } };
  const error = await rejected(run, importSandboxDirectory(forwarding, source, { ...preserve, chunkBytes: 2 }));
  const members = error instanceof AggregateError && Array.isArray(error.errors) ? error.errors : [];
  await observed(run, { kind: 'source-change-descriptor-and-public-failure', mutation, entered, mutated,
    descriptorFailure: descriptorFailure === undefined ? null : failure(descriptorFailure), publicFailure: failure(error),
    sameObject: descriptorFailure !== undefined && error === descriptorFailure,
    causeIsDescriptor: descriptorFailure !== undefined && error instanceof Error && error.cause === descriptorFailure,
    aggregate: error instanceof AggregateError ? { immediateMemberCount: members.length, membersTruncated: members.length > 4,
      members: members.slice(0, 4).map((member, index) => ({ index,
        sameAsDescriptor: descriptorFailure !== undefined && member === descriptorFailure,
        causeIsDescriptor: descriptorFailure !== undefined && member instanceof Error && member.cause === descriptorFailure })) } : null });
  assert(error instanceof SandboxOperationError); assert.equal(error.code, 'input_limit');
  assert.match(error.message, /Host file identity, length or modification metadata changed/u); assert.equal(mutated, true);
  const after = await fileObservation(path);
  if (mutation === 'replacement') {
    assert(after.device !== before.device || after.inode !== before.inode);
    assert.deepEqual(await fileObservation(join(run.hostDirectory, 'retained-original')), before);
  }
  assert.equal(after.sha256, sha(Buffer.from(mutation === 'replacement' ? 'replaced' : mutation === 'truncate' ? 'or' : 'original-plus')));
  await observed(run, { kind: 'documented-source-change-detected', mutation, boundary: 'captured-entry-before-descriptor-open',
    sourceEntered: entered, before, after, error: failure(error), exported: await stoppedAfterImportFailure(run, reserved),
    guarantee: 'This deliberate source-stability violation tests identity detection; it does not establish an atomic source snapshot.' });
}

async function cancelledImport(run, context, variant) {
  const source = join(run.hostDirectory, 'source'); await mkdir(source);
  const path = join(source, 'payload'); await writeFile(path, 'abcdef'); await symlink('payload', join(source, 'alias'));
  const before = await fileObservation(path); const reserved = await ready(run, context, variant); const { sandbox } = reserved;
  const cancellation = new AbortController(); let chunks = 0; let readersJoined = 0;
  const forwarding = { ...sandbox, importTree(entries, options) {
    return sandbox.importTree({ async *[Symbol.asyncIterator]() {
      for await (const entry of entries) {
        if (entry.kind !== 'file') { yield entry; continue; }
        yield { ...entry, open(input) { return { async *[Symbol.asyncIterator]() {
          try {
            for await (const part of entry.open(input)) {
              chunks++; assert.equal(chunks, 1); yield part;
              cancellation.abort(new Error('Controlled host traversal cancellation after a descriptor chunk.'));
            }
          } finally { readersJoined++; }
        } }; } };
      }
    } }, options);
  } };
  const error = await rejected(run, importSandboxDirectory(forwarding, source, { ...preserve, chunkBytes: 2,
    signal: AbortSignal.any([context.signal, cancellation.signal]) }));
  assert(error instanceof SandboxOperationError); assert.equal(error.code, 'cancelled');
  assert.equal(chunks, 1); assert.equal(readersJoined, 1); assert.equal(cancellation.signal.aborted, true);
  assert.deepEqual(await fileObservation(path), before);
  await observed(run, { kind: 'entered-host-traversal-cancelled-and-reader-joined', chunks, readersJoined,
    source: before, error: failure(error), exported: await stoppedAfterImportFailure(run, reserved) });
}

async function cancelledExport(run, context, variant) {
  const { sandbox, entry } = await ready(run, context, variant);
  await sandbox.importTree([file('payload', Uint8Array.of(0, 255, 7)), link('alias', 'payload')], preserve); await run.settleCleanup(entry, 'stop');
  const destination = join(run.hostDirectory, 'cancelled-publication'); const cancellation = new AbortController();
  let delivered = 0; let callbacksJoined = 0;
  const forwarding = { ...sandbox, exportTree(selection, consume, options) {
    return sandbox.exportTree(selection, async (entry, input) => {
      try {
        await consume(entry, input);
        if (entry.kind === 'file') {
          delivered++; assert.equal(delivered, 1);
          assert((await lstat(destination)).isDirectory()); await assertAbsent(join(destination, 'files'));
          cancellation.abort(new Error('Controlled host publication cancellation after an entered file callback.'));
        }
      } finally { callbacksJoined++; }
    }, options);
  } };
  const error = await rejected(run, exportSandboxDirectory(forwarding, { kind: 'workspace' }, destination,
    { ...preserve, signal: AbortSignal.any([context.signal, cancellation.signal]) }));
  assert(error instanceof SandboxOperationError); assert.equal(error.code, 'cancelled');
  assert.equal(delivered, 1); assert.equal(callbacksJoined, 1); await assertAbsent(destination);
  await observed(run, { kind: 'entered-host-publication-cancelled-without-final-child', delivered, callbacksJoined,
    error: failure(error), publication: 'absent', workspace: await metadata(sandbox) });
}

async function cleanupRetry(run, context, variant) {
  assert.notEqual(process.getuid?.(), 0, 'The native permission-fault case requires an unprivileged controller; root does not prove chmod enforcement.');
  const { sandbox, entry } = await ready(run, context, variant);
  await sandbox.importTree([file('payload', Uint8Array.of(0, 255, 7)), link('alias', 'payload')], preserve); await run.settleCleanup(entry, 'stop');
  const destination = join(run.hostDirectory, 'retained-publication'); let originalIdentity; let restricted = false;
  const restore = async () => {
    if (!restricted) return;
    assert.deepEqual(inode(await lstat(destination, { bigint: true })), originalIdentity);
    await chmod(destination, 0o700); restricted = false;
  };
  run.beforeCleanup.push(restore);
  const forwarding = { ...sandbox, async exportTree(...args) {
    const summary = await sandbox.exportTree(...args);
    await assertAbsent(join(destination, 'files'));
    originalIdentity = inode(await lstat(destination, { bigint: true }));
    await chmod(destination, 0o500); restricted = true;
    assert.equal((await lstat(destination)).mode & 0o777, 0o500);
    return summary;
  } };
  let original;
  try { await exportSandboxDirectory(forwarding, { kind: 'workspace' }, destination, preserve); }
  catch (error) {
    const retained = retainDirectoryCleanup(run, error);
    if (!retained) throw error;
    original = retained;
  }
  assert(original, 'The entered permission cut must retain an actual directory cleanup owner.');
  const error = original.owner; assert(error instanceof SandboxDirectoryCleanupError);
  const primary = error.primaryError; const cleanup = error.cleanupError;
  assert(primary instanceof Error); assert(['EACCES', 'EPERM'].includes(primary.code)); assert.equal(primary.syscall, 'rename');
  assert(cleanup instanceof Error); assert(['EACCES', 'EPERM'].includes(cleanup.code));
  assert.equal(error.publishedDirectory, undefined); await assertAbsent(join(destination, 'files'));
  await observed(run, { kind: 'native-permission-cut-retains-original-directory-owner', destination,
    identity: originalIdentity, primary: nativeFailure(primary), cleanup: nativeFailure(cleanup), publication: 'absent' });
  await restore();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const observation = { attempt, startedAt: new Date().toISOString(), status: 'entered' };
    original.errorEvidence.attempts.push(observation); await run.save();
    try { await error.retryCleanup(); observation.status = 'fulfilled'; }
    catch (failureValue) { observation.status = 'rejected'; observation.failure = failure(failureValue); throw failureValue; }
    finally { observation.finishedAt = new Date().toISOString(); await run.save(); }
  }
  original.errorEvidence.complete = true;
  assert.equal(error.primaryError, primary); assert.equal(error.cleanupError, cleanup); await assertAbsent(destination);
  await observed(run, { kind: 'same-directory-cleanup-owner-retried-idempotently', destination, attempts: 2,
    originalPrimaryUnchanged: true, originalCleanupUnchanged: true, publication: 'absent' });
}

export function hostFailureCases(context) {
  return variantCases(context, [
    ['host-case-and-unicode-alias-publication', (run, variant) => aliases(run, context, variant)],
    ['host-original-long-target-native-limit', (run, variant) => longTarget(run, context, variant)],
    ['host-invalid-utf8-filename', (run, variant) => invalidEncoding(run, context, variant, 'filename')],
    ['host-invalid-utf8-link-target', (run, variant) => invalidEncoding(run, context, variant, 'link-target')],
    ...['replacement', 'truncate', 'grow'].map((mutation) => [`host-source-${mutation}-detected`, (run, variant) => changedSource(run, context, variant, mutation)]),
    ['host-import-traversal-cancellation', (run, variant) => cancelledImport(run, context, variant)],
    ['host-export-publication-cancellation', (run, variant) => cancelledExport(run, context, variant)],
    ['host-publication-permission-cleanup-retry', (run, variant) => cleanupRetry(run, context, variant)],
  ]);
}
