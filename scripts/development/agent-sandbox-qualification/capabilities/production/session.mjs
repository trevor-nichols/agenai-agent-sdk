// ------------------------------------------------------------------------------------------------
//                session.mjs - One continuously owned SDK output reader and bounded guest requests
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

export async function startGuest(sdk, sandbox, manifest) {
  const source = await readFile(new URL('./guest.mjs', import.meta.url));
  await sandbox.importTree([sdk.sandbox.fileFromBytes('qualification/guest.mjs', source)]);
  const reservation = sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: [`${sandbox.workspace}/qualification/guest.mjs`, String(manifest.production.limits.requestMs)],
    cwd: sandbox.workspace, env: { LANG: 'C.UTF-8' } });
  const streams = await reservation.start();
  const session = new GuestSession(streams, manifest.production.limits.requestMs);
  return session;
}

export class GuestSession {
  constructor(streams, timeoutMs) {
    this.streams = streams;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = null;
    this.failure = null;
    const ready = Promise.withResolvers(); this.ready = ready.promise;
    void this.ready.catch(() => {});
    const readyTimer = setTimeout(() => ready.reject(new Error('Guest readiness deadline')), timeoutMs);
    streams.stdin.on('error', (error) => { this.failure ??= error; });
    this.stderr = '';
    this.stderrDone = (async () => {
      for await (const chunk of streams.stderr) {
        this.stderr += chunk.toString(); assert(this.stderr.length <= 65536, 'Guest diagnostic output bound');
      }
    })().catch((error) => { this.failure ??= error; });
    this.done = (async () => {
      let pending = Buffer.alloc(0);
      for await (const chunk of streams.stdout) {
        pending = Buffer.concat([pending, chunk]); assert(pending.length <= 32768, 'Guest frame working bound');
        for (;;) {
          const end = pending.indexOf(10); if (end < 0) break;
          const message = JSON.parse(pending.subarray(0, end).toString('utf8')); pending = pending.subarray(end + 1);
          if (message.ready === true && !this.started) { this.started = true; clearTimeout(readyTimer); ready.resolve(); continue; }
          assert(this.pending && message.id === this.pending.id, 'Guest returned an unowned response');
          const owner = this.pending; this.pending = null; clearTimeout(owner.timer); owner.resolve(message);
        }
      }
      assert.equal(pending.length, 0, 'Guest output ended inside a frame');
      if (!this.started) throw new Error('Guest ended before readiness');
    })().catch((error) => {
      this.failure ??= error; clearTimeout(readyTimer); ready.reject(error);
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    });
    this.exit = streams.exit;
    void this.exit.catch((error) => { this.failure ??= error; });
  }

  async request(command) {
    assert(!this.pending, 'The qualification owns one pending guest request');
    if (this.failure) throw this.failure;
    const id = ++this.nextId;
    const bytes = Buffer.from(JSON.stringify({ ...command, id }) + '\n');
    assert(bytes.length <= 16384, 'Guest request envelope bound');
    const operation = Promise.withResolvers();
    void operation.promise.catch(() => {});
    const timer = setTimeout(() => {
      if (this.pending?.id === id) { this.pending = null; operation.reject(new Error('Guest observation deadline')); }
    }, this.timeoutMs + 1000);
    this.pending = { id, ...operation, timer };
    try {
      if (!this.streams.stdin.write(bytes)) await once(this.streams.stdin, 'drain');
      return await operation.promise;
    } catch (error) {
      clearTimeout(timer); if (this.pending?.id === id) this.pending = null; throw error;
    }
  }

  async join() {
    this.streams.stdin.destroy();
    await Promise.all([this.done, this.stderrDone]);
    return { failure: this.failure ? { name: this.failure.name, message: this.failure.message } : null, stderr: this.stderr,
      exit: await this.exit.then((value) => value, (error) => ({ error: error.message })) };
  }
}
