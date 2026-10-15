import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// This controlled peer records wire evidence, but implements no action or remembered-rule store.
const auditPath = process.argv[2];
assert.equal(typeof auditPath, 'string');
const record = (direction, frame) => appendFileSync(auditPath, JSON.stringify({ direction, frame }) + '\n', { mode: 0o600 });
const send = (message) => {
  const frame = { jsonrpc: '2.0', ...message };
  record('peer_to_host', frame);
  process.stdout.write(JSON.stringify(frame) + '\n');
};
let promptId;
let scenario;
let answered = false;
const sessionId = 'remembered-native-session';
const options = [
  { optionId: 'native-allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'native-remember-allow', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'native-deny-once', name: 'Deny once', kind: 'reject_once' },
  { optionId: 'native-remember-deny', name: 'Always deny', kind: 'reject_always' },
];
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  record('host_to_peer', frame);
  switch (frame.method) {
    case 'initialize':
      send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [],
        agentInfo: { name: 'remembered-approvals-example', version: '1.0.0' } } });
      break;
    case 'session/new':
      send({ id: frame.id, result: { sessionId } });
      break;
    case 'session/prompt':
      assert.equal(promptId, undefined, 'A permission answer must retain the original native prompt.');
      promptId = frame.id;
      scenario = frame.params.prompt[0].text;
      assert.ok(['remember-allow', 'remember-deny', 'cancel'].includes(scenario));
      send({ id: `permission:${scenario}`, method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: 'remembered-action', title: 'Synthetic edit', kind: 'edit', status: 'in_progress' }, options,
      } });
      send({ method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Independent work continues while the approval is open.' },
      } } });
      break;
    default:
      assert.equal(frame.method, undefined);
      assert.equal(frame.id, `permission:${scenario}`);
      assert.equal(answered, false, 'The correlated native request may be answered once.');
      assert.deepEqual(frame.result, { outcome: scenario === 'cancel' ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: scenario === 'remember-allow' ? 'native-remember-allow' : 'native-remember-deny' } });
      answered = true;
      send({ method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Original native prompt completed after ${scenario}.` },
      } } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
});
