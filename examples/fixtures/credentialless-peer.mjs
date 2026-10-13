import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';

assert.deepEqual(process.argv.slice(2), ['$HOME', 'literal;$(never-execute)']);
assert.deepEqual({ ...process.env }, { EXAMPLE_MARKER: 'explicit-launch-environment' });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let promptId;
let resolved = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  switch (frame.method) {
    case 'initialize':
      send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [],
        agentInfo: { name: 'credentialless-example', version: '1.0.0' } } });
      break;
    case 'session/new':
      send({ id: frame.id, result: { sessionId: 'example-native-session' } });
      break;
    case 'session/prompt':
      assert.equal(promptId, undefined, 'A continuation must retain the original prompt.');
      promptId = frame.id;
      send({ id: 'permission', method: 'session/request_permission', params: {
        sessionId: 'example-native-session', toolCall: { toolCallId: 'example-action', title: 'Approve this synthetic action', status: 'in_progress' },
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny once', kind: 'reject_once' }],
      } });
      break;
    default:
      assert.equal(frame.method, undefined);
      assert.equal(frame.id, 'permission');
      assert.equal(resolved, false, 'The permission may be resolved only once.');
      assert.deepEqual(frame.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
      resolved = true;
      send({ method: 'session/update', params: { sessionId: 'example-native-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Completed the original native prompt.' },
      } } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
});
