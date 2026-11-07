import assert from 'node:assert/strict';

export function assertOriginalHistory(history) {
  const requests = history.filter(({ kind }) => kind === 'request');
  const terminal = history.at(-1);
  assert.equal(terminal.kind, 'closed'); assert.equal(terminal.complete, true); assert.deepEqual(terminal.active, []);
  assert.deepEqual(terminal.activeChildren, []); assert.equal(terminal.requests, requests.length);
  const holders = history.filter(({ kind, args }) => kind === 'child_spawn' && args?.[0] === 'open' && /^[a-f0-9]{64}$/u.test(args[1]));
  assert.equal(holders.length, 1, 'Exactly one original native coordinator holder must open.');
  const holder = history.find(({ kind, pid }) => kind === 'child_close' && pid === holders[0].pid);
  assert(holder, 'Original native coordinator holder exit was not observed.');
  assert.equal(holder.code, 0); assert.equal(holder.signal, null);
  const responses = history.filter(({ kind }) => kind === 'response');
  assert.equal(responses.length, requests.length); assert(responses.every(({ complete }) => complete));
  return { requests: requests.length, holder: { pid: holder.pid, code: 0, signal: null, joined: true },
    scope: 'Complete passive original HTTP history and one original native coordinator holder that exited cleanly. Member process and absence proof belong to the original controller report.' };
}
