import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_ACCOUNT_QUOTA_MAX_WINDOWS,
  parseAgentAccountQuotaSnapshot,
  parseAgentAccountQuotaWindow,
  safeParseAgentAccountQuotaSnapshot,
  safeParseAgentAccountQuotaWindow,
} from '../src/accountQuota/index.js';
import { parseAgentIsoDateTime } from '../src/foundation/index.js';

const observedAt = parseAgentIsoDateTime('2026-09-07T12:00:00.000Z');
const window = {
  poolId: 'pool-a',
  windowId: 'window-a',
  label: 'Weekly allowance',
  allowanceKind: 'included',
  applicability: { kind: 'account' },
  period: { kind: 'unknown', durationSeconds: 604_800 },
  measurement: { kind: 'percentage', usedPercent: 42 },
  observedAt,
} as const;
const snapshot = {
  schemaVersion: 1,
  sourceId: 'source-a',
  observedAt,
  state: 'available',
  completeness: 'complete',
  windows: [window],
  allowance: { included: 'unknown', extra: 'unknown', reserve: 'unknown' },
} as const;

test('account quota preserves independent pools, billing cycles and known zero with unknown reset', () => {
  const result = parseAgentAccountQuotaSnapshot({
    ...snapshot,
    completeness: 'partial',
    windows: [
      { ...window, measurement: { kind: 'percentage', usedPercent: 0 } },
      { ...window, poolId: 'pool-b', period: { kind: 'billing_cycle', unit: 'month' } },
    ],
  });
  assert.equal(result.state, 'available');
  if (result.state !== 'available') throw new Error('Expected allowance snapshot');
  assert.deepEqual(result.windows[0]!.measurement, { kind: 'percentage', usedPercent: 0 });
  assert.equal(result.windows[0]!.reset, undefined);
  assert.deepEqual(result.windows[1]!.period, { kind: 'billing_cycle', unit: 'month' });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.windows));
  assert.ok(Object.isFrozen(result.windows[0]!.measurement));
});

test('reported use above 100 is retained independently from extra allowance', () => {
  const result = parseAgentAccountQuotaSnapshot({
    ...snapshot,
    windows: [{ ...window, measurement: { kind: 'percentage', usedPercent: 125.25 } }],
    allowance: { included: 'exhausted', extra: 'allowed', reserve: 'unknown' },
  });
  assert.equal(result.state, 'available');
  if (result.state !== 'available') throw new Error('Expected allowance snapshot');
  assert.deepEqual(result.windows[0]!.measurement, { kind: 'percentage', usedPercent: 125.25 });
  assert.equal(result.allowance.extra, 'allowed');
});

test('unavailable and inapplicable states cannot carry account hints or stale windows', () => {
  for (const state of ['authentication_required', 'inapplicable', 'temporarily_unavailable']) {
    const input = { schemaVersion: 1, sourceId: 'source-a', observedAt, state };
    assert.deepEqual(parseAgentAccountQuotaSnapshot(input), input);
    assert.equal(safeParseAgentAccountQuotaSnapshot({ ...input, windows: [window] }).success, false);
    assert.equal(safeParseAgentAccountQuotaSnapshot({ ...input, accountLabel: 'Previous account' }).success, false);
  }
});

test('quota rejects duplicate pool/window identities and duplicate model applicability', () => {
  assert.equal(safeParseAgentAccountQuotaSnapshot({ ...snapshot, windows: [window, window] }).success, false);
  assert.equal(safeParseAgentAccountQuotaWindow({
    ...window, applicability: { kind: 'models', modelIds: ['model-a', 'model-a'] },
  }).success, false);
  assert.equal(safeParseAgentAccountQuotaWindow({
    ...window, applicability: { kind: 'models', modelIds: [] },
  }).success, false);
});

test('quota bounds collections, encoded bytes and non-JSON input before admission', () => {
  assert.equal(safeParseAgentAccountQuotaSnapshot({
    ...snapshot,
    windows: Array.from({ length: AGENT_ACCOUNT_QUOTA_MAX_WINDOWS + 1 }, (_, i) => ({ ...window, windowId: String(i) })),
  }).success, false);
  assert.equal(safeParseAgentAccountQuotaSnapshot({
    ...snapshot,
    windows: Array.from({ length: 64 }, (_, i) => ({
      ...window, windowId: String(i), label: '界'.repeat(160),
      applicability: { kind: 'models', modelIds: Array.from({ length: 32 }, (_, j) => `model-${j}-${'x'.repeat(100)}`) },
    })),
  }).success, false);
  const cyclic: Record<string, unknown> = { ...snapshot };
  cyclic.windows = [cyclic];
  assert.equal(safeParseAgentAccountQuotaSnapshot(cyclic).success, false);
  let getterCalls = 0;
  const accessor = { ...snapshot, get sourceId() { getterCalls += 1; return 'source-a'; } };
  assert.equal(safeParseAgentAccountQuotaSnapshot(accessor).success, false);
  assert.equal(getterCalls, 0);
});

test('measurement units require finite reported values and exact monetary scale', () => {
  for (const measurement of [
    { kind: 'percentage', usedPercent: -1 },
    { kind: 'percentage', usedPercent: Number.NaN },
    { kind: 'percentage', usedPercent: Number.POSITIVE_INFINITY },
    { kind: 'percentage', usedPercent: 1, remainingPercent: 99 },
    { kind: 'quantity', unit: 'credits' },
    { kind: 'quantity', unit: 'credits', used: -1 },
    { kind: 'quantity', unit: 'credits', remaining: Number.POSITIVE_INFINITY },
    { kind: 'money', currency: 'USD', scale: 2 },
    { kind: 'money', currency: 'USD', scale: 2, usedMinorUnits: 12.5 },
    { kind: 'money', currency: 'USD', scale: 10, usedMinorUnits: 10 },
    { kind: 'money', currency: 'USD', scale: -1, usedMinorUnits: 10 },
    { kind: 'money', currency: 'usd', scale: 2, usedMinorUnits: 10 },
    { kind: 'money', currency: 'USD', scale: 2, usedMinorUnits: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'money', currency: 'USD', scale: 2, remainingMinorUnits: -10 },
  ]) {
    assert.equal(safeParseAgentAccountQuotaWindow({ ...window, measurement }).success, false, JSON.stringify(measurement));
  }
  for (const measurement of [
    { kind: 'unknown' },
    { kind: 'quantity', unit: 'reset credits', remaining: 2 },
    { kind: 'money', currency: 'JPY', scale: 0, usedMinorUnits: 123 },
    { kind: 'money', currency: 'USD', scale: 2, usedMinorUnits: 123, usedPercent: 12.3 },
  ]) {
    assert.deepEqual(parseAgentAccountQuotaWindow({ ...window, measurement }).measurement, measurement);
  }
});

test('reset precision and stale reset evidence survive while future observations fail', () => {
  const reset = { at: '2026-09-14T00:00:00.000Z', observedAt: '2026-09-07T11:00:00.000Z', precision: 'estimated' };
  assert.deepEqual(parseAgentAccountQuotaWindow({ ...window, reset }).reset, reset);
  assert.equal(safeParseAgentAccountQuotaWindow({ ...window, reset: { ...reset, observedAt: '2026-09-07T13:00:00.000Z' } }).success, false);
  assert.equal(safeParseAgentAccountQuotaWindow({ ...window, reset, startsAt: reset.at }).success, false);
  assert.equal(safeParseAgentAccountQuotaSnapshot({ ...snapshot, observedAt: '2026-09-07T11:00:00.000Z' }).success, false);
});
