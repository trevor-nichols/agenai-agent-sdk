import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOriginalHistory } from './cold-history.mjs';

test('cold history requires a complete passive trace and one cleanly closed coordinator holder', () => {
  const history = [
    { kind: 'child_spawn', pid: 101, args: ['open', 'b'.repeat(64)] },
    { kind: 'request', id: 1, method: 'POST', target: '/v1.52/containers/create?name=original' },
    { kind: 'response', id: 1, method: 'POST', target: '/v1.52/containers/create?name=original', status: 201, complete: true },
    { kind: 'child_close', pid: 101, code: 0, signal: null },
    { kind: 'closed', requests: 1, active: [], activeChildren: [], complete: true },
  ];
  assert.deepEqual(assertOriginalHistory(history).holder, { pid: 101, code: 0, signal: null, joined: true });
  for (const [change, expected] of [
    [(value) => { value.splice(1, 0, { kind: 'child_spawn', pid: 102, args: ['open', 'c'.repeat(64)] }); }, /Exactly one original native coordinator holder/u],
    [(value) => { value.splice(3, 1); }, /holder exit was not observed/u],
    [(value) => { value[3].code = 1; }, /strictly equal/u],
    [(value) => { value[2].complete = false; }, /falsy value/u],
    [(value) => { value.at(-1).complete = false; }, /strictly equal/u],
  ]) {
    const value = structuredClone(history); change(value); assert.throws(() => assertOriginalHistory(value), expected);
  }
});
