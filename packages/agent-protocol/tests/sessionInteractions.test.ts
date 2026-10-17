import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentProtocolValidationError,
  AGENT_SESSION_REQUEST_BYTES_LIMIT,
  AGENT_SESSION_PLAN_TEXT_BYTES_LIMIT,
  parseAgentSessionRequest,
  parseAgentSessionResponse,
  parseAgentSessionResponseFor,
  parseAgentSessionFormRequest,
  parseAgentSessionFormResponseFor,
  parseAgentSessionPlanReviewRequest,
  parseAgentSessionPlanReviewResponseFor,
  safeParseAgentSessionRequest,
  safeParseAgentSessionResponse,
  safeParseAgentSessionResponseFor,
  safeParseAgentSessionFormRequest,
  safeParseAgentSessionFormResponse,
  safeParseAgentSessionPlanReviewRequest,
  safeParseAgentSessionPlanReviewResponse,
  safeParseAgentSessionFormChoiceId,
  safeParseAgentSessionPlanReviewChoiceId,
  safeParseAgentSessionPlanId,
  safeParseAgentSessionPlanRevision,
  parseAgentSessionDecisionRequest,
  parseAgentSessionDecisionResponse,
  parseAgentSessionDecisionResponseFor,
  safeParseAgentSessionDecisionChoiceId,
  safeParseAgentSessionDecisionRequest,
  safeParseAgentSessionDecisionResponse,
} from '../src/public/index.js';
import { AgentSessionFormChoiceSchema, AgentSessionPlanReviewChoiceSchema } from '../src/zod/index.js';
import { sessionDecisionFixture, sessionFormFixture, sessionFormResponseFixture, sessionPlanReviewFixture, sessionPlanReviewResponseFixture } from './sessionInteractions.fixture.js';

test('exported session choice schemas preserve exact optional JSON descriptions without invoking accessors', () => {
  let getterCalls = 0;
  for (const schema of [AgentSessionFormChoiceSchema, AgentSessionPlanReviewChoiceSchema]) {
    const choice = schema === AgentSessionFormChoiceSchema
      ? { choiceId: 'submit', action: 'submit', label: 'Submit' }
      : { choiceId: 'approve', action: 'approve', label: 'Approve' };
    const parsed = schema.parse(choice);
    assert.deepEqual(parsed, choice);
    assert.equal('description' in parsed, false);
    assert.ok(Object.isFrozen(parsed));
    assert.deepEqual(schema.parse({ ...choice, description: 'Human-readable consequence' }), {
      ...choice, description: 'Human-readable consequence',
    });
    assert.equal(schema.safeParse({ ...choice, description: undefined }).success, false);
    for (const enumerable of [true, false]) {
      const accessor = Object.defineProperty({ ...choice }, 'description', {
        enumerable,
        get() { getterCalls += 1; return 'Must not run'; },
      });
      assert.equal(schema.safeParse(accessor).success, false);
    }
  }
  assert.equal(getterCalls, 0);
});

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
  assert.ok(Object.isFrozen(parseAgentSessionDecisionResponse({ kind: 'decision', choiceId: 'decline' })));
});

test('session decision responses select only an offered choice without native payload or turn identity', () => {
  const request = parseAgentSessionDecisionRequest(sessionDecisionFixture());
  assert.deepEqual(parseAgentSessionDecisionResponseFor(request, { kind: 'decision', choiceId: 'grant' }), { kind: 'decision', choiceId: 'grant' });
  assert.deepEqual(parseAgentSessionDecisionResponseFor(request, { kind: 'decision', choiceId: 'decline' }), { kind: 'decision', choiceId: 'decline' });
  assert.throws(
    () => parseAgentSessionDecisionResponseFor(request, { kind: 'decision', choiceId: 'cancel' }),
    AgentProtocolValidationError,
  );
  for (const input of [
    { kind: 'decision', choiceId: 'grant', outcome: 'trust' },
    { kind: 'decision', choiceId: 'grant', requestId: 'decision:1' },
    { kind: 'decision', choiceId: 'grant', turnId: 'turn:1' },
    { kind: 'decision', choiceId: 'grant', signal: new AbortController().signal },
    { kind: 'decision', choiceId: null },
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

test('V12 session unions round-trip all closed kinds and preserve absent provider expiry', () => {
  const { expiresAt: _expiry, ...decision } = sessionDecisionFixture();
  for (const [input, response] of [
    [decision, { kind: 'decision', choiceId: 'decline' }],
    [sessionFormFixture(), sessionFormResponseFixture()],
    [sessionPlanReviewFixture(), sessionPlanReviewResponseFixture()],
  ]) {
    const request = parseAgentSessionRequest(input);
    assert.deepEqual(request, input);
    assert.equal('expiresAt' in request, false);
    assert.deepEqual(parseAgentSessionRequest(JSON.parse(JSON.stringify(request))), request);
    const accepted = parseAgentSessionResponseFor(request, response);
    assert.deepEqual(accepted, response);
    assert.deepEqual(parseAgentSessionResponse(JSON.parse(JSON.stringify(accepted))), response);
    assert.ok(Object.isFrozen(request));
    assert.ok(Object.isFrozen(request.choices));
    assert.ok(Object.isFrozen(accepted));
  }
  assert.equal(safeParseAgentSessionDecisionResponse({ choiceId: 'decline' }).success, false);
  assert.equal(safeParseAgentSessionRequest({ ...decision, humanWait: { kind: 'bounded' } }).success, false);
});

test('session forms reuse exact required fields, offered values and distinct human actions', () => {
  const request = parseAgentSessionFormRequest(sessionFormFixture());
  const response = sessionFormResponseFixture();
  assert.deepEqual(parseAgentSessionFormResponseFor(request, response), response);
  assert.deepEqual(parseAgentSessionFormResponseFor(request, { kind: 'form', action: 'cancel', choiceId: 'cancel' }), {
    kind: 'form', action: 'cancel', choiceId: 'cancel',
  });
  assert.ok(Object.isFrozen(request.fields));
  assert.ok(Object.isFrozen(request.fields[0]));
  const invalid = [
    { ...response, action: 'cancel' },
    { ...response, choiceId: 'cancel' },
    { ...response, choiceId: 'unoffered' },
    { ...response, answers: response.answers.slice(1) },
    { ...response, answers: [...response.answers, response.answers[0]] },
    { ...response, answers: [{ kind: 'text', fieldId: 'foreign', value: 'foreign' }, ...response.answers] },
    { ...response, answers: [{ kind: 'text', fieldId: 'name', value: 'x'.repeat(41) }, ...response.answers.slice(1)] },
    { ...response, answers: [{ kind: 'text', fieldId: 'name', value: '   ' }, ...response.answers.slice(1)] },
    { ...response, answers: [response.answers[0], { kind: 'single_select', fieldId: 'region', value: 'unoffered' }] },
    { ...response, answers: [response.answers[0], { kind: 'single_select', fieldId: 'region', other: 'unoffered' }] },
    { ...response, answers: [response.answers[0], { kind: 'single_select', fieldId: 'region', value: 'east', other: 'Both' }] },
    { ...response, answers: [...response.answers.slice(0, 2), { kind: 'multi_select', fieldId: 'features', values: ['search', 'search'] }] },
    { ...response, answers: [...response.answers.slice(0, 2), { kind: 'multi_select', fieldId: 'features', values: ['search', 'reports'], other: 'Third' }] },
    { ...response, answers: [...response.answers.slice(0, 2), { kind: 'multi_select', fieldId: 'features', values: ['foreign'] }] },
    { ...response, answers: [{ kind: 'boolean', fieldId: 'name', value: true }, ...response.answers.slice(1)] },
    { kind: 'decision', choiceId: 'submit' },
  ];
  for (const input of invalid) {
    assert.equal(safeParseAgentSessionResponseFor(request, input).success, false, JSON.stringify(input));
  }
  const withoutCancel = parseAgentSessionFormRequest({ ...sessionFormFixture(), choices: [sessionFormFixture().choices[0]] });
  assert.throws(() => parseAgentSessionFormResponseFor(withoutCancel, { kind: 'form', action: 'cancel', choiceId: 'cancel' }), AgentProtocolValidationError);
});

test('session form descriptors admit 100 options and reject duplicate fields, values and actions', () => {
  const request = sessionFormFixture();
  const field = {
    kind: 'single_select', fieldId: 'selected', label: 'Select', required: true, sensitivity: 'ordinary', allowOther: false,
    options: Array.from({ length: 100 }, (_, index) => ({ value: `option:${index}`, label: `Option ${index}` })),
  };
  const valid = { ...request, fields: [field] };
  assert.equal(parseAgentSessionFormRequest(valid).fields[0].kind, 'single_select');
  const parsed = parseAgentSessionFormRequest(valid);
  assert.deepEqual(parseAgentSessionFormResponseFor(parsed, {
    kind: 'form', action: 'submit', choiceId: 'submit', answers: [{ kind: 'single_select', fieldId: 'selected', value: 'option:99' }],
  }), {
    kind: 'form', action: 'submit', choiceId: 'submit', answers: [{ kind: 'single_select', fieldId: 'selected', value: 'option:99' }],
  });
  for (const invalid of [
    { ...valid, fields: [{ ...field, options: [...field.options, { value: 'option:100', label: 'Too many' }] }] },
    { ...valid, fields: [{ ...field, options: [field.options[0], field.options[0]] }] },
    { ...valid, fields: [field, field] },
    { ...valid, fields: Array.from({ length: 17 }, (_, index) => ({ ...field, fieldId: `field:${index}` })) },
    { ...request, choices: [] },
    { ...request, choices: [request.choices[1]] },
    { ...request, choices: [request.choices[0], { ...request.choices[0], choiceId: 'second-submit' }] },
    { ...request, choices: [request.choices[0], { ...request.choices[1], choiceId: 'submit' }] },
    { ...request, fields: [{ ...field, kind: 'multi_select', maxSelections: 101 }] },
    { ...request, fields: [{ ...field, kind: 'multi_select', options: [field.options[0]], maxSelections: 2 }] },
  ]) assert.equal(safeParseAgentSessionFormRequest(invalid).success, false);
});

test('plan review responses bind the actual complete plan revision and exact offered action', () => {
  const input = sessionPlanReviewFixture();
  const request = parseAgentSessionPlanReviewRequest(input);
  assert.ok(Object.isFrozen(request.plan));
  assert.ok(Object.isFrozen(request.plan.content));
  input.plan.content.text = 'Changed after parsing';
  assert.match(request.plan.content.text, /^# Implementation/u);
  for (const action of ['approve', 'revise', 'abandon']) {
    const response = {
      kind: 'plan_review', action, choiceId: action, planId: 'plan:1', revision: 'revision:1',
      ...(action === 'revise' ? { feedback: 'Keep this exact feedback.\n' } : {}),
    };
    assert.deepEqual(parseAgentSessionPlanReviewResponseFor(request, response), response);
  }
  const response = sessionPlanReviewResponseFixture();
  for (const invalid of [
    { ...response, choiceId: 'approve' },
    { ...response, choiceId: 'unoffered' },
    { ...response, planId: 'plan:2' },
    { ...response, revision: 'revision:2' },
    { ...response, feedback: '' },
    { ...response, feedback: ' \n ' },
    { ...response, feedback: 'x'.repeat(4_001) },
    { ...response, action: 'approve', choiceId: 'approve' },
    { kind: 'plan_review', action: 'revise', choiceId: 'revise', planId: 'plan:1', revision: 'revision:1' },
    { kind: 'form', action: 'cancel', choiceId: 'abandon' },
  ]) assert.equal(safeParseAgentSessionResponseFor(request, invalid).success, false);
  const approveOnly = parseAgentSessionPlanReviewRequest({ ...sessionPlanReviewFixture(), choices: [sessionPlanReviewFixture().choices[0]] });
  assert.throws(() => parseAgentSessionPlanReviewResponseFor(approveOnly, response), AgentProtocolValidationError);
  for (const invalid of [
    { ...input, choices: [input.choices[0], { ...input.choices[1], action: 'approve' }] },
    { ...input, choices: [input.choices[0], { ...input.choices[1], choiceId: 'approve' }] },
    { ...input, plan: { ...input.plan, content: { kind: 'url', url: 'https://example.com/plan' } } },
    { ...input, plan: { ...input.plan, content: { ...input.plan.content, native: true } } },
  ]) assert.equal(safeParseAgentSessionPlanReviewRequest(invalid).success, false);
});

test('new session nominal IDs enforce canonical UTF-8 bytes before granting distinct identities', () => {
  for (const parse of [safeParseAgentSessionFormChoiceId, safeParseAgentSessionPlanReviewChoiceId, safeParseAgentSessionPlanId, safeParseAgentSessionPlanRevision]) {
    assert.equal(parse('😀'.repeat(32)).success, true);
    for (const input of ['', ' padded', 'padded ', 'line\nbreak', 'x'.repeat(129), '界'.repeat(43), 1]) {
      assert.equal(parse(input).success, false);
    }
  }
});

test('plan text and total session descriptors enforce independent exact byte ceilings', () => {
  const request = sessionPlanReviewFixture();
  const withText = (text: string) => ({ ...request, plan: { ...request.plan, content: { ...request.plan.content, text } } });
  assert.equal(safeParseAgentSessionPlanReviewRequest(withText('界'.repeat(16_384))).success, true);
  assert.equal(Buffer.byteLength('界'.repeat(16_384), 'utf8'), AGENT_SESSION_PLAN_TEXT_BYTES_LIMIT);
  assert.equal(safeParseAgentSessionPlanReviewRequest(withText(`${'界'.repeat(16_384)}x`)).success, false);
  const material = {
    ...withText(''), description: '界'.repeat(4_000),
    choices: request.choices.map((choice) => ({ ...choice, description: '界'.repeat(1_000) })),
  };
  const remainingBytes = AGENT_SESSION_REQUEST_BYTES_LIMIT - Buffer.byteLength(JSON.stringify(material), 'utf8');
  assert.ok(remainingBytes > 0 && remainingBytes < AGENT_SESSION_PLAN_TEXT_BYTES_LIMIT);
  const bounded = { ...material, plan: { ...material.plan, content: { ...material.plan.content, text: 'x'.repeat(remainingBytes) } } };
  assert.equal(Buffer.byteLength(JSON.stringify(bounded), 'utf8'), AGENT_SESSION_REQUEST_BYTES_LIMIT);
  assert.equal(safeParseAgentSessionRequest(bounded).success, true);
  const over = { ...bounded, plan: { ...bounded.plan, content: { ...bounded.plan.content, text: `${bounded.plan.content.text}x` } } };
  assert.equal(Buffer.byteLength(JSON.stringify(over), 'utf8'), AGENT_SESSION_REQUEST_BYTES_LIMIT + 1);
  assert.equal(safeParseAgentSessionRequest(over).success, false);
});

test('session form responses enforce total bytes independently of individual text limits', () => {
  const response = {
    kind: 'form', action: 'submit', choiceId: 'submit',
    answers: Array.from({ length: 16 }, (_, index) => ({ kind: 'text', fieldId: `field:${index}`, value: '界'.repeat(4_000) })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(response), 'utf8') > 65_536);
  assert.equal(safeParseAgentSessionFormResponse(response).success, false);
  const within = { ...response, answers: response.answers.slice(0, 5) };
  assert.equal(safeParseAgentSessionFormResponse(within).success, true);
  assert.equal(safeParseAgentSessionPlanReviewResponse({ ...sessionPlanReviewResponseFixture(), feedback: '😀'.repeat(2_000) }).success, true);
});

test('generalized session parsing rejects non-JSON and accessor input without invoking getters', () => {
  let getterCalls = 0;
  for (const fixture of [sessionFormFixture(), sessionPlanReviewFixture()]) {
    const cyclic = { ...fixture, description: {} };
    cyclic.description = cyclic;
    for (const invalid of [
      cyclic, { ...fixture, expiresAt: undefined }, { ...fixture, description: 1n },
      { ...fixture, title: new Date() }, { ...fixture, [Symbol('native')]: 'hidden' },
    ]) assert.equal(safeParseAgentSessionRequest(invalid).success, false);
    const accessor = Object.defineProperty({ ...fixture }, 'title', { enumerable: true, get() { getterCalls += 1; return 'Unexpected'; } });
    assert.equal(safeParseAgentSessionRequest(accessor).success, false);
  }
  for (const fixture of [sessionFormResponseFixture(), sessionPlanReviewResponseFixture()]) {
    const accessor = Object.defineProperty({ ...fixture }, 'choiceId', { enumerable: false, get() { getterCalls += 1; return 'Unexpected'; } });
    assert.equal(safeParseAgentSessionResponse(accessor).success, false);
    assert.equal(safeParseAgentSessionResponse({ ...fixture, native: () => null }).success, false);
  }
  assert.equal(getterCalls, 0);
});
