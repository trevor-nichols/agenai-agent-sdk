// ------------------------------------------------------------------------------------------------
//                session-lifetime.test.ts - Caller-owned prompt lifetime and native cancellation
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRemaining, createSessionPeer } from './fixtures/session-peer.js';
import { events, open, turnInput } from './fixtures/session-runtime.js';

for (const timeoutMs of [undefined, 2_147_483_647 + 2000]) {
  test(timeoutMs === undefined ? 'an omitted turn deadline retains one live prompt across simulated days until native completion'
    : 'a turn deadline beyond one Node timer slice waits for its full duration and native cancellation receipt', { timeout: 3000 }, async (t) => {
    let releases = 0;
    const peer = createSessionPeer({ owned: true, confirmCancel: false, onRelease() { releases += 1; } });
    const { registry, session } = await open(peer);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const advance = async (ms: number) => {
      t.mock.timers.tick(ms);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const iterator = session.startTurn({ ...turnInput(), ...(timeoutMs === undefined ? {}
      : { deadlineAt: new Date(Date.now() + timeoutMs).toISOString() }) }).outputs[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.kind === 'event' ? first.value.event.type : undefined, 'turn.started');
    const completed = collectRemaining(iterator);
    let settled = false;
    void completed.then(() => { settled = true; }, () => { settled = true; });
    await advance(timeoutMs === undefined ? 7 * 24 * 60 * 60 * 1000 : timeoutMs - 1);
    assert.equal(releases, 0);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/cancel').length, 0);
    if (timeoutMs === undefined) {
      peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Still owned after seven days.' } }));
      peer.complete();
    } else {
      await advance(1);
      assert.equal(settled, false, 'The original prompt must remain owned until its native canceled response.');
      assert.equal(releases, 0);
      assert.equal(peer.frames.filter((frame) => frame.method === 'session/cancel').length, 1);
      peer.complete('cancelled');
    }
    const outputs = events(await completed);
    assert.deepEqual(outputs.filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome),
      [timeoutMs === undefined ? 'completed' : 'expired']);
    assert.deepEqual(outputs.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta),
      timeoutMs === undefined ? ['Still owned after seven days.'] : []);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/cancel').length, timeoutMs === undefined ? 0 : 1);
    await session.close({ reason: 'shutdown' });
    assert.equal(releases, 1);
    await advance(30 * 24 * 60 * 60 * 1000);
    assert.equal(releases, 1);
  });
}
