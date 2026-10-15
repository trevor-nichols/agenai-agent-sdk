import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentProtocolValidationError,
  parseAgentSessionDecisionRequest,
  parseAgentSessionDecisionResponse,
  parseAgentSessionDecisionResponseFor,
  safeParseAgentSessionDecisionChoiceId,
  safeParseAgentSessionDecisionRequest,
  safeParseAgentSessionDecisionResponse,
} from '../src/public/index.js';
import { sessionDecisionFixture } from './sessionInteractions.fixture.js';

test('session decisions preserve exact scope and effects in a detached immutable snapshot', () => {
  const input = sessionDecisionFixture();
  const snapshot = structuredClone(input);
  const request = parseAgentSessionDecisionRequest(input);
  assert.deepEqual(request, snapshot);
  assert.deepEqual(input, snapshot);
  assert.notEqual(request, input);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.target));
  assert.ok(Object.isFrozen(request.choices));
  assert.ok(Object.isFrozen(request.choices[0]));
  assert.ok(Object.isFrozen(request.choices[0].consequence));
  if (request.choices[0].consequence.kind === 'grant') {
    assert.ok(Object.isFrozen(request.choices[0].consequence.persistence));
  }
  input.target.path = '/different/workspace';
  input.choices[0]!.label = 'Changed after parsing';
  assert.equal(request.target.path, '/workspace/project');
  assert.equal(request.choices[0].label, 'Allow workspace configuration');
  assert.ok(Object.isFrozen(parseAgentSessionDecisionResponse({ choiceId: 'decline' })));
});

test('session decision responses select only an offered choice without native payload or turn identity', () => {
  const request = parseAgentSessionDecisionRequest(sessionDecisionFixture());
  assert.deepEqual(parseAgentSessionDecisionResponseFor(request, { choiceId: 'grant' }), { choiceId: 'grant' });
  assert.deepEqual(parseAgentSessionDecisionResponseFor(request, { choiceId: 'decline' }), { choiceId: 'decline' });
  assert.throws(
    () => parseAgentSessionDecisionResponseFor(request, { choiceId: 'cancel' }),
    AgentProtocolValidationError,
  );
  for (const input of [
    { choiceId: 'grant', outcome: 'trust' },
    { choiceId: 'grant', requestId: 'decision:1' },
    { choiceId: 'grant', turnId: 'turn:1' },
    { choiceId: 'grant', signal: new AbortController().signal },
    { choiceId: null },
  ]) assert.equal(safeParseAgentSessionDecisionResponse(input).success, false);
});

test('session decision objects and typed consequences reject unadmitted variants and keys', () => {
  const request = sessionDecisionFixture();
  const grant = request.choices[0]!;
  const decline = request.choices[1]!;
  const invalid: readonly unknown[] = [
    { ...request, kind: 'form' },
    { ...request, native: {} },
    { ...request, turnId: 'turn:1' },
    { ...request, expiresAt: undefined },
    { ...request, expiresAt: 'not-a-timestamp' },
    { ...request, requestId: ' decision:1' },
    { ...request, sessionId: '' },
    { ...request, target: { kind: 'url', path: '/workspace/project' } },
    { ...request, target: { ...request.target, nativeWorkspace: 'hidden' } },
    { ...request, choices: [{ ...grant, description: undefined }] },
    { ...request, choices: [{ ...grant, consequence: { kind: 'grant', scope: 'session', persistence: grant.consequence.persistence } }] },
    { ...request, choices: [{ ...grant, consequence: { ...grant.consequence, persistence: { kind: 'provider_managed', duration: 'persistent', mayAffectOtherSessions: false } } }] },
    { ...request, choices: [{ ...decline, consequence: { ...decline.consequence, persistence: 'persistent' } }] },
  ];
  for (const input of invalid) {
    const parsed = safeParseAgentSessionDecisionRequest(input);
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.ok(parsed.issues.length > 0);
  }
  assert.throws(() => parseAgentSessionDecisionRequest(invalid[0]), AgentProtocolValidationError);
  assert.equal(safeParseAgentSessionDecisionRequest({ ...request, choices: [decline] }).success, true);
  assert.equal(safeParseAgentSessionDecisionRequest({ ...request, choices: [grant] }).success, true);
});

test('session decision text is canonical, bounded and preserves allowed description newlines', () => {
  const request = sessionDecisionFixture();
  for (const title of ['', ' padded', 'padded ', 'line\nbreak', 'tab\tvalue', 'bad\u0085value', 'x'.repeat(121)]) {
    assert.equal(safeParseAgentSessionDecisionRequest({ ...request, title }).success, false, title);
  }
  for (const description of ['bad\tvalue', 'bad\rvalue', 'bad\u007Fvalue', 'x'.repeat(4_001)]) {
    assert.equal(safeParseAgentSessionDecisionRequest({ ...request, description }).success, false);
  }
  for (const choice of [
    { ...request.choices[0], label: 'line\nbreak' },
    { ...request.choices[0], description: 'x'.repeat(1_001) },
  ]) assert.equal(safeParseAgentSessionDecisionRequest({ ...request, choices: [choice] }).success, false);
  assert.equal(parseAgentSessionDecisionRequest({ ...request, title: '😀'.repeat(60) }).title.length, 120);
  assert.equal(safeParseAgentSessionDecisionRequest({ ...request, title: '😀'.repeat(61) }).success, false);
  assert.equal(parseAgentSessionDecisionRequest(request).description, request.description);
});

test('session decision choice IDs and portable workspace paths enforce UTF-8 without filesystem policy', () => {
  assert.equal(safeParseAgentSessionDecisionChoiceId('😀'.repeat(32)).success, true);
  assert.equal(safeParseAgentSessionDecisionChoiceId('界'.repeat(43)).success, false);
  for (const value of ['', ' choice', 'choice ', 'bad\nchoice', 'x'.repeat(129), 1]) {
    assert.equal(safeParseAgentSessionDecisionChoiceId(value).success, false);
  }
  const request = sessionDecisionFixture();
  const withPath = (path: string) => ({ ...request, target: { kind: 'workspace', path } });
  assert.equal(safeParseAgentSessionDecisionRequest(withPath(`/${'界'.repeat(1_365)}`)).success, true);
  for (const path of [`/${'界'.repeat(1_366)}`, '/bad\npath', '/bad\u200Bpath', ' /padded', '']) {
    assert.equal(safeParseAgentSessionDecisionRequest(withPath(path)).success, false);
  }
  assert.equal(parseAgentSessionDecisionRequest(withPath('portable/relative')).target.path, 'portable/relative');
  assert.equal(parseAgentSessionDecisionRequest(withPath('/another/workspace')).target.path, '/another/workspace');
});

test('session decisions bound count, unique choice identity and complete UTF-8 JSON bytes', () => {
  const request = sessionDecisionFixture();
  const choice = request.choices[1]!;
  const choices = Array.from({ length: 16 }, (_, index) => ({ ...choice, choiceId: `choice:${index}` }));
  assert.equal(safeParseAgentSessionDecisionRequest({ ...request, choices }).success, true);
  for (const invalidChoices of [[], [...choices, { ...choice, choiceId: 'choice:17' }], [choice, choice]]) {
    assert.equal(safeParseAgentSessionDecisionRequest({ ...request, choices: invalidChoices }).success, false);
  }
  const oversized = {
    ...request,
    description: '界'.repeat(4_000),
    choices: choices.map((entry) => ({ ...entry, label: '界'.repeat(120), description: '界'.repeat(1_000) })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 65_536);
  assert.equal(safeParseAgentSessionDecisionRequest(oversized).success, false);
});

test('session decision parsing rejects cycles, unsupported JSON and accessors without invoking them', () => {
  const request = sessionDecisionFixture();
  const cyclic: Record<string, unknown> = { ...request };
  cyclic.target = cyclic;
  assert.equal(safeParseAgentSessionDecisionRequest(cyclic).success, false);
  for (const input of [
    { ...request, title: () => 'unexpected' },
    { ...request, title: Symbol('unexpected') },
    { ...request, title: 1n },
    { ...request, description: undefined },
    { ...request, target: new Date() },
    { ...request, [Symbol('native')]: 'hidden' },
  ]) assert.equal(safeParseAgentSessionDecisionRequest(input).success, false);
  let getterCalls = 0;
  for (const enumerable of [true, false]) {
    const accessor = { ...request };
    Object.defineProperty(accessor, 'title', { enumerable, get() { getterCalls += 1; throw new Error('must not run'); } });
    assert.equal(safeParseAgentSessionDecisionRequest(accessor).success, false);
    const responseAccessor = Object.defineProperty({}, 'choiceId', { enumerable, get() { getterCalls += 1; return 'grant'; } });
    assert.equal(safeParseAgentSessionDecisionResponse(responseAccessor).success, false);
  }
  assert.equal(getterCalls, 0);
});
