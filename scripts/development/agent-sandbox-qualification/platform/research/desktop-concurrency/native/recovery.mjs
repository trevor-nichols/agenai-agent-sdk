import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { until } from '../../../../engine.mjs';
import { failure, sha } from './installed.mjs';

const [inputPath, output] = process.argv.slice(2);
assert.equal(process.argv.length, 4); assert(isAbsolute(output));
await mkdir(output, { mode: 0o700 });
const input = JSON.parse(await readFile(inputPath, 'utf8'));
assert.equal(process.version, `v${input.platform.expected.controller.nodeVersion}`);
const scratch = await mkdtemp('/private/tmp/sdkc-recovery-');
const executable = join(scratch, 'host-observer');
const original = input.capabilities.network.routeAuthority.hostObserver.executable;
assert.equal(sha(await readFile(original.path)), original.sha256);
await copyFile(original.path, executable);
assert.equal(sha(await readFile(executable)), original.sha256);
const copied = await lstat(executable, { bigint: true }); assert(copied.isFile());
input.capabilities.network.routeAuthority.hostObserver.executable.path = executable;
input.researchNamespace = `research-recovery-${randomUUID()}`;
const effectivePath = join(output, 'input.json');
await writeFile(effectivePath, `${JSON.stringify(input, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const report = { format: 'agenai.desktop-route-independent-recovery-research.v1', status: 'running',
  scope: 'Installed 0.4.7 known-ID single-owner cleanup after original process death and loss of its private host-observer copy. No coordinator, unknown-create settlement or peer survival claim.',
  inputSha256: sha(await readFile(inputPath)), namespace: input.researchNamespace, executable,
  copiedExecutable: { device: String(copied.dev), inode: String(copied.ino), sha256: original.sha256 }, workers: [] };
const save = () => writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
let active;
async function start(mode, recordPath) {
  const directory = join(output, mode), args = [fileURLToPath(new URL('./recovery-worker.mjs', import.meta.url)), effectivePath, mode, directory];
  if (recordPath) args.push(recordPath);
  const child = spawn(process.execPath, args, { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { mode, directory, pid: child.pid, stdout: '', stderr: '', exit: null };
  report.workers.push(entry); active = child;
  let boundError;
  for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', (bytes) => {
    if (Buffer.byteLength(entry[key]) + bytes.length > 64 * 1024) { boundError = new Error('Research child output bound.'); child.kill('SIGKILL'); }
    else entry[key] += bytes.toString();
  });
  const exited = once(child, 'close').then(([code, signal]) => { entry.exit = { code, signal }; return entry.exit; });
  void exited.catch(() => {});
  const next = async (phase) => until(() => {
    if (boundError) throw boundError;
    const lines = entry.stdout.split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
    const matched = lines.find((line) => line.phase === phase);
    if (matched) return matched;
    assert.equal(entry.exit, null, `Child ${mode} exited before ${phase}: ${entry.stderr}`); return false;
  }, 90000, `Child ${mode} did not reach ${phase}.`);
  await save(); return { child, entry, exited, next };
}
try {
  await save(); const held = await start('hold');
  const ready = await held.next('ready'); report.originalPath = ready.originalPath;
  assert.equal(held.child.kill('SIGKILL'), true);
  const killed = await held.exited; assert.equal(killed.signal, 'SIGKILL'); active = undefined;
  const now = await lstat(executable, { bigint: true }); assert.equal(now.dev, copied.dev); assert.equal(now.ino, copied.ino);
  await unlink(executable); report.hostObserverRemoved = true; await save();
  const recovered = await start('recover', ready.originalPath); const completed = await recovered.next('complete');
  assert.equal((await recovered.exited).code, 0, recovered.entry.stderr); assert.equal(completed.status, 'passed'); active = undefined;
  const verified = await start('verify', completed.settledPath); const complete = await verified.next('complete');
  assert.equal((await verified.exited).code, 0, verified.entry.stderr); assert.equal(complete.status, 'passed'); active = undefined;
  report.status = 'passed';
} catch (error) { report.failure = failure(error); }
finally {
  if (active && active.exitCode === null && active.signalCode === null) {
    const close = once(active, 'close'); active.kill('SIGKILL'); await close;
    report.requiresOriginalCheckpointCleanup = true;
  }
  report.finishedAt = new Date().toISOString(); await save();
}
process.stdout.write(`${JSON.stringify({ status: report.status, output })}\n`);
if (report.status !== 'passed') process.exitCode = 1;
