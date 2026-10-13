// ------------------------------------------------------------------------------------------------
//                acp-peer.mjs - Synthetic ACP agent exercising real session-scoped MCP tools
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

const [reportBase, mode, ...literalArgs] = process.argv.slice(2);
assert.deepEqual(literalArgs, ['$HOME', 'literal;$(never-execute)']);
assert.ok(['permission', 'cancel', 'malformed'].includes(mode));
const reportPath = `${reportBase}.${process.pid}.json`;
const nativeSessionId = `synthetic-${process.pid}`;
const report = { pid: process.pid, mode, cwd: process.cwd(), methods: [], toolNames: [], toolCalls: [],
  serverCount: 0, promptCount: 0, selectedModel: 'unselected', exited: false,
  vendorRequests: 0, vendorMethodNotFoundReplies: 0 };
let servers = [];
let requestId = 0;
let initialized = false;
let busy = false;
let pendingVendorRequest;

function persist() {
  writeFileSync(reportPath + '.tmp', JSON.stringify(report));
  renameSync(reportPath + '.tmp', reportPath);
}
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
async function optionalVendorRequest() {
  assert.equal(pendingVendorRequest, undefined);
  assert.equal(report.vendorRequests, 0);
  report.vendorRequests += 1;
  report.vendorRequestId = `synthetic-vendor-${process.pid}`;
  persist();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The bounded vendor request did not receive its correlated response.')), 5_000);
    pendingVendorRequest = { id: report.vendorRequestId, resolve() { clearTimeout(timeout); resolve(); } };
    send({ id: report.vendorRequestId, method: '_fixture/optional_request', params: { sessionId: nativeSessionId, observation: true } });
  });
}
function vendorResponse(frame) {
  assert.ok(pendingVendorRequest, 'Only the one outstanding vendor request may receive a response.');
  assert.deepEqual(frame, { jsonrpc: '2.0', id: pendingVendorRequest.id,
    error: { code: -32601, message: 'Method not found' } });
  report.vendorReplyId = frame.id;
  report.vendorMethodNotFoundReplies += 1;
  const pending = pendingVendorRequest;
  pendingVendorRequest = undefined;
  persist();
  pending.resolve();
}
function modelOptions() {
  return [{ id: 'fixture:model', name: 'Model', type: 'select', currentValue: report.selectedModel,
    options: [{ value: 'unselected', name: 'Unselected fixture model' },
      { value: 'certified', name: 'Certified fixture model' }] }];
}
function text(value) {
  for (let offset = 0; offset < value.length; offset += 3_000) {
    send({ method: 'session/update', params: { sessionId: nativeSessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.slice(offset, offset + 3_000) } } } });
  }
}
async function mcp(method, params, notification = false) {
  assert.equal(servers.length, 1);
  const server = servers[0];
  assert.equal(server.type, 'http');
  const response = await fetch(server.url, { method: 'POST',
    headers: { ...Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, params }),
    signal: AbortSignal.timeout(10_000) });
  if (notification) { assert.equal(response.status, 202); return; }
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(Object.hasOwn(envelope, 'error'), false);
  assert.ok(envelope.result);
  return envelope.result;
}
async function discover() {
  if (initialized) return;
  const setup = await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'synthetic-acp-qualification-peer', version: '1.0.0' } });
  assert.equal(setup.protocolVersion, '2025-11-25');
  assert.match(setup.instructions, /host|policy/u);
  await mcp('notifications/initialized', {}, true);
  const listed = await mcp('tools/list', {});
  report.toolNames = listed.tools.map(({ name }) => name);
  assert.deepEqual(report.toolNames, ['delegation_targets', 'delegate_task', 'task_status', 'task_send', 'task_cancel']);
  initialized = true;
  persist();
}
async function callTool(name, args) {
  assert.ok(report.toolCalls.length < 16);
  report.toolCalls.push(name);
  persist();
  const response = await mcp('tools/call', { name, arguments: args });
  assert.ok(response.structuredContent);
  return response.structuredContent;
}
function success(result) { assert.equal(result.kind, 'success'); return result.value; }

async function prompt(frame) {
  report.promptCount += 1;
  assert.ok(report.promptCount <= 4);
  assert.equal(frame.params.sessionId, nativeSessionId);
  const content = frame.params.prompt.map((part) => { assert.equal(part.type, 'text'); return part.text; }).join('');
  if (servers.length === 0) {
    assert.equal(report.selectedModel, 'certified', 'The certified model must be selected before any child prompt.');
    text(`Certified child output: ${content}`);
  } else {
    const command = JSON.parse(content);
    if (mode === 'malformed') {
      // This peer accepts valid MCP configuration but never discovers or calls its tools.
      text(JSON.stringify({ transportAccepted: true, toolsExposed: false }));
    } else {
      await discover();
      if (command.action === 'delegate') {
        const targets = success(await callTool('delegation_targets', {}));
        assert.equal(targets.targets.length, 1);
        const admission = success(await callTool('delegate_task', { operationId: command.operationId,
          target: targets.targets[0].reference, expectedPolicyRevision: targets.policyRevision,
          prompt: `Managed child result for ${command.label}`, completionPolicy: 'automatic' }));
        const status = success(await callTool('task_status', { taskId: admission.taskId, waitMs: 5_000 }));
        assert.equal(status.waitStatus, 'settled');
        assert.equal(status.runs.items[0].outcome.kind, 'succeeded');
        text(JSON.stringify({ admission, status, toolNames: report.toolNames }));
      } else {
        assert.equal(command.action, 'foreign');
        const targets = success(await callTool('delegation_targets', {}));
        const results = [];
        for (const [name, args] of [
          ['task_status', { taskId: command.taskId }],
          ['task_send', { taskId: command.taskId, operationId: randomUUID(), mode: 'follow_up',
            target: targets.targets[0].reference, expectedPolicyRevision: targets.policyRevision, message: 'Foreign task input.' }],
          ['task_cancel', { taskId: command.taskId, operationId: randomUUID() }],
        ]) {
          const denied = await callTool(name, args);
          assert.equal(denied.kind, 'error');
          assert.ok(['policy_denied', 'request_unavailable'].includes(denied.error.code));
          results.push({ tool: name, code: denied.error.code });
        }
        text(JSON.stringify({ foreignDenied: results }));
      }
    }
  }
  send({ id: frame.id, result: { stopReason: 'end_turn' } });
}

async function handle(frame) {
  assert.equal(typeof frame.method, 'string');
  report.methods.push(frame.method);
  assert.ok(report.methods.length <= 16);
  switch (frame.method) {
    case 'initialize':
      assert.equal(frame.params.protocolVersion, 1);
      send({ id: frame.id, result: { protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: mode === 'cancel' ? {} : { http: true } }, authMethods: [],
        agentInfo: { name: 'synthetic-managed-acp-peer', version: '1.0.0' } } });
      break;
    case 'session/new':
      assert.ok(isAbsolute(frame.params.cwd));
      report.workingDirectory = frame.params.cwd;
      servers = frame.params.mcpServers;
      report.serverCount = servers.length;
      send({ method: '_fixture/optional_observation', params: { sessionId: nativeSessionId } });
      await optionalVendorRequest();
      send({ id: frame.id, result: { sessionId: nativeSessionId, configOptions: modelOptions() } });
      break;
    case 'session/set_config_option':
      assert.equal(frame.params.sessionId, nativeSessionId);
      assert.equal(frame.params.configId, 'fixture:model');
      assert.equal(frame.params.value, 'certified');
      assert.equal(report.promptCount, 0);
      report.selectedModel = 'certified';
      send({ id: frame.id, result: { configOptions: modelOptions() } });
      break;
    case 'session/prompt':
      assert.equal(busy, false);
      busy = true;
      try { await prompt(frame); } finally { busy = false; }
      break;
    default: throw new Error('Unexpected synthetic ACP request.');
  }
  persist();
}

persist();
createInterface({ input: process.stdin }).on('line', (line) => {
  assert.ok(Buffer.byteLength(line) <= 32_768);
  void Promise.resolve().then(() => {
    const frame = JSON.parse(line);
    return Object.hasOwn(frame, 'method') ? handle(frame) : vendorResponse(frame);
  }).catch(() => {
    report.failed = true;
    persist();
    process.stderr.write('Synthetic managed ACP fixture contract failed.\n');
    process.exit(1);
  });
});
process.on('SIGTERM', () => process.exit(0));
process.on('exit', () => { report.exited = true; persist(); });
