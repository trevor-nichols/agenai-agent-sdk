import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { failure, observe } from './evidence.mjs';

export class Session {
  constructor(streams, label, token, timeoutMs, evidence) {
    this.streams = streams; this.label = label; this.token = token; this.timeoutMs = timeoutMs; this.evidence = evidence;
    this.readerId = randomUUID(); this.pending = null; this.nextId = 0; this.failure = null; this.expectedStop = false;
    this.identity = null; this.lastTick = null; this.stdoutBytes = 0; this.stderrBytes = 0; this.closed = false; this.exit = null;
    const ready = Promise.withResolvers(); this.ready = ready.promise; void this.ready.catch(() => {});
    const readiness = setTimeout(() => this.fail(new Error('Original guest readiness deadline.')), timeoutMs);
    this.resolveReady = () => { clearTimeout(readiness); ready.resolve(); };
    this.rejectReady = (error) => { clearTimeout(readiness); ready.reject(error); };
    streams.stdin.on('error', (error) => { if (!this.expectedStop) this.fail(error); });
    this.stdoutDone = this.readOutput().catch((error) => this.fail(error));
    this.stderrDone = (async () => {
      for await (const chunk of streams.stderr) {
        assert(chunk instanceof Uint8Array); this.stderrBytes += chunk.length;
        assert(this.stderrBytes <= 64 * 1024);
        await evidence.append(`${label}-stderr.log`, Buffer.from(chunk), 64 * 1024);
      }
    })().catch((error) => this.fail(error));
    this.exitDone = streams.exit.then((value) => { this.exit = value; if (!this.expectedStop) this.fail(new Error('Original guest exited during the live scenario.')); },
      (error) => { this.exit = { failure: failure(error) }; if (!this.expectedStop) this.fail(error); });
  }
  fail(error) {
    this.failure ??= error; this.rejectReady(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); }
  }
  async readOutput() {
    let pending = Buffer.alloc(0);
    for await (const chunk of this.streams.stdout) {
      assert(chunk instanceof Uint8Array && chunk.length <= 64 * 1024);
      this.stdoutBytes += chunk.length; assert(this.stdoutBytes <= 1024 ** 2);
      await this.evidence.append(`${this.label}-stdout.jsonl`, Buffer.from(chunk), 1024 ** 2);
      pending = Buffer.concat([pending, chunk]); assert(pending.length <= 80 * 1024);
      while (pending.includes(10)) {
        const end = pending.indexOf(10); assert(end <= 16 * 1024);
        const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, end)));
        pending = pending.subarray(end + 1);
        if (frame.kind === 'ready') {
          assert.equal(this.identity, null); this.identity = frame.identity;
          assert.equal(this.identity.label, this.label); assert.equal(this.identity.session, this.token);
          assert(Number.isSafeInteger(this.identity.pid) && this.identity.pid > 0); this.resolveReady();
        } else if (frame.kind === 'tick') {
          assert(this.identity); assert.equal(frame.pid, this.identity.pid); assert.equal(frame.session, this.token); assert.equal(frame.label, this.label);
          assert.equal(frame.counter, (this.lastTick?.counter ?? 0) + 1);
          this.lastTick = { ...frame, receivedAt: new Date().toISOString() };
        } else {
          assert.equal(frame.kind, 'reply'); assert(this.pending && frame.id === this.pending.id, 'Guest reply lost its original request owner.');
          const request = this.pending; this.pending = null; clearTimeout(request.timer); request.resolve(frame);
        }
      }
    }
    assert.equal(pending.length, 0, 'Original stdout reader ended inside a frame.'); this.closed = true;
    if (!this.expectedStop) this.fail(new Error('Original stdout reader ended during the live scenario.'));
  }
  async request(command) {
    if (this.failure) throw this.failure;
    assert(!this.pending && ++this.nextId <= 48);
    const result = Promise.withResolvers(); void result.promise.catch(() => {});
    const id = this.nextId;
    const timer = setTimeout(() => this.fail(new Error('Original guest request observation deadline.')), this.timeoutMs + 1000);
    this.pending = { id, ...result, timer };
    const bytes = Buffer.from(`${JSON.stringify({ ...command, id })}\n`); assert(bytes.length <= 4096);
    await observe(new Promise((resolve, reject) => this.streams.stdin.write(bytes, (error) => error ? reject(error) : resolve())),
      this.timeoutMs, 'Original guest stdin write');
    const response = await result.promise; assert.equal(response.ok, true, JSON.stringify(response)); return response.result;
  }
  async progress(previous = this.lastTick?.counter ?? 0) {
    const deadline = performance.now() + this.timeoutMs;
    while ((this.lastTick?.counter ?? 0) < previous + 3) {
      if (this.failure) throw this.failure;
      assert(performance.now() < deadline, 'The original guest stopped producing fresh output.');
      await delay(25);
    }
    return this.summary();
  }
  summary() { return { readerId: this.readerId, identity: this.identity, lastTick: this.lastTick,
    stdoutBytes: this.stdoutBytes, stderrBytes: this.stderrBytes, closed: this.closed, exit: this.exit,
    failure: this.failure ? failure(this.failure) : null }; }
  expectStop() { this.expectedStop = true; }
  async join() {
    this.expectedStop = true; this.streams.stdin.destroy();
    await Promise.all([this.stdoutDone, this.stderrDone, this.exitDone]); return this.summary();
  }
}
