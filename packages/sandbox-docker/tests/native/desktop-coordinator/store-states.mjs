// Explicit native diagnostic; never selected by the hermetic workspace lane.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { constants, userInfo } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { EACCES, ENOENT, ENOTDIR, ESTALE } = constants.errno;
const { values } = parseArgs({ options: { output: { type: 'string' }, helper: { type: 'string' } } });
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.ok(values.output, 'Usage: store-states.mjs --output <new absolute directory> [--helper <prepared coordinator helper>]');
const output = resolve(values.output);
const here = dirname(fileURLToPath(import.meta.url));
const native = resolve(here, '../../../native/desktop/coordinator');
const key = randomBytes(32).toString('hex');
const payload = JSON.stringify({ fixture: 'store-states', key });
const storePath = ['Library', 'Application Support', 'AgenAI', 'sandbox-docker', 'desktop-coordination-v1'];
const realStore = join(userInfo().homedir, ...storePath);
const [lock, state, temporary] = ['lock', 'state', 'next'].map((suffix) => join(realStore, `${key}.${suffix}`));
const live = new Set();
const results = [];

async function realStoreEntriesForKey() {
  return (await readdir(realStore)).filter((name) => name.startsWith(`${key}.`));
}

// Only paths derived from this run's random key, checked absent before the run, are removed from the real store.
async function removeRealKeyFiles() {
  for (const path of [lock, state, temporary]) await rm(path, { force: true });
}

// The helper accepts only a symlink-free home whose components are not group- or world-writable.
async function requireSecureAncestors(path) {
  assert.equal(await realpath(path), path, 'The output directory must be a physical path.');
  for (let current = path; ; current = dirname(current)) {
    const { uid, mode } = await lstat(current);
    assert.ok((uid === 0 || uid === process.getuid()) && (mode & 0o022) === 0, `${current} is shared with other accounts.`);
    if (current === parse(current).root) return;
  }
}

function clang(args) { execFileSync('/usr/bin/clang', args, { stdio: 'pipe', timeout: 60_000 }); }

function start(observed, executable, mode, home) {
  const env = home === undefined ? process.env : { ...process.env, AGENAI_TEST_HOME: home };
  const child = spawn(executable, [mode, key], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiting = [];
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const reply = JSON.parse(line);
    observed.push({ mode, reply });
    if (waiting.length) waiting.shift()(reply); else lines.push(reply);
  });
  const helper = { child, exited: once(child, 'exit').then(([code, signal]) => {
    live.delete(helper);
    observed.push({ mode, exit: { code, signal, stderr } });
    return { code, signal, stderr };
  }) };
  helper.next = async () => {
    let timer;
    try {
      return await Promise.race([lines.length ? lines.shift() : new Promise((accept) => waiting.push(accept)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native response deadline')), 15_000); })]);
    } finally { clearTimeout(timer); }
  };
  helper.send = (command, body) => {
    child.stdin.write(body === undefined ? `${command}\n` : `${command}\n${body}\n`);
    return helper.next();
  };
  live.add(helper);
  return helper;
}

async function expectLost(helper, reason, errno) {
  assert.deepEqual(await helper.next(), { kind: 'failure', reason, errno, claim: 'lost' });
  assert.deepEqual(await helper.exited, { code: 1, signal: null, stderr: '' });
}

async function expectOpened(helper, initial) {
  const reply = await helper.next();
  assert.equal(reply.kind, 'opened');
  assert.equal(reply.initial, initial);
  return helper;
}

async function close(helper) {
  assert.deepEqual(await helper.send('CLOSE'), { kind: 'closed' });
  helper.child.stdin.end();
  assert.deepEqual(await helper.exited, { code: 0, signal: null, stderr: '' });
}

async function initializeAndReopenBothModes(open, executable, home) {
  const created = await expectOpened(open(executable, 'initialize', home), 'required');
  assert.equal((await created.send(`COMMIT ${Buffer.byteLength(payload)}`, payload)).kind, 'committed');
  await close(created);
  const reopened = await expectOpened(open(executable, 'open', home), 'existing');
  assert.equal((await reopened.send('READ')).text, payload);
  assert.deepEqual(await reopened.send('CHECK'), { kind: 'checked', fenced: false });
  await close(reopened);
  const cleaning = await expectOpened(open(executable, 'cleanup', home), 'existing');
  assert.deepEqual(await cleaning.send('CLEANUP'), { kind: 'cleanup' });
  assert.equal((await cleaning.send('READ')).text, payload);
  await close(cleaning);
}

/** Creates the first `depth` store path components: shared but accepted ancestors at 0755, private store directories at 0700. */
async function storeChain(home, depth) {
  let current = home;
  for (const [index, name] of storePath.slice(0, depth).entries()) {
    current = join(current, name);
    await mkdir(current);
    await chmod(current, index >= 2 ? 0o700 : 0o755);
  }
  return current;
}

/** Runs one case to completion and leaves no helper or real-store file behind, so a failure cannot leak into the next case. */
async function scenario(group, name, staged, run) {
  const observed = [];
  const helpers = [];
  const entry = { group, name, staged, observed, status: 'running' };
  results.push(entry);
  try {
    await run((executable, mode, home) => {
      const helper = start(observed, executable, mode, home);
      helpers.push(helper);
      return helper;
    });
    entry.status = 'pass';
  } catch (error) {
    entry.status = 'fail';
    entry.failure = error instanceof Error ? error.message : String(error);
  } finally {
    for (const helper of helpers) if (live.has(helper)) { helper.child.kill('SIGKILL'); await helper.exited; }
    if (group === 'real') await removeRealKeyFiles();
  }
}

await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });
await requireSecureAncestors(output);
const flags = ['-std=c11', '-Wall', '-Wextra', '-Wformat=2', '-Werror', '-O2', '-fno-ident'];
const production = values.helper === undefined ? join(output, 'agenai-desktop-coordinator') : resolve(values.helper);
if (values.helper === undefined) {
  clang([...flags, '-Wl,-reproducible', ...['main.c', 'authority.c', 'storage.c'].map((name) => join(native, name)), '-o', production]);
}
const scratchAuthority = join(output, 'authority-scratch-home.o');
clang([...flags, '-Dgetpwuid_r=diagnostic_getpwuid_r', '-c', join(native, 'authority.c'), '-o', scratchAuthority]);
const scratch = join(output, 'agenai-desktop-coordinator-scratch-home');
clang([...flags, join(native, 'main.c'), join(native, 'storage.c'), scratchAuthority, join(here, 'diagnostic-home.c'), '-o', scratch]);

assert.ok((await lstat(realStore)).isDirectory(), 'Real-home cases need this account\'s existing coordinator store directory.');
// A key that already names a file in the live store may belong to a real Engine, so the run refuses it.
assert.deepEqual(await realStoreEntriesForKey(), [], 'The random Engine key already names a file in the live store.');
const homes = join(output, 'homes');
await mkdir(homes, { mode: 0o700 });
try {
  await scenario('real', 'open-without-files', 'store directory holds no file for the key', async (open) => {
    await expectLost(open(production, 'open'), 'authority_absent', ENOENT);
  });
  await scenario('real', 'cleanup-without-files', 'store directory holds no file for the key', async (open) => {
    await expectLost(open(production, 'cleanup'), 'authority_absent', ENOENT);
  });
  await scenario('real', 'lock-without-state', 'only <key>.lock exists', async (open) => {
    await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
    await expectLost(open(production, 'open'), 'authority_partial', ENOENT);
  });
  await scenario('real', 'temporary-without-authority', 'only <key>.next exists', async (open) => {
    await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
    await expectLost(open(production, 'open'), 'authority_partial', ENOENT);
  });
  await scenario('real', 'initialize-commit-reopen', 'store directory holds no file for the key', async (open) => {
    await initializeAndReopenBothModes(open, production);
  });

  const absent = [['empty-home', 0], ['application-support-only', 2], ['sandbox-docker-only', 4], ['empty-store', 5]];
  for (const [name, depth] of absent) {
    await scenario('scratch', name, `home holds the first ${depth} store path components`, async (open) => {
      const home = join(homes, name);
      await mkdir(home, { mode: 0o700 });
      await storeChain(home, depth);
      await expectLost(open(scratch, 'open', home), 'authority_absent', ENOENT);
    });
  }
  await scenario('scratch', 'cleanup-empty-home', 'home holds no store path component', async (open) => {
    const home = join(homes, 'cleanup-empty-home');
    await mkdir(home, { mode: 0o700 });
    await expectLost(open(scratch, 'cleanup', home), 'authority_absent', ENOENT);
  });
  await scenario('scratch', 'missing-home', 'the account home does not exist', async (open) => {
    await expectLost(open(scratch, 'open', join(homes, 'missing-home')), 'directory_open', ENOENT);
  });
  await scenario('scratch', 'store-is-file', 'desktop-coordination-v1 is a regular file', async (open) => {
    const home = join(homes, 'store-is-file');
    await mkdir(home, { mode: 0o700 });
    await writeFile(join(await storeChain(home, 4), storePath[4]), '', { flag: 'wx', mode: 0o600 });
    await expectLost(open(scratch, 'open', home), 'directory_open', ENOTDIR);
  });
  await scenario('scratch', 'store-is-symlink', 'desktop-coordination-v1 is a symlink to a private directory', async (open) => {
    const home = join(homes, 'store-is-symlink');
    await mkdir(join(home, 'elsewhere'), { recursive: true, mode: 0o700 });
    await symlink(join(home, 'elsewhere'), join(await storeChain(home, 4), storePath[4]));
    // With O_DIRECTORY | O_NOFOLLOW, Darwin reports a symlink as ENOTDIR, not ELOOP.
    await expectLost(open(scratch, 'open', home), 'directory_open', ENOTDIR);
  });
  await scenario('scratch', 'store-unreadable', 'desktop-coordination-v1 has mode 0000', async (open) => {
    const home = join(homes, 'store-unreadable');
    await mkdir(home, { mode: 0o700 });
    const store = await storeChain(home, 5);
    await chmod(store, 0o000);
    try { await expectLost(open(scratch, 'open', home), 'directory_open', EACCES); }
    finally { await chmod(store, 0o700); }
  });
  await scenario('scratch', 'store-shared', 'desktop-coordination-v1 has mode 0755', async (open) => {
    const home = join(homes, 'store-shared');
    await mkdir(home, { mode: 0o700 });
    await chmod(await storeChain(home, 5), 0o755);
    await expectLost(open(scratch, 'open', home), 'directory_identity', ESTALE);
  });
  await scenario('scratch', 'initialize-commit-reopen', 'home holds no store path component', async (open) => {
    const home = join(homes, 'initialize-commit-reopen');
    await mkdir(home, { mode: 0o700 });
    await initializeAndReopenBothModes(open, scratch, home);
  });
  await scenario('scratch', 'check-after-store-removed', 'desktop-coordination-v1 removed while a helper holds it', async (open) => {
    const home = join(homes, 'check-after-store-removed');
    await mkdir(home, { mode: 0o700 });
    await initializeAndReopenBothModes(open, scratch, home);
    const held = await expectOpened(open(scratch, 'open', home), 'existing');
    await rm(join(home, ...storePath), { recursive: true });
    assert.deepEqual(await held.send('CHECK'), { kind: 'failure', reason: 'authority_absent', errno: ENOENT, claim: 'lost' });
    assert.deepEqual(await held.exited, { code: 1, signal: null, stderr: '' });
  });
} finally {
  for (const helper of live) { helper.child.kill('SIGKILL'); await helper.exited; }
  await removeRealKeyFiles();
  await rm(homes, { recursive: true, force: true });
  const cleanup = { key, realStoreEntriesForKey: await realStoreEntriesForKey(), scratchHomesRemain: await lstat(homes).then(() => true, () => false) };
  await writeFile(join(output, 'cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  assert.deepEqual(cleanup.realStoreEntriesForKey, [], 'Files for the random Engine key remain in the live store.');
  assert.equal(cleanup.scratchHomesRemain, false, 'Scratch homes remain after the run.');
}

const result = join(output, 'result.json');
await writeFile(result, `${JSON.stringify({ key, production, scratch, results }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const failed = results.filter((entry) => entry.status !== 'pass');
if (failed.length > 0) {
  console.error(`${failed.length} of ${results.length} native store-state cases failed: ${failed.map(({ group, name }) => `${group}/${name}`).join(', ')}`);
  process.exitCode = 1;
} else console.log(`Native store-state cases passed; evidence ${result}`);
