import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { SandboxOperationError } from '@agen-ai/sandbox';
import type { SandboxProcessExit } from '@agen-ai/sandbox';
import { CONCURRENT_FIXTURE } from '../fixture.js';
import { CONCURRENT_GUEST_PROGRAM } from '../program.js';
import { CONCURRENT_NETWORK_PROGRAM } from '../network-program.js';
import { ConcurrentProgramSession, observeWithin, record } from '../session.js';
import type { ConcurrentMemberLabel } from '../types.js';

async function originalPrimary(root: string, label: ConcurrentMemberLabel) {
  const directory = join(root, label);
  for (const name of ['inputs', 'project', 'native-state', '.concurrency']) await mkdir(join(directory, name), { recursive: true });
  for (const [name, bytes] of Object.entries({
    'inputs/source.txt': CONCURRENT_FIXTURE.source, 'inputs/AGENTS.md': CONCURRENT_FIXTURE.instructions,
    'project/source.txt': CONCURRENT_FIXTURE.source, 'project/same-path.txt': CONCURRENT_FIXTURE.initialProject,
    'native-state/state.txt': CONCURRENT_FIXTURE.initialNativeState, '.concurrency/primary.mjs': CONCURRENT_GUEST_PROGRAM,
    '.concurrency/network.mjs': CONCURRENT_NETWORK_PROGRAM,
  })) await writeFile(join(directory, name), bytes);
  const child = spawn(process.execPath, [join(directory, '.concurrency/primary.mjs'), label, randomUUID(), '5000'],
    { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise<SandboxProcessExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { if (signal) resolve({ kind: 'signaled', signal }); else { assert.equal(typeof code, 'number'); resolve({ kind: 'exited', code: Number(code) }); } });
  });
  const outputs: Uint8Array[] = [];
  const session = new ConcurrentProgramSession({ stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exit },
    label, String(child.spawnargs[3]), 5000, async ({ stream, bytes }) => { if (stream === 'stdout') outputs.push(bytes); });
  let stopped = false;
  return { directory, session, outputs, async observeExit() {
    const settled = await observeWithin(session.settle(), 5000, 'failed original primary exit without stdin closure');
    stopped = true; return settled;
  }, async stop() {
    if (stopped) return;
    stopped = true; session.beginStop(); child.stdin.end();
    return session.settle();
  } };
}

test('original continuous primaries preserve independent Git, immutable inputs and native state through peer mutation and exit', { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenai-concurrent-primary-'));
  const primaries: Awaited<ReturnType<typeof originalPrimary>>[] = [];
  try {
    const a = await originalPrimary(root, 'a'); primaries.push(a);
    const b = await originalPrimary(root, 'b'); primaries.push(b);
    await Promise.all([a.session.ready(), b.session.ready()]);
    const beforeA = await a.session.request({ kind: 'inspect' }); const beforeB = await b.session.request({ kind: 'inspect' });
    assert.notEqual(a.session.identity.pid, b.session.identity.pid);
    assert.notEqual(a.session.readerId, b.session.readerId);
    assert.equal(beforeA.sourceSha256, createHash('sha256').update('export const answer = 42;\n').digest('hex'));
    assert.equal(beforeB.instructionsSha256, createHash('sha256').update('Work only in project/. Keep immutable inputs and peer state unchanged.\n').digest('hex'));
    assert.equal(record(beforeA.git).head, record(beforeB.git).head);
    assert.notEqual(record(beforeA.git).configSha256, record(beforeB.git).configSha256);
    const mutatedA = await a.session.request({ kind: 'mutate' });
    assert.equal(mutatedA.project, 'project mutation by a\n'); assert.equal(mutatedA.nativeState, 'native state mutation by a\n');
    assert.notEqual(record(mutatedA.git).head, record(beforeA.git).head);
    const duringB = await b.session.request({ kind: 'inspect' });
    assert.equal(duringB.project, 'initial project state\n'); assert.equal(duringB.nativeState, 'initial native state\n');
    assert.deepEqual(duringB.git, beforeB.git);
    assert.equal(await readFile(join(a.directory, 'inputs/source.txt'), 'utf8'), 'export const answer = 42;\n');
    assert.equal(await readFile(join(b.directory, 'project/source.txt'), 'utf8'), 'export const answer = 42;\n');
    const beforeSnapshot = b.session.counter;
    await b.session.progress(beforeSnapshot);
    const observed = await b.session.request({ kind: 'inspect', snapshot: true });
    assert(observed.counterSnapshot !== undefined, 'Inspect must publish a stable auxiliary counter snapshot.');
    const snapshot = record(observed.counterSnapshot); const path = snapshot.path;
    assert(typeof path === 'string' && /^native-state\/observations\/[1-9][0-9]*\.json$/u.test(path));
    const saved = await readFile(join(b.directory, path)); const original = await lstat(join(b.directory, path), { bigint: true });
    assert(original.isFile() && original.nlink === 1n);
    assert.equal(snapshot.bytes, saved.length); assert.equal(snapshot.sha256, createHash('sha256').update(saved).digest('hex'));
    const counter = record(JSON.parse(saved.toString('utf8'))); const counterValue = counter.counter;
    assert(typeof counterValue === 'number' && counterValue >= beforeSnapshot + 3);
    assert.equal(counter.label, 'b'); assert.equal(counter.session, b.session.identity.session); assert.equal(counter.pid, b.session.identity.pid);
    await b.session.progress(Math.max(b.session.counter, counterValue));
    const fresh = record(await b.session.request({ kind: 'inspect', snapshot: true }));
    const nextSnapshot = record(fresh.counterSnapshot); assert.notEqual(nextSnapshot.path, path);
    assert.deepEqual(await readFile(join(b.directory, path)), saved, 'Original snapshot bytes must survive subsequent producer progress and another snapshot.');
    const retained = await lstat(join(b.directory, path), { bigint: true });
    assert.equal(retained.ino, original.ino); assert.equal(retained.mtimeNs, original.mtimeNs); assert.equal(retained.nlink, 1n);
    const moving = record(JSON.parse(await readFile(join(b.directory, 'project/counter.json'), 'utf8')));
    assert(typeof moving.counter === 'number' && moving.counter >= counterValue + 3);
    assert.deepEqual((await readdir(join(b.directory, 'project'))).sort(), ['.git', 'counter.json', 'same-path.txt', 'source.txt']);
    const previous = b.session.counter;
    assert.deepEqual(await a.stop(), { exit: { kind: 'exited', code: 0 }, failure: undefined });
    await b.session.progress(previous);
    const afterB = await b.session.request({ kind: 'mutate' });
    assert.equal(afterB.project, 'project mutation by b\n'); assert.equal(afterB.nativeState, 'native state mutation by b\n');
    assert.notEqual(record(afterB.git).head, record(mutatedA.git).head);
    assert.deepEqual(afterB.identity, beforeB.identity);
    const lines = Buffer.concat(b.outputs).toString('utf8').trim().split('\n').map((line) => record(JSON.parse(line)));
    const ticks = lines.filter(({ kind }) => kind === 'tick');
    assert(ticks.length >= 3); assert(ticks.every((frame, index) => frame.counter === index + 1 && frame.pid === b.session.identity.pid));
    assert.deepEqual(await b.stop(), { exit: { kind: 'exited', code: 0 }, failure: undefined });
  } finally {
    const cleanup = await Promise.allSettled(primaries.map((primary) => primary.stop()));
    for (const primary of primaries) await chmod(join(primary.directory, 'inputs'), 0o755);
    await rm(root, { recursive: true, force: true });
    const failures = cleanup.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Original local primary cleanup failed.');
  }
});

test('a fatal background file producer settles the original process and readers without a controller stdin close', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenai-concurrent-producer-failure-'));
  const primary = await originalPrimary(root, 'a');
  try {
    await primary.session.ready(); await primary.session.progress();
    await rename(join(primary.directory, 'native-state'), join(primary.directory, 'native-state-removed'));
    const settled = await primary.observeExit();
    assert.deepEqual(settled.exit, { kind: 'exited', code: 1 });
    assert(settled.failure instanceof AggregateError);
    assert(settled.failure.errors.some((error: unknown) => error instanceof Error
      && error.message.includes('Original primary stderr:') && error.message.includes('ENOENT') && error.message.includes('native-state/counter.next')),
    'Original producer failure bytes were lost.');
  } finally {
    await primary.stop(); await chmod(join(primary.directory, 'inputs'), 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

test('an expected stop accepts only the SDK typed cancellation from its original readers', async () => {
  const stopped = async (reason: Error) => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const exit = Promise.withResolvers<SandboxProcessExit>();
    const session = new ConcurrentProgramSession({ stdin: new PassThrough(), stdout, stderr, exit: exit.promise }, 'a', randomUUID(), 1000, undefined);
    session.beginStop();
    stdout.destroy(reason); stderr.destroy(reason);
    exit.resolve({ kind: 'unavailable', reason: 'sandbox_stopped' });
    return session.settle();
  };
  assert.equal((await stopped(new SandboxOperationError('cancelled', 'Sandbox compute is stopping.'))).failure, undefined);
  const raw = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
  assert.deepEqual((await stopped(raw)).failure?.errors, [raw]);
});
