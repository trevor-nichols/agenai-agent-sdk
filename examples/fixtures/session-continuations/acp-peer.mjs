import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// A deterministic, descendant-free stdio peer. This is not the Grok executable or native qualification.
assert.deepEqual(process.argv.slice(2), ['agent', '--no-leader', 'stdio']);
const auditPath = process.env.SESSION_CONTINUATIONS_AUDIT;
assert.equal(typeof auditPath, 'string');
const record = (entry) => appendFileSync(auditPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
const send = (frame) => {
  record({ kind: 'peer_to_host', frame });
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
};
const sessionId = 'controlled-session-continuations';
const promptId = 'plan-resume-controlled-example';
let answered = false;
record({ kind: 'started', pid: process.pid });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  record({ kind: 'host_to_peer', frame });
  if (frame.method === 'initialize') {
    send({ id: frame.id, result: { protocolVersion: 1, authMethods: [],
      agentInfo: { name: 'session-continuations-controlled-peer', version: '1.0.0' },
      _meta: { agentVersion: '1.0.60' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
    } });
  } else if (frame.method === 'session/load') {
    assert.equal(frame.params.sessionId, sessionId);
    send({ method: '_x.ai/queue/changed', params: { sessionId,
      entries: [{ id: 'controlled-historical-prompt' }], _meta: { isReplay: true } } });
    send({ id: frame.id, result: {} });
    setImmediate(() => send({ id: 'controlled-review', method: '_x.ai/exit_plan_mode', params: {
      sessionId, toolCallId: 'controlled-exit-plan-mode', planContent: '# Restored plan\n\nPerform the reviewed task.\n',
    } }));
  } else if (frame.method === 'session/close') {
    send({ id: frame.id, result: {} });
  } else {
    assert.equal(frame.method, undefined, 'A review response must not send a caller prompt.');
    assert.equal(frame.id, 'controlled-review');
    assert.equal(answered, false, 'Answer the correlated native request once.');
    assert.deepEqual(frame.result, { outcome: 'approved' });
    answered = true;
    send({ method: '_x.ai/queue/changed', params: { sessionId,
      entries: [], runningKind: 'prompt', runningPromptId: promptId } });
    send({ method: 'session/update', params: { sessionId, _meta: { promptId }, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Controlled continuation output.' },
    } } });
    send({ method: '_x.ai/session_notification', params: { sessionId, update: {
      sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn',
    } } });
  }
}
