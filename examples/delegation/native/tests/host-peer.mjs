import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [auditPath, role, behavior] = process.argv.slice(2);
assert.ok(auditPath && role && behavior);
const sessionId = `host-fixture-${process.pid}`;
const audit = (event, detail = {}) => appendFileSync(auditPath, JSON.stringify({ pid: process.pid, role, event, ...detail }) + '\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let model = 'unselected';
let reasoning = 'low';
let pendingPrompt;
let pendingPermission = false;
let terminating = false;
let servers = [];
let promptCount = 0;
let mcpId = 0;
let mcpInitialized = false;
let currentTool = 'delegation_targets';
let nativeToolId = '';
let admissionCommand;
let targetsPage;
const managed = behavior.startsWith('managed-');

function requestPermission(repeated = false) {
  pendingPermission = true;
  nativeToolId = `${promptCount}-${currentTool}${repeated ? '-repeat' : ''}`;
  audit('permission_requested');
  send({ id: repeated ? 'fixture-permission-repeat' : 'fixture-permission', method: 'session/request_permission', params: { sessionId,
    toolCall: { toolCallId: nativeToolId,
      title: managed ? `agenai_delegation__${behavior === 'managed-delegate-first' ? 'delegate_task' : currentTool}` : 'Synthetic native action',
      status: 'in_progress', ...(behavior === 'managed-conflicting-name' ? { name: 'conflicting_tool' } : {}) },
    options: [{ optionId: 'allow-once', name: 'allow once', kind: 'allow_once' },
      ...(behavior === 'managed-ambiguous' ? [{ optionId: 'other-allow', name: 'allow once', kind: 'allow_once' }] : []),
      { optionId: 'deny', name: 'reject once', kind: 'reject_once' }] } });
}

async function invokeTool(name, args) {
  assert.equal(servers.length, 1);
  const server = servers[0];
  assert.equal(server.type, 'http');
  assert.equal(new URL(server.url).hostname, '127.0.0.1');
  const call = async (method, params, notification = false) => {
    const response = await fetch(server.url, { method: 'POST', headers: {
      ...Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++mcpId }), method, params }), signal: AbortSignal.timeout(3_000) });
    assert.equal(response.status, notification ? 202 : 200);
    if (notification) return;
    const envelope = await response.json();
    assert.equal(Object.hasOwn(envelope, 'error'), false);
    return envelope.result;
  };
  if (!mcpInitialized) {
    await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'native-host-lifecycle', version: '1.0.0' } });
    await call('notifications/initialized', {}, true);
    mcpInitialized = true;
  }
  const result = await call('tools/call', { name, arguments: args });
  assert.equal(result.structuredContent.kind, 'success');
  audit('mcp_callback');
  return result.structuredContent.value;
}

function ready() {
  text('{"ready":true}');
}

function text(value) {
  send({ method: 'session/update', params: { sessionId, update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value },
  } } });
}

function jsonAfter(input, marker) {
  const offset = input.indexOf(marker);
  assert.ok(offset >= 0);
  const match = /^"(?:[^"\\]|\\.)*"/u.exec(input.slice(offset + marker.length));
  assert.ok(match);
  return JSON.parse(match[0]);
}

function fullPrompt(frame) {
  assert.equal(model, 'grok-4.3'); assert.equal(reasoning, 'low');
  const input = frame.params.prompt.map((part) => { assert.equal(part.type, 'text'); return part.text; }).join('');
  pendingPrompt = frame.id;
  if (role === 'child') {
    if (input.includes('binary search tree')) return;
    assert.ok(input.includes('exactly 12 uppercase ASCII letters'));
    text(JSON.stringify({ token: [...randomBytes(12)].map((value) => String.fromCharCode(65 + value % 26)).join('') }));
  } else if (input.startsWith('Use the managed MCP tools')) {
    admissionCommand = { operationId: jsonAfter(input, 'operationId '), completionPolicy: jsonAfter(input, 'completionPolicy '),
      prompt: jsonAfter(input, 'this exact prompt string: '), timeoutMs: Number(/timeoutMs (\d+)/u.exec(input)?.[1]) };
    assert.equal(admissionCommand.timeoutMs, 180_000);
    currentTool = 'delegation_targets'; requestPermission(); return;
  } else if (input.startsWith('The host accepted this volatile completion envelope')) {
    const prefix = 'The host accepted this volatile completion envelope after your admission turn ended: ';
    const envelope = JSON.parse(input.slice(prefix.length, input.indexOf('. Do not call tools.')));
    assert.equal(envelope.outcome.kind, 'succeeded');
    const result = JSON.parse(envelope.outcome.result.text);
    assert.match(result.token, /^[A-Z]{12}$/u);
    text(JSON.stringify({ token: result.token }));
  } else { assert.ok(input.includes('{"ready":true}')); ready(); }
  send({ id: frame.id, result: { stopReason: 'end_turn' } }); pendingPrompt = undefined;
}

function configOptions() {
  return [{ id: 'model', name: 'Model', type: 'select', currentValue: model,
    options: [{ value: 'unselected', name: 'Unselected' }, { value: 'grok-4.3', name: 'grok-4.3' }] },
  ...(model === 'unselected' ? [] : [{ id: 'reasoning', name: 'Reasoning Effort', type: 'select', currentValue: reasoning,
    options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] }])];
}

async function handle(frame) {
  switch (frame.method) {
    case 'initialize':
      audit('initialize');
      send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } },
        authMethods: [], agentInfo: { name: 'native-host-lifecycle-fixture', version: '1.0.0' } } });
      return;
    case 'session/new':
      servers = frame.params.mcpServers;
      audit('session_new', { mcpServers: frame.params.mcpServers.length });
      if (behavior === 'auth-required') {
        audit('authentication_required');
        send({ id: frame.id, error: { code: -32000, message: 'Synthetic authentication diagnostic must remain private.' } });
        return;
      }
      send({ id: frame.id, result: { sessionId, configOptions: configOptions() } });
      return;
    case 'session/set_config_option': {
      const { configId, value } = frame.params;
      audit('configuration', { configId, value });
      if (behavior === 'reject-model' && configId === 'model') {
        audit('configuration_rejected');
        send({ id: frame.id, error: { code: -32602, message: 'The synthetic model selection was rejected.' } });
        return;
      }
      if (configId === 'model') { assert.equal(value, 'grok-4.3'); model = value; }
      else {
        assert.equal(configId, 'reasoning'); assert.equal(value, 'low');
        reasoning = behavior === 'drift-reasoning' ? 'medium' : value;
        if (behavior === 'drift-reasoning') audit('configuration_drift', { value: reasoning });
      }
      send({ id: frame.id, result: { configOptions: configOptions() } });
      return;
    }
    case 'session/prompt':
      audit('prompt');
      assert.ok(behavior === 'permission' || managed);
      if (behavior === 'managed-full') { ++promptCount; fullPrompt(frame); return; }
      assert.equal(role, 'parent');
      if (++promptCount === 1 && managed && behavior !== 'managed-ordinary') {
        ready(); send({ id: frame.id, result: { stopReason: 'end_turn' } }); return;
      }
      if (behavior.startsWith('managed-text-')) {
        if (behavior === 'managed-text-only') { text('{"admit'); text('ted":true}'); }
        else if (behavior === 'managed-text-capped') text('PRIVATE_SYNTHETIC_ADMISSION_DIAGNOSTIC_' + 'x'.repeat(10_000));
        else assert.equal(behavior, 'managed-text-none');
        send({ id: frame.id, result: { stopReason: 'end_turn' } }); return;
      }
      pendingPrompt = frame.id;
      requestPermission();
      return;
    case 'session/cancel':
      audit('cancel');
      if (pendingPrompt !== undefined) send({ id: pendingPrompt, result: { stopReason: 'cancelled' } });
      return;
    default:
      assert.equal(frame.method, undefined);
      assert.match(frame.id, /^fixture-permission(?:-repeat)?$/u);
      audit('permission_reply', { outcome: frame.result?.outcome?.outcome, optionId: frame.result?.outcome?.optionId ?? null });
      pendingPermission = false;
      if (managed && frame.result?.outcome?.outcome === 'selected') {
        assert.equal(frame.result.outcome.optionId, 'allow-once');
        if (behavior === 'managed-full' && currentTool === 'delegate_task') {
          assert.ok(targetsPage && admissionCommand);
          await invokeTool('delegate_task', { ...admissionCommand, target: targetsPage.targets[0].reference, expectedPolicyRevision: targetsPage.policyRevision });
        } else targetsPage = await invokeTool('delegation_targets', {});
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update',
          toolCallId: nativeToolId, status: 'completed' } } });
        if (behavior === 'managed-full' && currentTool === 'delegation_targets') { currentTool = 'delegate_task'; requestPermission(); return; }
        if (behavior === 'managed-repeat') { requestPermission(true); return; }
        if (behavior === 'managed-full') { text('{"admit'); text('ted":true}'); }
        send({ id: pendingPrompt, result: { stopReason: 'end_turn' } });
        pendingPrompt = undefined;
        return;
      }
      if (pendingPrompt !== undefined) send({ id: pendingPrompt, result: { stopReason: 'cancelled' } });
      if (terminating) process.exit(0);
  }
}

audit('started');
process.once('exit', () => audit('exited'));
process.once('SIGTERM', () => {
  terminating = true;
  if (!pendingPermission) process.exit(0);
  // Allow an already-written canceled permission reply to drain before this process exits.
  setTimeout(() => process.exit(0), 100);
});
createInterface({ input: process.stdin }).on('line', async (line) => {
  try { assert.ok(Buffer.byteLength(line) <= 1_048_576); await handle(JSON.parse(line)); }
  catch { audit('fixture_failed'); process.exit(1); }
});
