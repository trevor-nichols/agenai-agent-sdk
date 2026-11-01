// Explicit, bounded OS/filesystem experiments. This never contacts Docker.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { activate, assertRecoveryBinding, digest, engineKey, openHolder, parseJournal } from './controller.mjs';
import { prepare } from './prepare.mjs';

// Research uses the existing built public export surface, not an installed-package proof.
const { parseSandboxRecoveryRecord } = await import(new URL('../../../../../../../packages/ai/sandbox/dist/index.js', import.meta.url));
const actualEngineId = process.argv[2] ?? 'synthetic-engine-ms001';
const attempt = await mkdtemp('/private/tmp/agenai-ms001-exclusion-');
const prepared = await prepare(attempt);
const active = new Set();
const processes = new Set();
const descendantPids = new Set();
const rows = [];
let serial = 0;
const caseId = (name) => `synthetic:${name}:${++serial}`;
const own = (value) => { active.add(value.holder ?? value); return value; };
const open = async (id, binary = prepared.binary) => own(await openHolder(binary, id));
const start = async (id, config = {}, binary = prepared.binary, launcher) => own(await activate(binary, id, config, launcher));
const journalPath = (id) => join(prepared.root, `${engineKey(id)}.journal`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (operation) => {
  for (let index = 0; index < 100; index++) { if (await operation()) return; await delay(20); }
  throw new Error('bounded_wait_expired');
};
const fixture = (generation = 'generation-a', profile = 'native-arm64') => {
  const operationId = randomUUID();
  return parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'docker-engine',
    backendRevision: `engine-1.52-v7-research-${profile}`, namespace: 'ms001-research', operationId,
    sandboxId: `docker-${operationId}`, imageDigest: `sha256:${'a'.repeat(64)}`,
    policyDigest: `sha256:${'b'.repeat(64)}`,
    configurationDigest: `sha256:${digest({ generation, profile })}`, phase: 'starting',
    authority: { kind: 'verified', backendIdentity: 'synthetic-engine' },
    resources: [{ role: 'compute', name: `research-${operationId}`, identity: { kind: 'creating' } }] });
};
const row = async (name, operation) => {
  try { const evidence = await operation(); rows.push({ name, result: 'pass', ...evidence }); }
  catch (error) { rows.push({ name, result: 'fail', error: error.stack }); throw error; }
};
const readJournal = async (holder) => parseJournal((await holder.command('SNAPSHOT')).text);
const controllerWorker = async (id, stage) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), prepared.binary,
    id, stage, JSON.stringify(fixture()), join(attempt, `${stage}-${serial}.effect`)], { stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(child);
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  const ready = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('worker_ready_timeout')); }, 5000);
    createInterface({ input: child.stdout }).once('line', (line) => { clearTimeout(deadline); resolve(JSON.parse(line)); });
    child.once('exit', (code, signal) => { clearTimeout(deadline); reject(new Error(`worker_before_ready:${code}:${signal}:${stderr}`)); });
  });
  return { child, ready };
};

try {
  await row('same Engine excludes separate copied modules and helper binaries', async () => {
    const copies = await Promise.all(prepared.copies.map(({ directory }) => import(pathToFileURL(join(directory, 'controller.mjs')).href)));
    const first = own(await copies[0].activate(prepared.copies[0].binary, actualEngineId,
      { namespace: 'a', profile: 'native-arm64', journalRoot: '/ignored/a', endpointAlias: 'alias-a' }));
    await assert.rejects(copies[1].activate(prepared.copies[1].binary, actualEngineId,
      { namespace: 'b', profile: 'rosetta-amd64', journalRoot: '/ignored/b', endpointAlias: 'alias-b' }), /contended/);
    assert.deepEqual(await first.holder.command('DUPLICATE'), { kind: 'duplicate_excluded' });
    await assert.rejects(openHolder(prepared.binary, actualEngineId), /contended/);
    process.kill(first.holder.child.pid, 'SIGSTOP');
    await assert.rejects(openHolder(prepared.binary, actualEngineId), /contended/);
    process.kill(first.holder.child.pid, 'SIGCONT');
    const generation = first.record.generation;
    first.holder.child.kill('SIGKILL');
    await first.holder.ended;
    const successor = await open(actualEngineId);
    assert.equal((await readJournal(successor)).record.generation, generation);
    await successor.close();
    await assert.rejects(copies[1].activate(prepared.copies[1].binary, actualEngineId,
      { namespace: 'c', journalRoot: '/ignored/c' }), /dirty_generation/);
    return { engineId: actualEngineId, generation, kernelClaimReleased: true, dirtyBarrierRetained: true,
      note: 'Engine ID is supplied; aliases/profile names are metadata here, not physical Engine proof.' };
  });

  await row('native arm64 and installed-Rosetta x86_64 helper contend in both directions', async () => {
    const firstId = caseId('cross-architecture-native-holder');
    const native = await start(firstId, { profile: 'native-arm64' });
    await assert.rejects(openHolder(prepared.translatedBinary, firstId), /contended/);
    await native.holder.close();
    await assert.rejects(activate(prepared.translatedBinary, firstId, { profile: 'rosetta-amd64' }), /dirty_generation/);
    const secondId = caseId('cross-architecture-translated-holder');
    const translated = await start(secondId, { profile: 'rosetta-amd64' }, prepared.translatedBinary);
    await assert.rejects(openHolder(prepared.binary, secondId), /contended/);
    await translated.holder.close();
    await assert.rejects(activate(prepared.binary, secondId, {}), /dirty_generation/);
    return { nativeArchitecture: 'arm64', translatedArchitecture: 'x86_64',
      architectures: spawnSync('/usr/bin/file', [prepared.binary, prepared.translatedBinary], { encoding: 'utf8' }).stdout.trim(),
      note: 'Native kernel lock interoperability; public SDK controllers remain native arm64 for both workload profiles.' };
  });

  await row('parent SIGKILL releases helper through pipe EOF; independent child holds no writer', async () => {
    const id = caseId('parent-death');
    const { child, ready } = await controllerWorker(id, 'inheritance');
    descendantPids.add(ready.independentPid);
    child.kill('SIGSTOP');
    await assert.rejects(openHolder(prepared.binary, id), /contended/);
    child.kill('SIGCONT');
    child.kill('SIGKILL');
    await until(() => !alive(ready.helperPid));
    assert.equal(alive(ready.independentPid), true);
    const successor = await open(id);
    assert.equal((await readJournal(successor)).record.generation, ready.generation);
    await successor.close();
    process.kill(ready.independentPid, 'SIGKILL');
    descendantPids.delete(ready.independentPid);
    await assert.rejects(activate(prepared.binary, id, {}), /dirty_generation/);
    return { helperPid: ready.helperPid, unrelatedChildSurvived: true };
  });

  await row('close-on-exec prevents inherited lock from surviving helper close', async () => {
    const id = caseId('exec-inheritance');
    const owner = await start(id);
    const child = await owner.holder.command('EXEC_CHILD');
    descendantPids.add(child.pid);
    // /bin/sleep must have completed exec before closing the last parent descriptor.
    await until(() => spawnSync('/bin/ps', ['-p', String(child.pid), '-o', 'comm='], { encoding: 'utf8' }).stdout.trim().split('/').at(-1) === 'sleep');
    await owner.holder.close();
    const successor = await open(id);
    assert.equal(alive(child.pid), true);
    assert.equal((await readJournal(successor)).record.phase, 'active');
    await successor.close();
    process.kill(child.pid, 'SIGKILL');
    descendantPids.delete(child.pid);
    return { descendantAliveAfterReacquisition: true };
  });

  await row('helper failure closes further dispatch and retains dirty authority', async () => {
    const id = caseId('helper-failure');
    const owner = await start(id);
    const member = fixture(owner.record.generation);
    await owner.register(member);
    await owner.begin(member, async () => {});
    owner.holder.child.kill('SIGKILL');
    await owner.holder.ended;
    const effect = join(attempt, 'helper-failure.effect');
    await assert.rejects(owner.dispatch(() => writeFile(effect, 'unsafe')), /holder_exit/);
    await assert.rejects(readFile(effect), { code: 'ENOENT' });
    await assert.rejects(activate(prepared.binary, id, {}), /dirty_generation/);
    return { effectDispatched: false };
  });

  for (const stage of ['generation', 'registered', 'member_intent', 'authorized', 'effect_entered', 'settled']) {
    await row(`controller SIGKILL at ${stage} retains original generation`, async () => {
      const id = caseId(stage);
      const { child, ready } = await controllerWorker(id, stage);
      child.kill('SIGKILL');
      await until(() => !alive(ready.helperPid));
      const successor = await open(id);
      const journal = await readJournal(successor);
      assert.equal(journal.record.generation, ready.generation);
      assert.equal(journal.record.phase, 'active');
      if (stage === 'authorized' || stage === 'effect_entered') assert.equal(journal.record.transition.state, 'authorized');
      if (stage === 'settled') assert.equal(journal.record.transition, null);
      await successor.close();
      await assert.rejects(activate(prepared.binary, id, { namespace: 'different' }), /dirty_generation/);
      return { generation: ready.generation, canonicalMembers: journal.record.members.length,
        transition: journal.record.transition?.state ?? null };
    });
  }

  await row('late entered subprocess effect can settle after controller death and lock release', async () => {
    const id = caseId('late-effect');
    const { child, ready } = await controllerWorker(id, 'late_effect');
    descendantPids.add(ready.effectPid);
    assert.equal(await readFile(ready.effectPath, 'utf8'), 'entered');
    child.kill('SIGKILL');
    await until(() => !alive(ready.helperPid));
    const successor = await open(id);
    assert.equal((await readJournal(successor)).record.transition.state, 'authorized');
    await successor.close();
    await assert.rejects(activate(prepared.binary, id, { namespace: 'late-successor' }), /dirty_generation/);
    await until(async () => await readFile(ready.effectPath, 'utf8') === 'late-effect-completed');
    await until(() => !alive(ready.effectPid));
    descendantPids.delete(ready.effectPid);
    await assert.rejects(activate(prepared.binary, id, {}), /dirty_generation/);
    return { effectCompletedAfterLockReleased: true,
      scope: 'real local subprocess filesystem effect; this is not a Docker late-request proof' };
  });

  await row('canonical shared journal I/O failure precedes member dispatch', async () => {
    const id = caseId('shared-io');
    const python = '/usr/bin/python3';
    const script = 'import os,resource,sys;resource.setrlimit(resource.RLIMIT_FSIZE,(128,128));os.execv(sys.argv[1],sys.argv[1:])';
    await assert.rejects(activate(prepared.binary, id, {}, { command: python,
      args: ['-c', script, prepared.binary, engineKey(id)] }), /journal_write/);
    const bytes = await readFile(journalPath(id), 'utf8');
    assert.equal(Buffer.byteLength(bytes), 128);
    assert.throws(() => parseJournal(bytes), /torn_journal/);
    await assert.rejects(activate(prepared.binary, id, {}), /torn_journal/);
    return { actualFailure: 'Darwin RLIMIT_FSIZE / EFBIG', partialBytes: 128, effectDispatched: false };
  });

  await row('member checkpoint failure fences shared acquisition before dispatch', async () => {
    const id = caseId('member-io');
    const owner = await start(id);
    const member = fixture(owner.record.generation);
    await owner.register(member);
    const directory = join(attempt, 'member-persistence-directory');
    await mkdir(directory);
    await assert.rejects(owner.begin(member, (record) => writeFile(directory, JSON.stringify(record))), { code: 'EISDIR' });
    await assert.rejects(owner.dispatch(async () => assert.fail('must not dispatch')), { code: 'EISDIR' });
    assert.equal((await readJournal(owner.holder)).record.transition, null);
    await owner.holder.close();
    await assert.rejects(activate(prepared.binary, id, {}), /dirty_generation/);
    return { actualFailure: 'member persistence EISDIR', transitionAuthorized: false };
  });

  await row('returned identity survives failed durable acknowledgement in original memory', async () => {
    const id = caseId('returned-identity');
    const owner = await start(id);
    const member = fixture(owner.record.generation);
    await owner.register(member);
    await owner.begin(member, async () => {});
    const returned = { id: 'exact-effect-id-42', fingerprint: 'exact-effect-fingerprint' };
    await assert.rejects(owner.dispatch(async () => {
      owner.holder.child.kill('SIGKILL');
      await owner.holder.ended;
      return returned;
    }), /holder_exit/);
    assert.deepEqual(owner.record.transition.returned, returned);
    const successor = await open(id);
    assert.equal((await readJournal(successor)).record.transition.state, 'authorized');
    await successor.close();
    return { originalMemory: returned, freshOwner: 'pending original intent; no invented acknowledgement' };
  });

  await row('no-follow rejects symbolic link journal and hard-link alias', async () => {
    const symlinkId = caseId('symlink');
    const target = join(attempt, 'unowned-target');
    await writeFile(target, 'unchanged');
    await symlink(target, journalPath(symlinkId));
    await assert.rejects(openHolder(prepared.binary, symlinkId), /journal_open/);
    assert.equal(await readFile(target, 'utf8'), 'unchanged');
    const hardlinkId = caseId('hardlink');
    const owner = await start(hardlinkId);
    await link(journalPath(hardlinkId), join(attempt, 'hardlink'));
    await assert.rejects(owner.holder.command('CHECK'), /journal_replaced/);
    return { symbolicTargetUntouched: true, hardlinkRefused: true };
  });

  await row('journal inode replacement fences holder and retains dirty replacement refusal', async () => {
    const id = caseId('replacement');
    const owner = await start(id);
    const original = journalPath(id);
    const retained = `${original}.original`;
    await rename(original, retained);
    await copyFile(retained, original);
    await chmod(original, 0o600);
    await assert.rejects(activate(prepared.binary, id, {}), /dirty_generation/);
    await assert.rejects(owner.holder.command('CHECK'), /journal_replaced/);
    await owner.holder.ended;
    await assert.rejects(activate(prepared.binary, id, {}), /dirty_generation/);
    return { oldHolderFenced: true, replacementContainsDirtyRecord: true,
      limitation: 'A same-user writer replacing the entire authority with forged clean data is outside cooperation scope.' };
  });

  await row('v3 parser and immutable generation/profile/configuration binding preserve cleanup-only authority', async () => {
    const id = caseId('recovery-binding');
    const owner = await start(id);
    const original = fixture(owner.record.generation);
    await owner.register(original);
    const cleanup = assertRecoveryBinding(owner.record, original, id, owner.record.generation, original.configurationDigest);
    assert.deepEqual(cleanup, { kind: 'cleanup_only', generation: owner.record.generation, operationId: original.operationId });
    const next = parseSandboxRecoveryRecord({ ...original, phase: 'running', resources: original.resources.map((resource) => ({ ...resource,
      identity: { kind: 'identified', id: 'exact-id', fingerprint: `sha256:${'c'.repeat(64)}` } })) });
    assert.deepEqual(assertRecoveryBinding(owner.record, next, id, owner.record.generation, original.configurationDigest), cleanup);
    for (const changed of [{ ...original, configurationDigest: `sha256:${'d'.repeat(64)}` },
      { ...original, backendRevision: 'engine-1.52-v7-research-rosetta-amd64' },
      { ...original, operationId: randomUUID() }]) {
      assert.throws(() => assertRecoveryBinding(owner.record, changed, id, owner.record.generation, original.configurationDigest), /recovery_conflict/);
    }
    assert.throws(() => assertRecoveryBinding(owner.record, original, id, 'other-generation', original.configurationDigest), /recovery_conflict/);
    assert.throws(() => parseSandboxRecoveryRecord({ ...original, coordinatorGeneration: 'not-a-v3-field' }));
    await owner.holder.close();
    const bytes = await readFile(journalPath(id), 'utf8');
    await writeFile(journalPath(id), bytes.replace('ms001-research', 'edited-research'));
    await assert.rejects(activate(prepared.binary, id, {}), /journal_integrity/);
    return { neutralFormat: 'agenai.sandbox-recovery.v3', originalIdentityUnchanged: true,
      nativeCleanup: 'not exercised; this returns a research cleanup-only descriptor' };
  });

  await row('clean close requires empty obligations and allows a new generation', async () => {
    const id = caseId('clean');
    const owner = await start(id);
    const member = fixture(owner.record.generation);
    await owner.register(member);
    await assert.rejects(owner.clean(), /unresolved_obligations/);
    // This fixture has never dispatched any effect; original owner can retire it.
    await owner.checkpoint({ ...owner.record, members: [] });
    await owner.clean();
    await owner.holder.close();
    const next = await start(id);
    assert.notEqual(next.record.generation, owner.record.generation);
    await next.clean();
    await next.holder.close();
    return { cleanupCondition: 'zero member records and no pending transition', nextGenerationDistinct: true };
  });

  await row('bounded membership rejects the ninth member before journal mutation', async () => {
    const id = caseId('capacity');
    const owner = await start(id);
    for (let index = 0; index < 8; index++) await owner.register(fixture(owner.record.generation));
    const sequence = owner.journal.sequence;
    await assert.rejects(owner.register(fixture(owner.record.generation)), /member_capacity/);
    assert.equal(owner.journal.sequence, sequence);
    assert.equal((await readJournal(owner.holder)).record.members.length, 8);
    return { bound: 8, ninthMemberRegistered: false };
  });

  await row('canonical root replacement and symbolic root are refused by the live holder', async () => {
    const id = caseId('root-replacement');
    const owner = await start(id);
    const retained = `${prepared.root}.retained`;
    await rename(prepared.root, retained);
    await mkdir(prepared.root, { mode: 0o700 });
    await assert.rejects(owner.holder.command('CHECK'), /root_replaced/);
    await owner.holder.ended;
    await rm(prepared.root, { recursive: true });
    await symlink(retained, prepared.root);
    await assert.rejects(openHolder(prepared.binary, id), /root_component/);
    await rm(prepared.root);
    await rename(retained, prepared.root);
    return { liveReplacementFenced: true, symbolicRootRefused: true,
      limitation: 'A fresh process cannot identify wholesale same-user removal without an external trust anchor.' };
  });
} finally {
  for (const holder of active) { holder.child.kill('SIGCONT'); holder.child.kill('SIGKILL'); }
  for (const child of processes) child.kill('SIGKILL');
  for (const pid of descendantPids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await Promise.all([...active].map((holder) => holder.ended));
  const sources = Object.fromEntries(await Promise.all(['lock-holder.c', 'controller.mjs', 'prepare.mjs', 'worker.mjs', 'run.mjs']
    .map(async (name) => [name, createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])));
  const report = { researchOnly: true, attempt, date: new Date().toISOString(), platform: process.platform,
    architecture: process.arch, node: process.version, actualEngineIdSupplied: actualEngineId,
    sourceDigestEncoding: 'SHA-256 of raw file bytes', sources,
    command: [process.execPath, ...process.argv.slice(1)],
    system: spawnSync('/usr/bin/sw_vers', [], { encoding: 'utf8' }).stdout.trim(),
    compiler: spawnSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    dockerCalls: 0, productionNamespaceTouched: false, rows };
  await writeFile(join(attempt, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ attempt, passed: rows.filter((entry) => entry.result === 'pass').length,
    failed: rows.filter((entry) => entry.result === 'fail').length, report: join(attempt, 'report.json') }, null, 2)}\n`);
}
