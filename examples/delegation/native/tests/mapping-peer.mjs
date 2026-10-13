import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [receiptPath, behavior] = process.argv.slice(2);
const receipt = (phase) => writeFileSync(receiptPath, JSON.stringify({ pid: process.pid, phase }), { mode: 0o600 });
receipt('started');
const sessionId = 'mapping-cleanup-fixture';
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const configOptions = [
  { id: 'model', name: 'Model', type: 'select', currentValue: 'grok-4.3', options: [{ value: 'grok-4.3', name: 'grok-4.3' }] },
  { id: 'reasoning', name: 'Reasoning Effort', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
];

async function handle(frame) {
  if (frame.method === 'initialize') {
    send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (frame.method === 'session/new') {
    if (behavior === 'rejected-opening') {
      receipt('opening_rejected');
      send({ id: frame.id, error: { code: -32602, message: 'Synthetic session opening rejected.' } });
      return;
    }
    const response = await fetch(`${process.env.GROK_XAI_API_BASE_URL}/models`);
    assert.equal(response.status, 200);
    await response.json();
    send({ id: frame.id, result: { sessionId, configOptions } });
  } else if (frame.method === 'session/set_config_option') {
    send({ id: frame.id, result: { configOptions } });
  } else if (frame.method === 'session/prompt') {
    const response = await fetch(`${process.env.GROK_XAI_API_BASE_URL}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'grok-4.3', reasoning_effort: 'low', messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('NATIVE_LOOPBACK_MAPPING_OK'));
    receipt('turn_completed');
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'NATIVE_LOOPBACK_MAPPING_OK' } } } });
    send({ id: frame.id, result: { stopReason: 'end_turn' } });
  } else assert.fail('Unexpected synthetic ACP method.');
}

setInterval(() => {}, 1_000);
process.once('SIGTERM', () => process.exit(0));
createInterface({ input: process.stdin }).on('line', (line) => {
  void handle(JSON.parse(line)).catch(() => process.exit(1));
});
