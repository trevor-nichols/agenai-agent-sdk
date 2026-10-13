// ------------------------------------------------------------------------------------------------
//                peer.mjs - Bounded synthetic ACP process - Dependencies: Node built-ins
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const [reportPath, mode, ...args] = process.argv.slice(2);
const report = {
  pid: process.pid, mode, args, env: { ...process.env }, cwd: process.cwd(),
  methods: [], permissionResponses: [], emitted: 0, promptReady: false, exited: false,
};
let promptId;
const persist = () => {
  writeFileSync(reportPath + '.tmp', JSON.stringify(report));
  renameSync(reportPath + '.tmp', reportPath);
};
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (value) => {
  report.emitted += 1;
  send({ method: 'session/update', params: { sessionId: 'retained-native', update: value } });
};
const text = (value) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const permission = (id) => send({ id, method: 'session/request_permission', params: {
  sessionId: 'retained-native', toolCall: { toolCallId: id, title: 'Read fixture', status: 'in_progress' },
  options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny once', kind: 'reject_once' }],
} });
const complete = (stopReason) => send({ id: promptId, result: { stopReason } });
persist();
createInterface({ input: process.stdin }).on('line', (line) => {
  assert.ok(Buffer.byteLength(line) <= 16_384);
  const frame = JSON.parse(line);
  if (frame.method) {
    report.methods.push(frame.method);
    assert.ok(report.methods.length <= 8);
    switch (frame.method) {
      case 'initialize':
        assert.equal(frame.params.protocolVersion, 1);
        send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [],
          agentInfo: { name: 'retained-packed-fixture', version: '1.2.3' } } });
        break;
      case 'session/new':
        assert.equal(resolve(frame.params.cwd), report.cwd);
        send({ id: frame.id, result: { sessionId: 'retained-native' } });
        break;
      case 'session/prompt':
        assert.equal(promptId, undefined);
        assert.equal(frame.params.sessionId, 'retained-native');
        assert.deepEqual(frame.params.prompt, [{ type: 'text', text: 'Exercise retained offline ACP' }]);
        promptId = frame.id;
        if (mode === 'malformed') process.stdout.write('{deliberately-malformed\n');
        else if (mode === 'overflow') {
          for (let index = 0; index < 32; index++) text('bounded burst ' + index);
        } else if (mode === 'cancel') {
          text('Queued before cancellation');
          permission('unseen-1');
          permission('unseen-2');
        } else {
          assert.equal(mode, 'permission');
          update({ sessionUpdate: 'tool_call', toolCallId: 'permission-1', title: 'Read fixture', status: 'in_progress' });
          permission('permission-1');
        }
        report.promptReady = true;
        break;
      case 'session/cancel':
        assert.equal(mode, 'cancel');
        assert.equal(frame.params.sessionId, 'retained-native');
        complete('cancelled');
        break;
      default: throw new Error('Unexpected fixture method: ' + frame.method);
    }
  } else {
    assert.ok(promptId !== undefined);
    report.permissionResponses.push({ id: frame.id, result: frame.result });
    assert.ok(report.permissionResponses.length <= 2);
    if (mode === 'permission') {
      assert.equal(frame.id, 'permission-1');
      assert.deepEqual(frame.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'permission-1', status: 'completed' });
      text('Retained offline result');
      complete('end_turn');
    } else {
      assert.equal(mode, 'cancel');
      assert.deepEqual(frame.result, { outcome: { outcome: 'cancelled' } });
    }
  }
  persist();
});
process.on('SIGTERM', () => process.exit(0));
process.on('exit', () => { report.exited = true; persist(); });
