import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_PROTOCOL_CODE_MAX_LENGTH,
  AGENT_PROTOCOL_ID_MAX_LENGTH,
  AGENT_PROTOCOL_JSON_BYTES_LIMIT,
  AGENT_PROTOCOL_TEXT_MAX_LENGTH,
  parseAgentError,
  safeParseAgentError,
} from '../src/public/index.js';

const observedAt = '2026-10-11T12:00:00.000Z';
const quota = {
  sourceId: 'source:funding',
  poolId: 'pool:included',
  windowId: 'window:weekly',
  observedAt,
} as const;
const failure = {
  category: 'unknown',
  code: 'operation_failed',
  message: 'The operation failed.',
  recovery: { kind: 'unknown' },
} as const;

test('failure classification and recovery preserve reported facts without inventing quota evidence', () => {
  for (const category of [
    'rate_limited', 'quota_exhausted', 'budget_exhausted', 'execution_limit',
    'context_limit', 'authentication', 'permission', 'invalid_request',
    'overloaded', 'transport', 'provider', 'protocol', 'internal', 'unknown',
  ]) {
    const input = { ...failure, category };
    assert.deepEqual(parseAgentError(input), input, category);
  }
  for (const recovery of [
    { kind: 'unknown' },
    { kind: 'none' },
    { kind: 'retry' },
    { kind: 'retry', notBefore: observedAt },
    { kind: 'wait_for_quota' },
    ...['authenticate', 'review_access', 'change_configuration', 'review_allowance']
      .map((action) => ({ kind: 'user_action', action })),
  ]) {
    const parsed = parseAgentError({ ...failure, recovery });
    assert.deepEqual(parsed.recovery, recovery);
    assert.ok(Object.isFrozen(parsed.recovery));
    assert.equal('quota' in parsed.recovery, false);
  }
  assert.ok(Object.isFrozen(parseAgentError(failure)));
});

test('failure contracts require neutral fields and reject native or legacy escape hatches', () => {
  for (const required of ['category', 'code', 'message', 'recovery']) {
    const input: Record<string, unknown> = { ...failure };
    delete input[required];
    assert.equal(safeParseAgentError(input).success, false, required);
  }
  for (const input of [
    { ...failure, category: 'subscription_limit' },
    { ...failure, retryable: true },
    { ...failure, providerKey: 'native-provider' },
    { ...failure, rawError: { stack: 'provider-private trace' } },
    { ...failure, context: { requestId: 'native-request' } },
    { ...failure, context: { operation: ' execute ' } },
    { code: failure.code, message: failure.message, retryable: false },
  ]) {
    assert.equal(safeParseAgentError(input).success, false);
  }
});

test('recovery alternatives are closed and quota references apply only to account rate or quota failures', () => {
  for (const category of ['rate_limited', 'quota_exhausted']) {
    const input = { ...failure, category, recovery: { kind: 'wait_for_quota', quota } };
    assert.deepEqual(parseAgentError(input), input);
  }
  for (const recovery of [
    { kind: 'unknown', notBefore: observedAt },
    { kind: 'none', action: 'authenticate' },
    { kind: 'retry', quota },
    { kind: 'retry', notBefore: '2026-02-30T12:00:00.000Z' },
    { kind: 'wait_for_quota', notBefore: observedAt },
    { kind: 'user_action' },
    { kind: 'user_action', action: 'switch_provider' },
    { kind: 'user_action', action: 'authenticate', quota },
  ]) {
    assert.equal(safeParseAgentError({ ...failure, recovery }).success, false);
  }
  for (const category of ['budget_exhausted', 'execution_limit', 'context_limit', 'unknown']) {
    const parsed = safeParseAgentError({
      ...failure, category, recovery: { kind: 'wait_for_quota', quota },
    });
    assert.equal(parsed.success, false, category);
    if (!parsed.success) assert.deepEqual(parsed.issues[0]?.path, ['recovery', 'quota']);
  }
});

test('quota failure references retain exact reset evidence and enforce quota identity and observation bounds', () => {
  const quotaFailure = (reference: unknown) => ({
    ...failure,
    category: 'quota_exhausted',
    recovery: { kind: 'wait_for_quota', quota: reference },
  });
  for (const precision of ['reported', 'estimated']) {
    const reference = {
      ...quota,
      sourceId: 's'.repeat(AGENT_PROTOCOL_ID_MAX_LENGTH),
      poolId: 'p'.repeat(AGENT_PROTOCOL_ID_MAX_LENGTH),
      windowId: 'w'.repeat(AGENT_PROTOCOL_ID_MAX_LENGTH),
      reset: { at: '2026-10-18T12:00:00.000Z', precision, observedAt },
    };
    assert.deepEqual(parseAgentError(quotaFailure(reference)).recovery, {
      kind: 'wait_for_quota', quota: reference,
    });
  }
  for (const reference of [
    { ...quota, sourceId: 's'.repeat(AGENT_PROTOCOL_ID_MAX_LENGTH + 1) },
    { ...quota, poolId: '' },
    { ...quota, windowId: ' window ' },
    { ...quota, observedAt: 'not-a-timestamp' },
    { ...quota, reset: { at: observedAt, precision: 'inferred', observedAt } },
    { ...quota, reset: { at: 'tomorrow', precision: 'reported', observedAt } },
    { ...quota, reset: { at: observedAt, precision: 'reported', observedAt: '2026-10-11T12:00:00.001Z' } },
    { ...quota, reset: { at: observedAt, precision: 'reported', observedAt, rawHeader: 'private' } },
    { ...quota, accountId: 'private-account' },
  ]) {
    assert.equal(safeParseAgentError(quotaFailure(reference)).success, false);
  }
});

test('failure text, context, and serialized UTF-8 size keep their existing protocol bounds', () => {
  const bounded = {
    ...failure,
    code: 'c'.repeat(AGENT_PROTOCOL_CODE_MAX_LENGTH),
    message: '界'.repeat(AGENT_PROTOCOL_TEXT_MAX_LENGTH),
    context: { operation: 'o'.repeat(160), component: 'c'.repeat(160), status: 's'.repeat(160) },
  };
  assert.deepEqual(parseAgentError(bounded), bounded);
  for (const input of [
    { ...failure, code: 'c'.repeat(AGENT_PROTOCOL_CODE_MAX_LENGTH + 1) },
    { ...failure, message: 'm'.repeat(AGENT_PROTOCOL_TEXT_MAX_LENGTH + 1) },
    { ...failure, context: { operation: 'o'.repeat(161) } },
    { ...failure, code: ' ' },
    { ...failure, message: ' failure ' },
  ]) {
    assert.equal(safeParseAgentError(input).success, false);
  }
  const oversized = safeParseAgentError({
    ...failure,
    recovery: { kind: 'retry', notBefore: `2026-10-11T12:00:00.${'1'.repeat(AGENT_PROTOCOL_JSON_BYTES_LIMIT)}Z` },
  });
  assert.equal(oversized.success, false);
  if (!oversized.success) assert.match(oversized.issues[0]?.message ?? '', /serialized bytes/u);
});
