import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { setImmediate as turn } from 'node:timers/promises';

const root = process.cwd();
let swapping;
const inside = (name) => {
  assert(typeof name === 'string' && name.length <= 8192);
  const actual = resolve(root, name);
  assert(actual.startsWith(`${root}${sep}`), 'Fixture operation must stay below its mounted workspace');
  return actual;
};
async function digest(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}
async function write(command) {
  const path = inside(command.path); await fs.mkdir(dirname(path), { recursive: true });
  if (command.base64 !== undefined) {
    const bytes = Buffer.from(command.base64, 'base64'); assert(bytes.length <= 8192);
    await fs.writeFile(path, bytes, { mode: command.permissions ?? 0o644 });
  } else {
    assert(Number.isSafeInteger(command.length) && command.length >= 0 && command.length <= 16 * 1024 * 1024);
    const handle = await fs.open(path, 'w', command.permissions ?? 0o644);
    try {
      const block = Buffer.alloc(65536, command.fill ?? 65);
      for (let offset = 0; offset < command.length; offset += block.length) await handle.write(block.subarray(0, Math.min(block.length, command.length - offset)));
    } finally { await handle.close(); }
  }
  if (command.permissions !== undefined) await fs.chmod(path, command.permissions);
  return digest(path);
}
async function mountBind(timeoutMs) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 5000);
  const args = ['--bind', inside('mount-source'), inside('mount-target')];
  const child = spawn('/usr/bin/mount', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  const stdout = { bytes: 0, retained: Buffer.alloc(0), hash: createHash('sha256') };
  const stderr = { bytes: 0, retained: Buffer.alloc(0), hash: createHash('sha256') };
  let timedOut = false; let outputLimit = false; let spawnError;
  const capture = (target, chunk, maximum) => {
    target.bytes += chunk.length; target.hash.update(chunk);
    if (target.retained.length < maximum) target.retained = Buffer.concat([target.retained, chunk.subarray(0, maximum - target.retained.length)]);
    if (!outputLimit && stdout.bytes + stderr.bytes > 8192) { outputLimit = true; child.kill('SIGKILL'); }
  };
  child.stdout.on('data', (chunk) => capture(stdout, chunk, 1024));
  child.stderr.on('data', (chunk) => capture(stderr, chunk, 2048));
  child.once('error', (error) => { spawnError = { code: error.code, message: error.message.slice(0, 512) }; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const exit = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  const observed = (value) => ({ bytes: value.bytes, sha256: value.hash.digest('hex'),
    text: value.retained.toString('utf8'), truncated: value.bytes > value.retained.length });
  return { executable: '/usr/bin/mount', args, ...exit, spawnError, timedOut, outputLimit,
    stdout: observed(stdout), stderr: observed(stderr), childJoined: true };
}
async function command(input) {
  if (input.kind === 'facts') return { pid: process.pid, uid: process.getuid(), gid: process.getgid(), cwd: root,
    platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node };
  if (input.kind === 'layout') {
    let privateStage; let rootRename;
    try { await fs.readdir('/store/stage'); privateStage = 'accessible'; } catch (error) { privateStage = error.code; }
    try { await fs.rename(root, `${root}-renamed`); rootRename = 'renamed'; } catch (error) { rootRename = error.code; }
    return { privateStage, rootRename, entries: await fs.readdir(root) };
  }
  if (input.kind === 'write') return write(input);
  if (input.kind === 'digest') return digest(inside(input.path));
  if (input.kind === 'stat') {
    const info = await fs.lstat(inside(input.path));
    return { bytes: info.size, permissions: info.mode & 0o777, links: info.nlink, kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'special' };
  }
  if (input.kind === 'mkdir') { await fs.mkdir(inside(input.path), { recursive: true }); return {}; }
  if (input.kind === 'mount-bind') return mountBind(input.timeoutMs);
  if (input.kind === 'relative-child') {
    const parent = inside(input.parent); assert.equal(input.name, 'child.bin');
    await fs.mkdir(parent, { recursive: true });
    const previous = process.cwd(); process.chdir(parent);
    try { await fs.writeFile(input.name, Uint8Array.of(9)); return { created: input.name, ...await digest(input.name) }; }
    finally { process.chdir(previous); }
  }
  if (input.kind === 'truncate') { await fs.truncate(inside(input.path), input.length); return {}; }
  if (input.kind === 'rename') { await fs.rename(inside(input.from), inside(input.to)); return {}; }
  if (input.kind === 'unlink') { await fs.unlink(inside(input.path)); return {}; }
  if (input.kind === 'chmod') { await fs.chmod(inside(input.path), input.permissions); return {}; }
  if (input.kind === 'symlink') { await fs.symlink(input.target, inside(input.path)); return {}; }
  if (input.kind === 'hardlink') { await fs.link(inside(input.from), inside(input.path)); return {}; }
  if (input.kind === 'fifo') {
    const path = inside(input.path);
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/mkfifo', [path], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
      child.once('error', reject); child.once('close', (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error(`mkfifo ${code}/${signal}`)));
    });
    return {};
  }
  if (input.kind === 'listing') {
    assert(Number.isSafeInteger(input.entries) && input.entries <= 4096);
    const path = inside(input.path); await fs.mkdir(path, { recursive: true });
    for (let index = input.entries - 1; index >= 0; index--) await fs.writeFile(join(path, `entry-${String(index).padStart(6, '0')}`), Uint8Array.of(index % 251));
    return { entries: input.entries };
  }
  if (input.kind === 'swap-start') {
    assert(!swapping, 'One owned swap loop at a time');
    const path = inside(input.path); const held = inside(`${input.path}-held`);
    const state = { active: true, iterations: 0, links: 0, renames: 0, failures: [] };
    state.done = (async () => {
      while (state.active) {
        await fs.rename(path, held); state.renames++;
        try {
          await fs.symlink(input.target, path); state.links++; await turn(); await fs.unlink(path);
        } finally { await fs.rename(held, path); }
        state.iterations++; await turn();
      }
    })().catch((error) => { state.failures.push({ code: error.code, message: error.message }); });
    swapping = state;
    while (state.iterations < 64 && !state.failures.length) await turn();
    return { iterations: state.iterations, links: state.links, renames: state.renames, failures: state.failures };
  }
  if (input.kind === 'swap-stop') {
    assert(swapping); const state = swapping; state.active = false; await state.done; swapping = undefined;
    return { iterations: state.iterations, links: state.links, renames: state.renames, failures: state.failures };
  }
  if (input.kind === 'swap-state') {
    assert(swapping); return { iterations: swapping.iterations, links: swapping.links, renames: swapping.renames, failures: swapping.failures };
  }
  throw new Error(`Unknown owned fixture command ${input.kind}`);
}

process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  assert(Buffer.byteLength(line) <= 16384);
  const input = JSON.parse(line);
  try { process.stdout.write(`${JSON.stringify({ id: input.id, ok: true, ...await command(input) })}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ id: input.id, ok: false, error: { code: error.code, message: error.message } })}\n`); }
}
