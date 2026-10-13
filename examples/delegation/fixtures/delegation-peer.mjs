// ------------------------------------------------------------------------------------------------
//                delegation-peer.mjs - Credentialless ACP agent with real scoped MCP invocation
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';

const sessionId = `example-native-${process.pid}`;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const values = { model: 'unselected', speed: 'fast', reasoning: 'low' };
const choices = {
  model: [['unselected', 'Unselected'], ['example-model', 'Example model']],
  speed: [['standard', 'Standard'], ['fast', 'Fast']],
  reasoning: [['low', 'Low'], ['max', 'Max']],
};
const configOptions = () => Object.entries(choices).map(([key, options]) => ({ id: key,
  name: key[0].toUpperCase() + key.slice(1), type: 'select', currentValue: values[key],
  options: options.map(([value, name]) => ({ value, name })) }));
let servers = [];
let requestId = 0;
let initialized = false;
let pendingPrompt;
let busy = false;

function text(value) {
  send({ method: 'session/update', params: { sessionId, update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value },
  } } });
}

async function mcp(method, params, notification = false) {
  assert.equal(servers.length, 1);
  const server = servers[0];
  assert.equal(server.type, 'http');
  const endpoint = new URL(server.url);
  assert.equal(endpoint.hostname, '127.0.0.1');
  const response = await fetch(endpoint, { method: 'POST', headers: {
    ...Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
  }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, params }),
  signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, notification ? 202 : 200);
  if (notification) return;
  const envelope = await response.json();
  assert.equal(Object.hasOwn(envelope, 'error'), false);
  return envelope.result;
}

async function tools() {
  if (initialized) return;
  const setup = await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'public-delegation-example', version: '1.0.0' } });
  assert.match(setup.instructions, /host|policy/u);
  await mcp('notifications/initialized', {}, true);
  const listed = await mcp('tools/list', {});
  assert.ok(listed.tools.some((tool) => tool.name === 'delegate_task'));
  initialized = true;
}

async function callTool(name, args) {
  const result = await mcp('tools/call', { name, arguments: args });
  assert.equal(result.structuredContent.kind, 'success');
  return result.structuredContent.value;
}

async function prompt(frame) {
  assert.equal(busy, false);
  busy = true;
  assert.equal(frame.params.sessionId, sessionId);
  const input = frame.params.prompt.map((part) => { assert.equal(part.type, 'text'); return part.text; }).join('');
  if (servers.length > 0) {
    const command = JSON.parse(input);
    if (command.action === 'delegate') {
      await tools();
      const page = await callTool('delegation_targets', {});
      assert.equal(page.targets.length, 1);
      const admission = await callTool('delegate_task', { operationId: command.operationId,
        target: page.targets[0].reference, expectedPolicyRevision: page.policyRevision,
        prompt: 'Ask the trusted host to approve this synthetic child action.', completionPolicy: 'automatic' });
      await callTool('task_status', { taskId: admission.taskId });
      text(JSON.stringify({ admission, toolsInvoked: ['delegation_targets', 'delegate_task', 'task_status'] }));
    } else {
      assert.equal(command.action, 'completion');
      assert.equal(command.envelope.outcome.kind, 'succeeded');
      text(JSON.stringify({ completionReceived: true, taskId: command.envelope.taskId }));
    }
    send({ id: frame.id, result: { stopReason: 'end_turn' } });
    busy = false;
  } else {
    assert.deepEqual(values, { model: 'example-model', speed: 'standard', reasoning: 'max' },
      'The child must apply real Standard/Max configuration before its first native prompt.');
    pendingPrompt = frame.id;
    text('Standard child is waiting for a host decision.');
    send({ id: 'child-approval', method: 'session/request_permission', params: { sessionId,
      toolCall: { toolCallId: 'example-child-action', title: 'Approve the synthetic child action', status: 'in_progress' },
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny once', kind: 'reject_once' }],
    } });
  }
}

async function handle(frame) {
  switch (frame.method) {
    case 'initialize':
      send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } },
        authMethods: [], agentInfo: { name: 'public-delegation-peer', version: '1.0.0' } } });
      break;
    case 'session/new':
      servers = frame.params.mcpServers;
      send({ id: frame.id, result: { sessionId, configOptions: configOptions() } });
      break;
    case 'session/set_config_option': {
      assert.equal(busy, false);
      const { configId, value } = frame.params;
      assert.ok(choices[configId]?.some(([candidate]) => candidate === value));
      values[configId] = value;
      send({ id: frame.id, result: { configOptions: configOptions() } });
      break;
    }
    case 'session/prompt': await prompt(frame); break;
    case 'session/cancel':
      if (pendingPrompt !== undefined) {
        send({ id: pendingPrompt, result: { stopReason: 'cancelled' } });
        pendingPrompt = undefined;
        busy = false;
      }
      break;
    default:
      assert.equal(frame.method, undefined);
      assert.equal(frame.id, 'child-approval');
      assert.notEqual(pendingPrompt, undefined);
      assert.deepEqual(frame.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
      text('The child completed after its parent had already ended the earlier turn.');
      send({ id: pendingPrompt, result: { stopReason: 'end_turn' } });
      pendingPrompt = undefined;
      busy = false;
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  assert.ok(Buffer.byteLength(line) <= 32_768);
  void handle(JSON.parse(line)).catch(() => {
    process.stderr.write('The credentialless delegation peer rejected its bounded contract.\n');
    process.exit(1);
  });
});
