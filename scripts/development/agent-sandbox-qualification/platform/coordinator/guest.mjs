import assert from 'node:assert/strict';
import { readFile, readlink, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { networkProbe } from './guest-network.mjs';

const [label, session, rawTimeout] = process.argv.slice(2);
assert(label === 'a' || label === 'b' || label === 'c');
assert(/^[a-f0-9-]{36}$/u.test(session));
const timeoutMs = Number(rawTimeout);
assert(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30_000);
const identity = Object.freeze({ label, session, pid: process.pid, platform: process.platform, architecture: process.arch,
  node: process.versions.node, uid: process.getuid(), gid: process.getgid(), cwd: process.cwd(),
  networkNamespace: await readlink('/proc/self/ns/net') });
await writeFile('identity.json', `${JSON.stringify(identity)}\n`, { flag: 'wx', mode: 0o644 });
let writing = Promise.resolve();
const emit = (value) => {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`); assert(bytes.length <= 16 * 1024);
  writing = writing.then(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Guest stdout acknowledgement deadline.')), timeoutMs);
    process.stdout.write(bytes, (error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
  }));
  return writing;
};
let stopping = false;
let counter = 0;
const cancellation = new AbortController();
await emit({ kind: 'ready', identity });
const producer = (async () => {
  while (!stopping) {
    assert(++counter <= 1600, 'Fixed guest counter budget exhausted.');
    const value = { ...identity, counter };
    await writeFile('counter.next', `${JSON.stringify(value)}\n`, { mode: 0o644 });
    await rename('counter.next', 'counter.json');
    await emit({ kind: 'tick', ...value });
    try { await delay(250, undefined, { signal: cancellation.signal }); }
    catch (error) { if (!stopping) throw error; }
  }
})();
void producer.catch((error) => { process.stderr.write(`${error.message.slice(0, 2048)}\n`); process.exitCode = 1; stopping = true; cancellation.abort(); });
let pending = Buffer.alloc(0);
let commands = 0;
try {
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]); assert(pending.length <= 16 * 1024);
    while (pending.includes(10)) {
      assert(++commands <= 48);
      const end = pending.indexOf(10);
      const command = JSON.parse(pending.subarray(0, end).toString('utf8')); pending = pending.subarray(end + 1);
      assert(Number.isSafeInteger(command.id) && command.id > 0);
      try {
        let result;
        if (command.kind === 'identity') result = { ...identity, counter, hostFile: await readFile('host-owned.json', 'utf8') };
        else if (command.kind === 'tls' || command.kind === 'connect') result = await networkProbe(command.kind, command.hostname, timeoutMs);
        else throw new Error('Unknown fixed coordinator guest operation.');
        await emit({ kind: 'reply', id: command.id, ok: true, result });
      } catch (error) { await emit({ kind: 'reply', id: command.id, ok: false,
        error: { name: error.name, code: error.code ?? null, message: error.message.slice(0, 2048) } }); }
    }
  }
  assert.equal(pending.length, 0);
} finally { stopping = true; cancellation.abort(); await producer; await writing; }
