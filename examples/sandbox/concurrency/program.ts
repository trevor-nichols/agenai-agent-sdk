import { CONCURRENT_PROTOCOL } from './protocol.js';

/** One original continuous Node primary owns Git, file production and the held TLS connection. */
export const CONCURRENT_GUEST_PROGRAM = String.raw`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { closeNetwork, denied, forbidden, fresh, openHeld } from './network.mjs';

const [label, session, rawTimeout] = process.argv.slice(2);
assert(['a', 'b', 'c'].includes(label)); assert(/^[a-f0-9-]{36}$/u.test(session));
const timeoutMs = Number(rawTimeout);
assert(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30_000);
const root = process.cwd();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = await readFile('inputs/source.txt');
const instructions = await readFile('inputs/AGENTS.md');
const initialProject = await readFile('project/same-path.txt', 'utf8');
const initialNativeState = await readFile('native-state/state.txt', 'utf8');
assert.equal(await readFile('project/source.txt', 'utf8'), source.toString('utf8'));
await chmod('inputs/source.txt', 0o444); await chmod('inputs/AGENTS.md', 0o444); await chmod('inputs', 0o555);
await mkdir('native-state/empty-git-template');
await mkdir('native-state/observations', { mode: 0o700 });
const gitEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(root, 'native-state'),
  LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
async function git(...args) {
  const result = await promisify(execFile)('git', args, { cwd: join(root, 'project'), env: gitEnv, timeout: timeoutMs, maxBuffer: 32 * 1024 });
  assert.equal(result.stderr, '', 'Git emitted unexpected diagnostics.');
  return result.stdout.trim();
}
await git('init', '--quiet', '--initial-branch=main', '--template=' + join(root, 'native-state/empty-git-template'));
await mkdir('project/.git/hooks');
await git('config', '--local', 'user.name', 'AgenAI concurrency fixture');
await git('config', '--local', 'user.email', 'fixture@example.invalid');
await git('config', '--local', 'core.hooksPath', '.git/hooks');
await git('config', '--local', 'agenai.member', label);
await git('add', '--', 'source.txt', 'same-path.txt');
await git('commit', '--quiet', '--message=immutable seed');
await git('checkout', '--quiet', '--detach', 'HEAD');
const identity = Object.freeze({ label, session, pid: process.pid, platform: process.platform, architecture: process.arch,
  node: process.versions.node, cwd: root, networkNamespace: process.platform === 'linux' ? await readlink('/proc/self/ns/net') : null });
let writing = Promise.resolve();
const emit = (value) => {
  const bytes = Buffer.from(JSON.stringify(value) + '\n'); assert(bytes.length <= ${CONCURRENT_PROTOCOL.frameBytes});
  writing = writing.then(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Explicit original stdout acknowledgement deadline.')), timeoutMs);
    process.stdout.write(bytes, (error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
  }));
  return writing;
};
let stopping = false; let counter = 0; let held; let heldLast; let heldTask; let fatal;
const cancellation = new AbortController();
async function pause(ms) {
  try { await delay(ms, undefined, { signal: cancellation.signal }); }
  catch (error) { if (!stopping) throw error; }
}
function failed(error) {
  if (!stopping) {
    fatal = error; process.stderr.write(String(error.stack ?? error).slice(0, 4096) + '\n');
    process.exitCode = 1; stopping = true; cancellation.abort(); process.stdin.destroy();
  }
}
const producer = (async () => {
  while (!stopping) {
    assert(++counter <= 4800, 'Explicit fixed-workload tick budget exhausted.');
    const value = { label, session, pid: process.pid, counter };
    await writeFile('native-state/counter.next', JSON.stringify(value) + '\n', { mode: 0o644 });
    await rename('native-state/counter.next', 'project/counter.json');
    await emit({ kind: 'tick', ...value });
    await pause(250);
  }
})();
void producer.catch(failed);
await emit({ kind: 'ready', identity });
async function inspect(observationId) {
  assert.deepEqual(await readFile('inputs/source.txt'), source);
  assert.deepEqual(await readFile('inputs/AGENTS.md'), instructions);
  assert.equal((await lstat('inputs/source.txt')).mode & 0o777, 0o444);
  assert.equal((await lstat('inputs/AGENTS.md')).mode & 0o777, 0o444);
  assert.deepEqual(await readFile('project/source.txt'), source);
  assert.equal(await git('remote'), '');
  assert.equal(await git('symbolic-ref', '--quiet', 'HEAD').then(() => false, (error) => { assert.equal(error.code, 1); return true; }), true);
  assert.deepEqual(await readdir('project/.git/hooks'), []);
  assert.equal(await readFile('project/.git/objects/info/alternates').then(() => true, (error) => { assert.equal(error.code, 'ENOENT'); return false; }), false);
  for (const path of ['project/.git', 'project/.git/objects', 'project/.git/refs', 'project/.git/index', 'project/.git/config']) {
    assert(!(await lstat(path)).isSymbolicLink(), 'Git state cannot share a symlinked path.');
  }
  const head = await git('rev-parse', 'HEAD'); assert(/^[a-f0-9]{40,64}$/u.test(head));
  let counterSnapshot;
  if (observationId !== undefined) {
    const bytes = await readFile('project/counter.json'); assert(bytes.length > 0 && bytes.length <= 4096);
    const path = 'native-state/observations/' + observationId + '.json';
    await writeFile(path, bytes, { flag: 'wx', mode: 0o644 });
    counterSnapshot = { path, bytes: bytes.length, sha256: digest(bytes) };
  }
  return { identity, counter, sourceSha256: digest(source), instructionsSha256: digest(instructions),
    project: await readFile('project/same-path.txt', 'utf8'), nativeState: await readFile('native-state/state.txt', 'utf8'),
    ...(counterSnapshot ? { counterSnapshot } : {}),
    git: { head, detached: true, configSha256: digest(await readFile('project/.git/config')), indexSha256: digest(await readFile('project/.git/index')) } };
}
let pending = Buffer.alloc(0); let commands = 0;
try {
  commandLoop: for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]); assert(pending.length <= ${CONCURRENT_PROTOCOL.commandBytes});
    while (pending.includes(10)) {
      if (stopping) break commandLoop;
      assert(++commands <= ${CONCURRENT_PROTOCOL.commands}, 'Explicit original command budget exhausted.');
      const end = pending.indexOf(10);
      const command = JSON.parse(pending.subarray(0, end).toString('utf8')); pending = pending.subarray(end + 1);
      assert.equal(command.id, commands, 'Original command identity must advance once within its bound.');
      let result;
      if (command.kind === 'inspect') result = await inspect(command.snapshot === true ? command.id : undefined);
      else if (command.kind === 'mutate') {
        assert.equal(await readFile('project/same-path.txt', 'utf8'), initialProject);
        assert.equal(await readFile('native-state/state.txt', 'utf8'), initialNativeState);
        await writeFile('project/same-path.txt', 'project mutation by ' + label + '\n', { mode: 0o644 });
        await writeFile('native-state/state.txt', 'native state mutation by ' + label + '\n', { mode: 0o644 });
        await git('add', '--', 'same-path.txt'); await git('commit', '--quiet', '--message=member-' + label);
        result = await inspect();
      } else if (command.kind === 'hold') {
        assert(!held, 'One original held connection per primary.');
        held = await openHeld(command.positive, timeoutMs);
        heldLast = await held.probe(); await emit({ kind: 'held', ...heldLast });
        heldTask = (async () => {
          while (!stopping) {
            await pause(1000);
            if (!stopping) { heldLast = await held.probe(); await emit({ kind: 'held', ...heldLast }); }
          }
        })();
        void heldTask.catch(failed);
        result = heldLast;
      } else if (command.kind === 'network') {
        assert(Array.isArray(command.forbidden) && command.forbidden.length <= 12);
        const [positive, negative, controls] = await Promise.all([fresh(command.positive, timeoutMs), denied(command.denied, timeoutMs),
          Promise.all(command.forbidden.map((input) => forbidden(input, timeoutMs)))]);
        result = { fresh: positive, denied: negative, forbidden: controls };
      }
      else throw new Error('Unknown fixed concurrency guest command.');
      await emit({ kind: 'reply', id: command.id, result });
    }
  }
  if (!fatal) assert.equal(pending.length, 0, 'Original stdin ended inside a command.');
} catch (error) {
  if (!fatal) throw error;
} finally {
  stopping = true; cancellation.abort(); await closeNetwork();
  await Promise.allSettled([producer, ...(heldTask ? [heldTask] : [])]); await writing;
}
if (fatal) throw fatal;
`;
