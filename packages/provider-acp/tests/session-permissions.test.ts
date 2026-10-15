import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentApprovalRequest } from '@agen-ai/agent-protocol';
import type { AgentProviderOutput } from '@agen-ai/agent-runtime';
import type { AcpPermissionMappingSelection, AcpPermissionOptionSignature } from '../src/index.js';
import { collectRemaining, createSessionPeer, takeUntilRequest, type SessionPeer } from './fixtures/session-peer.js';
import { events, open, turnInput } from './fixtures/session-runtime.js';

const hasReason = (reason: string) => (error: unknown): boolean => error instanceof Error && 'reasonCode' in error && error.reasonCode === reason;
const approvalFrom = (outputs: readonly AgentProviderOutput[]): AgentApprovalRequest => {
  const opened = events(outputs).find((event) => event.type === 'request.opened');
  assert.ok(opened?.type === 'request.opened' && opened.payload.request.requestKind === 'approval');
  return opened.payload.request;
};
const fourOptions = [
  { optionId: 'native:remember-allow', kind: 'allow_always' },
  { optionId: 'native:once-allow', kind: 'allow_once' },
  { optionId: 'native:remember-deny', kind: 'reject_always' },
  { optionId: 'native:once-deny', kind: 'reject_once' },
] as const;
const declared = (options: readonly [AcpPermissionOptionSignature, ...AcpPermissionOptionSignature[]] = fourOptions): AcpPermissionMappingSelection => ({
  mapping: 'declared-complete-consequences-v1',
  agentInfo: { name: 'session-fixture', version: '1.0.0' },
  menus: [{ toolKind: 'edit', options }],
});
const remembrance = {
  kind: 'provider_managed_remembrance', duration: { kind: 'unknown' }, applicability: { kind: 'unknown' },
  explanation: 'The provider is asked to remember this decision. Duration and future matching are unspecified. Delivery does not establish successful persistence or revocation.',
};
const once = { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } };
const permissionParams = (peer: SessionPeer, options: readonly AcpPermissionOptionSignature[] = fourOptions) => ({
  sessionId: peer.sessionId,
  toolCall: { toolCallId: 'edit:1', title: 'Edit file', kind: 'edit', status: 'in_progress', displayHint: 'Observed tool display' },
  options: options.map((option) => ({ ...option, name: option.kind.endsWith('always') ? 'Remember permanently for every workspace' : 'Current action' })),
});
const sendPermission = (peer: SessionPeer, id: string, params: object) => peer.send({ jsonrpc: '2.0', id, method: 'session/request_permission', params });

test('default mapping rejects native IDs duplicated across retained once and filtered remembered options', { timeout: 3_000 }, async (t) => {
  let prompts = 0;
  const peer = createSessionPeer({ onPrompt(peer) {
    prompts += 1;
    sendPermission(peer, `duplicate:${prompts}`, permissionParams(peer, [
      { optionId: 'native:once', kind: 'allow_once' },
      { optionId: prompts === 1 ? 'native:remembered' : 'native:once', kind: 'allow_always' },
    ]));
  }, onResolution(peer) { peer.complete(); } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const first = session.startTurn(turnInput());
  const iterator = first.outputs[Symbol.asyncIterator]();
  const request = approvalFrom(await takeUntilRequest(iterator));
  assert.deepEqual(request.options.map((option) => [option.optionId, option.consequence]), [['acp:option:1', once]]);
  assert.deepEqual(await first.resolveRequest({ resolution: {
    requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: request.options[0]!.optionId,
  } }), { status: 'delivered' });
  assert.equal(events(await collectRemaining(iterator)).find((event) => event.type === 'turn.completed')?.payload.outcome, 'completed');
  const rejected: AgentProviderOutput[] = [];
  await assert.rejects(async () => {
    for await (const output of session.startTurn(turnInput('turn:2')).outputs) {
      rejected.push(output);
      if (output.kind === 'event' && output.event.type === 'request.opened') assert.fail('Duplicate native IDs became an answerable approval request.');
    }
  }, hasReason('acp_permission_option_duplicate'));
  assert.equal(events(rejected).some((event) => event.type === 'request.opened'), false);
  assert.deepEqual(peer.frames.filter((frame) => frame.id === 'duplicate:1' && !frame.method).map((frame) => frame.result), [
    { outcome: { outcome: 'selected', optionId: 'native:once' } },
  ]);
});

test('declared four-choice menus preserve exact decisions, original callbacks and deny versus cancel on the original reader', { timeout: 3_000 }, async (t) => {
  let prompts = 0;
  const peer = createSessionPeer({ onPrompt(peer) {
    prompts += 1;
    peer.batch([
      { jsonrpc: '2.0', id: `choice:${prompts}`, method: 'session/request_permission', params: permissionParams(peer) },
      peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Still answerable.' } }),
    ]);
  }, onResolution(peer) {
    peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Continued.' } }));
    peer.complete();
  } });
  const { registry, session, capabilities } = await open(peer, undefined, declared());
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  assert.deepEqual(capabilities.requests.approval, {
    kind: 'supported', providerManagedRemembrance: true, modes: [{ persistence: 'once', scopeKinds: ['exact_action'] }],
  });
  for (const index of [0, 1, 2, 3, 'cancel'] as const) {
    const execution = session.startTurn(turnInput(`turn:${prompts + 1}`));
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const opened = await takeUntilRequest(iterator);
    const request = approvalFrom(opened);
    assert.deepEqual(request.options, [
      { optionId: 'acp:option:1', label: 'Allow and remember', decision: 'approved', consequence: remembrance },
      { optionId: 'acp:option:2', label: 'Current action', decision: 'approved', consequence: once },
      { optionId: 'acp:option:3', label: 'Deny and remember', decision: 'denied', consequence: remembrance },
      { optionId: 'acp:option:4', label: 'Current action', decision: 'denied', consequence: once },
    ]);
    for (;;) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      opened.push(next.value!);
      if (next.value?.kind === 'event' && next.value.event.type === 'content.delta' && next.value.event.payload.delta === 'Still answerable.') break;
    }
    assert.equal(peer.frames.filter((frame) => frame.id === `choice:${prompts}` && !frame.method).length, 0);
    const resolution = index === 'cancel'
      ? { requestKind: 'approval' as const, requestId: request.requestId, disposition: 'canceled' as const }
      : { requestKind: 'approval' as const, requestId: request.requestId, disposition: 'selected' as const, optionId: request.options[index]!.optionId };
    assert.deepEqual(await execution.resolveRequest({ resolution }), { status: 'delivered' });
    const continued = events(await collectRemaining(iterator));
    assert.equal(continued.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta).join(''), 'Continued.');
    assert.deepEqual(continued.filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['completed']);
    await assert.rejects(async () => execution.resolveRequest({ resolution }), { code: 'request_resolution_mismatch' });
  }
  assert.deepEqual(peer.frames.filter((frame) => !frame.method).map((frame) => ({ id: frame.id, result: frame.result })), [
    { id: 'choice:1', result: { outcome: { outcome: 'selected', optionId: 'native:remember-allow' } } },
    { id: 'choice:2', result: { outcome: { outcome: 'selected', optionId: 'native:once-allow' } } },
    { id: 'choice:3', result: { outcome: { outcome: 'selected', optionId: 'native:remember-deny' } } },
    { id: 'choice:4', result: { outcome: { outcome: 'selected', optionId: 'native:once-deny' } } },
    { id: 'choice:5', result: { outcome: { outcome: 'cancelled' } } },
  ]);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 5);
});

test('remembered-only menus retain multiple same-decision IDs without fabricating once choices', { timeout: 3_000 }, async (t) => {
  const options = [
    { optionId: 'native:remember-first', kind: 'allow_always' },
    { optionId: 'native:remember-second', kind: 'allow_always' },
  ] as const;
  const peer = createSessionPeer({ onPrompt(peer) { sendPermission(peer, 'remembered-only', permissionParams(peer, options)); }, onResolution(peer) { peer.complete(); } });
  const { registry, session, capabilities } = await open(peer, undefined, declared(options));
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  assert.deepEqual(capabilities.requests.approval, { kind: 'supported', modes: [], providerManagedRemembrance: true });
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const request = approvalFrom(await takeUntilRequest(iterator));
  assert.deepEqual(request.options, [
    { optionId: 'acp:option:1', label: 'Allow and remember', decision: 'approved', consequence: remembrance },
    { optionId: 'acp:option:2', label: 'Allow and remember', decision: 'approved', consequence: remembrance },
  ]);
  assert.deepEqual(await execution.resolveRequest({ resolution: {
    requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: request.options[1]!.optionId,
  } }), { status: 'delivered' });
  assert.deepEqual(events(await collectRemaining(iterator)).filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['completed']);
  assert.deepEqual(peer.frames.filter((frame) => frame.id === 'remembered-only' && !frame.method).map((frame) => frame.result), [
    { outcome: { outcome: 'selected', optionId: 'native:remember-second' } },
  ]);
});

for (const [name, permissionMapping, reason] of [
  ['explicit once-only', { mapping: 'once-only-v1' }, 'acp_permission_persistence_unsupported'],
  ['declared precise-only', declared([{ optionId: 'native:once', kind: 'allow_once' }]), 'acp_permission_consequence_unsupported'],
] as const) {
  test(`${name} exposes its precise option and refuses a remembered-only replacement menu`, { timeout: 3_000 }, async (t) => {
    let prompts = 0;
    const peer = createSessionPeer({ onPrompt(peer) {
      prompts += 1;
      sendPermission(peer, `precise:${prompts}`, permissionParams(peer, [
        { optionId: prompts === 1 ? 'native:once' : 'native:remembered', kind: prompts === 1 ? 'allow_once' : 'allow_always' },
      ]));
    }, onResolution(peer) { peer.complete(); } });
    const { registry, session, capabilities } = await open(peer, undefined, permissionMapping);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    assert.deepEqual(capabilities.requests.approval, { kind: 'supported', providerManagedRemembrance: false, modes: [{ persistence: 'once', scopeKinds: ['exact_action'] }] });
    const execution = session.startTurn(turnInput());
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const request = approvalFrom(await takeUntilRequest(iterator));
    assert.deepEqual(request.options.map((option) => [option.optionId, option.consequence]), [['acp:option:1', once]]);
    assert.deepEqual(await execution.resolveRequest({ resolution: {
      requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: request.options[0]!.optionId,
    } }), { status: 'delivered' });
    assert.deepEqual(events(await collectRemaining(iterator)).filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['completed']);
    await assert.rejects(async () => {
      for await (const output of session.startTurn(turnInput('turn:2')).outputs) {
        if (output.kind === 'event' && output.event.type === 'request.opened') assert.fail('An undeclared remembered-only menu became answerable.');
      }
    }, hasReason(reason));
    assert.deepEqual(peer.frames.filter((frame) => frame.id === 'precise:1' && !frame.method).map((frame) => frame.result), [
      { outcome: { outcome: 'selected', optionId: 'native:once' } },
    ]);
  });
}

type PermissionParams = ReturnType<typeof permissionParams>;
const invalidMenus: readonly [string, string, (params: PermissionParams) => object][] = [
  ['missing option', 'acp_permission_consequence_unsupported', (params) => ({ ...params, options: params.options.slice(1) })],
  ['reordered options', 'acp_permission_consequence_unsupported', (params) => ({ ...params, options: params.options.toReversed() })],
  ['changed kind', 'acp_permission_consequence_unsupported', (params) => ({ ...params, options: [{ ...params.options[0], kind: 'reject_always' }, ...params.options.slice(1)] })],
  ['different tool kind', 'acp_permission_consequence_unsupported', (params) => ({ ...params, toolCall: { ...params.toolCall, kind: 'execute' } })],
  ['outer metadata', 'acp_permission_consequence_unsupported', (params) => ({ ...params, _meta: { clearContext: true } })],
  ['option metadata', 'acp_permission_consequence_unsupported', (params) => ({ ...params, options: [{ ...params.options[0], _meta: { modeId: 'unrestricted' } }, ...params.options.slice(1)] })],
  ['coupled mode change', 'acp_permission_consequence_unsupported', (params) => ({ ...params, options: [{ ...params.options[0], modeId: 'unrestricted' }, ...params.options.slice(1)] })],
  ['coupled context clearing', 'acp_permission_consequence_unsupported', (params) => ({ ...params, clearContext: true })],
  ['duplicate native ID', 'acp_permission_option_duplicate', (params) => ({ ...params, options: [{ ...params.options[0], optionId: params.options[1]!.optionId }, ...params.options.slice(1)] })],
  ['empty menu', 'acp_permission_options_invalid', (params) => ({ ...params, options: [] })],
  ['over-limit menu', 'acp_permission_options_invalid', (params) => ({ ...params, options: Array.from({ length: 17 }, (_, index) => ({ optionId: `native:${index}`, name: 'Choice', kind: 'allow_always' })) })],
];
for (const [name, reason, change] of invalidMenus) {
  test(`declared complete mapping rejects ${name} after a matched control on the same peer`, { timeout: 3_000 }, async (t) => {
    let prompts = 0;
    const peer = createSessionPeer({ onPrompt(peer) {
      prompts += 1;
      const params = permissionParams(peer);
      sendPermission(peer, `qualified:${prompts}`, prompts === 1 ? params : change(params));
    }, onResolution(peer) { peer.complete(); } });
    const { registry, session } = await open(peer, undefined, declared());
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const execution = session.startTurn(turnInput());
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const request = approvalFrom(await takeUntilRequest(iterator));
    assert.deepEqual(request.options[0]?.consequence, remembrance);
    assert.deepEqual(await execution.resolveRequest({ resolution: {
      requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: request.options[0]!.optionId,
    } }), { status: 'delivered' });
    assert.deepEqual(events(await collectRemaining(iterator)).filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['completed']);
    const rejected: AgentProviderOutput[] = [];
    await assert.rejects(async () => {
      for await (const output of session.startTurn(turnInput('turn:2')).outputs) {
        rejected.push(output);
        if (output.kind === 'event' && output.event.type === 'request.opened') assert.fail('An unsupported native menu became an answerable approval request.');
      }
    }, hasReason(reason));
    assert.equal(events(rejected).some((event) => event.type === 'request.opened'), false);
    assert.deepEqual(peer.frames.filter((frame) => frame.id === 'qualified:1' && !frame.method).map((frame) => frame.result), [
      { outcome: { outcome: 'selected', optionId: 'native:remember-allow' } },
    ]);
  });
}

const grokMapping = { mapping: 'grok-build-1.0.50-edit-remembrance-v1' } as const;
const grokOptions = [
  { optionId: 'allow-edits-session', kind: 'allow_always' },
  { optionId: 'allow-once', kind: 'allow_once' },
  { optionId: 'reject-once', kind: 'reject_once' },
] as const;
const grokParams = (peer: SessionPeer) => ({ ...permissionParams(peer, grokOptions), toolCall: {
  toolCallId: 'edit:1', title: 'SearchReplace', kind: 'edit', status: 'in_progress', displayHint: 'Additional observed display',
  rawInput: { file_path: '/fixture/example.txt', old_string: 'before', new_string: 'after', variant: 'SearchReplace', replace_all: false },
} });

test('selected Grok maps its exact edit menu with unknown remembrance boundaries and warns before a non-edit once fallback', { timeout: 3_000 }, async (t) => {
  let prompts = 0;
  const peer = createSessionPeer({ initializeResult: { protocolVersion: 1, _meta: { agentVersion: '1.0.50' } }, onPrompt(peer) {
    prompts += 1;
    const params = grokParams(peer);
    sendPermission(peer, `grok:${prompts}`, prompts === 1 ? params : { ...params, toolCall: { ...params.toolCall, kind: 'execute', rawInput: { command: 'true' } } });
  }, onResolution(peer) { peer.complete(); } });
  const { registry, session, capabilities } = await open(peer, undefined, grokMapping);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  assert.deepEqual(capabilities.requests.approval, { kind: 'supported', providerManagedRemembrance: true, modes: [{ persistence: 'once', scopeKinds: ['exact_action'] }] });
  for (const index of [1, 2]) {
    const execution = session.startTurn(turnInput(`turn:${index}`));
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const waiting = await takeUntilRequest(iterator);
    const request = approvalFrom(waiting);
    assert.deepEqual(request.options.map((option) => [option.optionId, option.decision, option.consequence]), index === 1 ? [
      ['acp:option:1', 'approved', remembrance], ['acp:option:2', 'approved', once], ['acp:option:3', 'denied', once],
    ] : [['acp:option:2', 'approved', once], ['acp:option:3', 'denied', once]]);
    assert.deepEqual(events(waiting).filter((event) => event.type === 'runtime.warning').map((event) => event.payload.code), index === 1 ? [] : ['acp_permission_remembrance_unmapped']);
    assert.deepEqual(await execution.resolveRequest({ resolution: {
      requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: request.options[0]!.optionId,
    } }), { status: 'delivered' });
    assert.deepEqual(events(await collectRemaining(iterator)).filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['completed']);
  }
  assert.deepEqual(peer.frames.filter((frame) => !frame.method).map((frame) => ({ id: frame.id, result: frame.result })), [
    { id: 'grok:1', result: { outcome: { outcome: 'selected', optionId: 'allow-edits-session' } } },
    { id: 'grok:2', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
  ]);
});

test('interruption while paused on the Grok fallback warning cancels the original callback without exposing a later request', { timeout: 3_000 }, async (t) => {
  const callback = Promise.withResolvers<void>();
  const peer = createSessionPeer({ initializeResult: { protocolVersion: 1, _meta: { agentVersion: '1.0.50' } }, onPrompt(peer) {
    const params = grokParams(peer);
    sendPermission(peer, 'warning:permission', { ...params, toolCall: { ...params.toolCall, kind: 'execute' } });
  }, onResolution(_peer, frame) {
    assert.deepEqual(frame.result, { outcome: { outcome: 'cancelled' } });
    callback.resolve();
  } });
  const { registry, session } = await open(peer, undefined, grokMapping);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const paused: AgentProviderOutput[] = [];
  for (;;) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    paused.push(next.value!);
    if (next.value?.kind === 'event' && next.value.event.type === 'runtime.warning') {
      assert.equal(next.value.event.payload.code, 'acp_permission_remembrance_unmapped');
      break;
    }
  }
  assert.equal(events(paused).some((event) => event.type === 'request.opened'), false);
  if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
  assert.deepEqual(await session.interruption.interruptTurn({ turnId: turnInput().turnId, reason: 'user_requested' }), { status: 'canceled' });
  await callback.promise;
  const drained = events(await collectRemaining(iterator));
  assert.equal(drained.some((event) => event.type === 'request.opened'), false);
  assert.deepEqual(drained.filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['canceled']);
  assert.deepEqual(peer.frames.filter((frame) => frame.id === 'warning:permission' && !frame.method).map((frame) => frame.result), [
    { outcome: { outcome: 'cancelled' } },
  ]);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/cancel').length, 1);
});

const unsupportedGrok: readonly [string, (params: ReturnType<typeof grokParams>) => object][] = [
  ['unqualified edit variant', (params) => ({ ...params, toolCall: { ...params.toolCall, rawInput: { ...params.toolCall.rawInput, variant: 'Insert' } } })],
  ['unqualified replace-all default', (params) => ({ ...params, toolCall: { ...params.toolCall, rawInput: { ...params.toolCall.rawInput, replace_all: true } } })],
  ['additional edit input effect', (params) => ({ ...params, toolCall: { ...params.toolCall, rawInput: { ...params.toolCall.rawInput, clear_context: true } } })],
  ['unqualified remembered deny', (params) => ({ ...params, options: [...params.options, { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' }] })],
  ['remembered-only terminal menu', (params) => ({ ...params, toolCall: { ...params.toolCall, kind: 'execute' }, options: [params.options[0]] })],
];
for (const [name, change] of unsupportedGrok) {
  test(`selected Grok rejects ${name} after the exact edit control`, { timeout: 3_000 }, async (t) => {
    let prompts = 0;
    const peer = createSessionPeer({ initializeResult: { protocolVersion: 1, _meta: { agentVersion: '1.0.50' } }, onPrompt(peer) {
      prompts += 1;
      const params = grokParams(peer);
      sendPermission(peer, `grok:${prompts}`, prompts === 1 ? params : change(params));
    }, onResolution(peer) { peer.complete(); } });
    const { registry, session } = await open(peer, undefined, grokMapping);
    t.after(async () => { await registry.dispose(); peer.dispose(); });
    const execution = session.startTurn(turnInput());
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const request = approvalFrom(await takeUntilRequest(iterator));
    assert.deepEqual(request.options[0]?.consequence, remembrance);
    assert.deepEqual(await execution.resolveRequest({ resolution: {
      requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: request.options[0]!.optionId,
    } }), { status: 'delivered' });
    assert.deepEqual(events(await collectRemaining(iterator)).filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['completed']);
    await assert.rejects(async () => {
      for await (const output of session.startTurn(turnInput('turn:2')).outputs) {
        if (output.kind === 'event' && output.event.type === 'request.opened') assert.fail('An unqualified Grok menu became answerable.');
      }
    }, hasReason('acp_permission_consequence_unsupported'));
    assert.deepEqual(peer.frames.filter((frame) => frame.id === 'grok:1' && !frame.method).map((frame) => frame.result), [
      { outcome: { outcome: 'selected', optionId: 'allow-edits-session' } },
    ]);
  });
}
