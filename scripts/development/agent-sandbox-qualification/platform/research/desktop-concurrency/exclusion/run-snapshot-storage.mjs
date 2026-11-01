// G05 process-crash storage proof. No Docker, network request, model or credential access.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineKey, openHolder } from './controller.mjs';

const MAX_STATE = 1024 * 1024;
const attempt = await mkdtemp('/private/tmp/agenai-ms001-snapshot-');
const root = join(attempt, 'fixed-research-root');
await mkdir(root, { mode: 0o700 });
const binary = join(attempt, 'snapshot-holder');
const compile = spawnSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  `-DSNAPSHOT_RESEARCH_ROOT=${JSON.stringify(root)}`, fileURLToPath(new URL('./snapshot-holder.c', import.meta.url)), '-o', binary],
{ encoding: 'utf8', timeout: 30000 });
if (compile.status !== 0) throw new Error(`snapshot_compile:${compile.stderr}`);
const active = new Set();
const rows = [];
let sequence = 0;
const id = (name) => `synthetic-snapshot-${name}-${++sequence}`;
const path = (identity, suffix) => join(root, `${engineKey(identity)}.${suffix}`);
const open = async (identity, mode, launcher) => {
  const holder = await openHolder(binary, identity, launcher ?? { args: [engineKey(identity), ...(mode ? [mode] : [])] });
  active.add(holder);
  return holder;
};
const snapshot = async (holder, expectedGeneration) => {
  const result = await holder.command('SNAPSHOT');
  const value = JSON.parse(result.text);
  assert.equal(value.format, 'agenai.ms001-snapshot.v1');
  assert.equal(value.phase === 'clean', value.obligations.length === 0);
  if (expectedGeneration !== undefined && value.generation !== expectedGeneration) throw new Error('recovery_generation_conflict');
  return { ...result, value };
};
const activateSnapshot = async (identity) => {
  const holder = await open(identity);
  try {
    const current = await snapshot(holder);
    if (current.value.phase !== 'clean') throw new Error(`dirty_generation:${current.value.generation}`);
    return holder;
  } catch (error) { await holder.close(); throw error; }
};
const state = (generation, number, obligations = []) => ({ format: 'agenai.ms001-snapshot.v1', generation,
  sequence: number, phase: obligations.length ? 'dirty' : 'clean', obligations });
const commands = (value) => ['OPEN_TEMP', `WRITE ${JSON.stringify(value)}`, 'SYNC_TEMP', 'RENAME', 'SYNC_DIRECTORY', 'FINISH'];
const commit = async (holder, value) => {
  assert.equal(value.phase === 'clean', value.obligations.length === 0);
  for (const command of commands(value)) await holder.command(command);
};
const bootstrap = async (identity) => { const holder = await open(identity, 'bootstrap'); await holder.close(); };
const kill = async (holder) => { holder.child.kill('SIGKILL'); await holder.ended; };
const row = async (name, operation) => {
  try { rows.push({ name, result: 'pass', ...await operation() }); }
  catch (error) { rows.push({ name, result: 'fail', error: error.stack }); throw error; }
};
const sizes = async (identity) => {
  const names = (await readdir(root)).filter((name) => name.startsWith(`${engineKey(identity)}.`));
  return Promise.all(names.map(async (name) => ({ name, bytes: (await stat(join(root, name))).size })));
};

try {
  await row('explicit bootstrap and stable lock are required; no activation creation fallback', async () => {
    const identity = id('bootstrap');
    await assert.rejects(open(identity), /lock_open/);
    const holder = await open(identity, 'bootstrap');
    assert.equal((await snapshot(holder)).value.phase, 'clean');
    await assert.rejects(open(identity), /contended/);
    await holder.close();
    await assert.rejects(open(identity, 'bootstrap'), /bootstrap_existing_authority/);
    await rm(path(identity, 'lock'));
    await assert.rejects(open(identity, 'bootstrap'), /bootstrap_existing_authority/);
    await assert.rejects(stat(path(identity, 'lock')), { code: 'ENOENT' });
    await assert.rejects(open(identity), /lock_open/);
    return { automaticStateCreation: false, duplicateClaimRejected: true, partialBootstrapNotRepaired: true };
  });

  const cuts = [{ name: 'before_temp', commands: 0 }, { name: 'temp_opened', commands: 1 },
    { name: 'temp_written', commands: 2 }, { name: 'temp_fsynced', commands: 3 },
    { name: 'renamed', commands: 4 }, { name: 'directory_fsynced', commands: 5 }, { name: 'commit_acknowledged', commands: 6 }];
  for (const cut of cuts) {
    await row(`SIGKILL after ${cut.name} preserves a complete conservative published snapshot`, async () => {
      const identity = id(cut.name), generation = randomUUID();
      await bootstrap(identity);
      const holder = await open(identity);
      const initialLock = holder.identity;
      await commit(holder, state(generation, 1, ['original-effect-a']));
      const original = await snapshot(holder, generation);
      const next = state(generation, 2, ['original-effect-a', 'armed-effect-b']);
      for (const command of commands(next).slice(0, cut.commands)) await holder.command(command);
      const preCrashSizes = await sizes(identity);
      await kill(holder);
      if (cut.commands > 0 && cut.commands < 4) await assert.rejects(open(identity), /unpublished_temp/);
      const recovery = await open(identity, 'cleanup');
      assert.deepEqual(recovery.identity, initialLock);
      const current = await snapshot(recovery, generation);
      assert.equal(current.value.sequence, cut.commands >= 4 ? 2 : 1);
      assert.equal(current.value.phase, 'dirty');
      assert.deepEqual(current.value.obligations, cut.commands >= 4 ? next.obligations : original.value.obligations);
      assert.equal(current.pendingTemp, cut.commands > 0 && cut.commands < 4);
      if (current.pendingTemp) {
        await recovery.command('DISCARD_UNPUBLISHED_TEMP');
        const afterDiscard = await snapshot(recovery, generation);
        assert.deepEqual(afterDiscard.value, current.value);
        assert.equal(afterDiscard.pendingTemp, false);
      }
      await recovery.close();
      await assert.rejects(activateSnapshot(identity), /dirty_generation/);
      return { cut: cut.name, publishedSequence: current.value.sequence, oldStateSelected: cut.commands < 4,
        obligations: current.value.obligations, lockInode: initialLock.inode, stateInode: current.stateInode,
        incompleteTempNeverPromoted: true, sizes: preCrashSizes };
    });
  }

  await row('selected maximum budgets fit one bounded current snapshot and retain cleanup replacement space', async () => {
    const identity = id('capacity'), generation = randomUUID();
    await bootstrap(identity);
    const holder = await open(identity);
    const lock = holder.identity;
    const allocation = { originals: Array(4).fill('o'.repeat(64 * 1024)), metadata: Array(4).fill('m'.repeat(32 * 1024)),
      transitions: Array(17).fill('t'.repeat(4 * 1024)), tombstones: Array(256).fill('x'.repeat(256)), envelope: 'e'.repeat(16 * 1024) };
    const maximum = { ...state(generation, 1, ['held-owned-obligation']), allocation };
    const payloadBytes = Buffer.byteLength(JSON.stringify(maximum));
    assert.equal(payloadBytes < MAX_STATE, true);
    await commit(holder, maximum);
    const peakState = await stat(path(identity, 'state'));
    assert.equal(peakState.size <= MAX_STATE, true);
    await holder.command('OPEN_TEMP');
    await holder.command(`WRITE ${JSON.stringify(state(generation, 2))}`);
    const peak = await sizes(identity);
    assert.equal(peak.filter((entry) => entry.name.endsWith('.next')).length, 1);
    assert.equal(peak.reduce((sum, entry) => sum + entry.bytes, 0) <= MAX_STATE * 2, true);
    for (const command of ['SYNC_TEMP', 'RENAME', 'SYNC_DIRECTORY', 'FINISH']) await holder.command(command);
    assert.equal((await snapshot(holder, generation)).value.phase, 'clean');
    for (let iteration = 0; iteration < 50; iteration++) {
      await commit(holder, state(generation, iteration * 2 + 3, ['same-bounded-owner']));
      await commit(holder, state(generation, iteration * 2 + 4));
    }
    assert.deepEqual(holder.identity, lock);
    const final = await sizes(identity);
    assert.deepEqual(final.map((entry) => entry.name.split('.').at(-1)).sort(), ['lock', 'state']);
    assert.equal((await stat(path(identity, 'lock'))).ino, lock.inode);
    await holder.close();
    return { allocatedContentBytes: 4 * 64 * 1024 + 4 * 32 * 1024 + 17 * 4 * 1024 + 256 * 256 + 16 * 1024,
      actualJsonPayloadBytes: payloadBytes, maximumPublishedBytes: peakState.size, maximumStateCapBytes: MAX_STATE,
      maximumTempCapBytes: MAX_STATE, measuredPeakFixtureFiles: peak, repeatedCommitCount: 102,
      appendHistoryFiles: 0, finalFiles: final, note: 'Capacity/lifecycle proof, not a performance measurement or real v3 max-record fixture.' };
  });

  await row('oversize state is refused without replacing valid current authority', async () => {
    const identity = id('oversize');
    await bootstrap(identity);
    const holder = await open(identity);
    const before = await snapshot(holder);
    await holder.command('OPEN_TEMP');
    await assert.rejects(holder.command(`WRITE ${JSON.stringify({ large: 'z'.repeat(MAX_STATE - 128) })}`), /snapshot_capacity/);
    await holder.ended;
    const cleanup = await open(identity, 'cleanup');
    assert.deepEqual((await snapshot(cleanup)).value, before.value);
    assert.equal((await stat(path(identity, 'next'))).size, 0);
    await cleanup.command('DISCARD_UNPUBLISHED_TEMP');
    await cleanup.close();
    return { originalPublishedStateRetained: true, oversizedBytesPublished: 0 };
  });

  await row('a physically full 1MiB current state and 1MiB temp still permit bounded cleanup replacement', async () => {
    const identity = id('full-physical-cap'), generation = randomUUID();
    await bootstrap(identity);
    const holder = await open(identity);
    const headerBytes = Buffer.byteLength('AGENAI-SNAPSHOT-1\n') + 65 + 65;
    const full = (number) => {
      const value = { ...state(generation, number, ['storage-only-fixture-obligation']), storagePadding: '' };
      value.storagePadding = 'p'.repeat(MAX_STATE - headerBytes - Buffer.byteLength(JSON.stringify(value)));
      return value;
    };
    await commit(holder, full(1));
    assert.equal((await stat(path(identity, 'state'))).size, MAX_STATE);
    await holder.command('OPEN_TEMP');
    await holder.command(`WRITE ${JSON.stringify(full(2))}`);
    const peak = await sizes(identity);
    assert.equal(peak.filter((entry) => entry.name.endsWith('.next')).length, 1);
    assert.equal(peak.reduce((total, entry) => total + entry.bytes, 0), MAX_STATE * 2);
    for (const command of ['SYNC_TEMP', 'RENAME', 'SYNC_DIRECTORY', 'FINISH']) await holder.command(command);
    await commit(holder, state(generation, 3));
    assert.equal((await snapshot(holder, generation)).value.phase, 'clean');
    assert.equal((await stat(path(identity, 'state'))).size < 1024, true);
    assert.deepEqual((await sizes(identity)).map((entry) => entry.name.split('.').at(-1)).sort(), ['lock', 'state']);
    await holder.close();
    return { peakBytes: MAX_STATE * 2, exactStateBytes: MAX_STATE, exactTempBytes: MAX_STATE,
      cleanupReplacementSucceeded: true, note: 'Padding fills storage capacity only; it is not an additional public record allowance.' };
  });

  await row('real partial temp-write failure retains valid previous state and never promotes temp', async () => {
    const identity = id('io-failure');
    await bootstrap(identity);
    const limited = await open(identity, undefined, { command: '/usr/bin/python3', args: ['-c',
      'import os,resource,sys;resource.setrlimit(resource.RLIMIT_FSIZE,(256,256));os.execv(sys.argv[1],sys.argv[1:])', binary, engineKey(identity)] });
    await limited.command('OPEN_TEMP');
    await assert.rejects(limited.command(`WRITE ${JSON.stringify(state('pending', 1, ['q'.repeat(4096)]))}`), /snapshot_write:27/);
    await limited.ended;
    await assert.rejects(open(identity), /unpublished_temp/);
    const cleanup = await open(identity, 'cleanup');
    assert.equal((await snapshot(cleanup)).value.generation, 'bootstrap');
    const partialBytes = (await stat(path(identity, 'next'))).size;
    assert.equal(partialBytes, 256);
    await cleanup.command('DISCARD_UNPUBLISHED_TEMP');
    await cleanup.close();
    return { fault: 'Darwin RLIMIT_FSIZE / EFBIG with inherited ignored SIGXFSZ', partialBytes, originalStateTrusted: true };
  });

  await row('missing, corrupt, foreign-Engine and symbolic current state refuse without a fallback', async () => {
    const missing = id('missing'); await bootstrap(missing); await rm(path(missing, 'state'));
    await assert.rejects(open(missing), /state_open/);
    const corrupt = id('corrupt'); await bootstrap(corrupt);
    const content = await readFile(path(corrupt, 'state')); content[content.length - 1] ^= 1;
    await writeFile(path(corrupt, 'state'), content);
    await assert.rejects(open(corrupt), /state_checksum/);
    const foreign = id('foreign'); await bootstrap(foreign);
    const donor = id('donor'); await bootstrap(donor);
    await copyFile(path(donor, 'state'), path(foreign, 'state'));
    await assert.rejects(open(foreign), /state_engine_or_format_conflict/);
    const symbolic = id('symbolic'); await bootstrap(symbolic);
    await rm(path(symbolic, 'state')); await symlink(path(donor, 'state'), path(symbolic, 'state'));
    await assert.rejects(open(symbolic), /state_open/);
    return { missingRefused: true, corruptRefused: true, foreignEngineRefused: true, symbolicRefused: true };
  });

  await row('unexpected state inode or generation cannot replace the original live recovery binding', async () => {
    const identity = id('identity'); await bootstrap(identity);
    const holder = await open(identity);
    const generation = randomUUID();
    await commit(holder, state(generation, 1, ['original-owned-id']));
    await assert.rejects(snapshot(holder, 'different-generation'), /recovery_generation_conflict/);
    await rename(path(identity, 'state'), path(identity, 'retained-state'));
    await copyFile(path(identity, 'retained-state'), path(identity, 'state'));
    await assert.rejects(holder.command('SNAPSHOT'), /state_replaced/);
    return { liveInodeSubstitutionRefused: true, generationConflictRefused: true };
  });

  await row('symbolic temp is refused by both activation and cleanup and target remains unchanged', async () => {
    const identity = id('temp-symbolic'); await bootstrap(identity);
    const target = join(attempt, 'unowned-temp-target'); await writeFile(target, 'unchanged');
    await symlink(target, path(identity, 'next'));
    await assert.rejects(open(identity), /temp_conflict/);
    await assert.rejects(open(identity, 'cleanup'), /temp_conflict/);
    assert.equal(await readFile(target, 'utf8'), 'unchanged');
    return { targetUntouched: true };
  });
} finally {
  for (const holder of active) holder.child.kill('SIGKILL');
  await Promise.all([...active].map((holder) => holder.ended));
  const sourceNames = ['snapshot-holder.c', 'run-snapshot-storage.mjs', 'controller.mjs'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceNames.map(async (name) => [name,
    createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])));
  const report = { format: 'agenai.ms001-snapshot-storage.v1', at: new Date().toISOString(), attempt,
    platform: process.platform, architecture: process.arch, node: process.version, sourceHashes,
    sourceDigestEncoding: 'SHA-256 of raw file bytes', maxStateBytes: MAX_STATE, maxTempBytes: MAX_STATE,
    dockerRequests: 0, powerLossQualified: false, rows,
    rule: 'Only committed current state grants authority; unpublished temp never grants authority or replaces missing/corrupt current state.' };
  await writeFile(join(attempt, 'snapshot-storage-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ attempt, passed: rows.filter((entry) => entry.result === 'pass').length,
    failed: rows.filter((entry) => entry.result === 'fail').length, report: join(attempt, 'snapshot-storage-report.json') }, null, 2)}\n`);
}
