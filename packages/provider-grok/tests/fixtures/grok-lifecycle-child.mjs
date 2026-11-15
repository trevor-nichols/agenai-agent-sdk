import { writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';

const [nativeSessionId, policy, ownerName, holdInitialize, holdOpening, permission, credentialReceipt] = process.argv.slice(2);
let input = Buffer.alloc(0);
let prepared = false;
let partial = '';
const held = new Map();
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const observe = (type, frame) => process.send?.({ type, frame });
const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'grok-4.6',
  options: [{ value: 'grok-4.6', name: 'Grok 4.6' }] }];
const reply = async (frame) => {
  if (frame.method === 'initialize') send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {},
    _meta: { agentVersion: '1.0.77', grokShell: true, currentWorkingDirectory: '/workspace/work', modelState: { currentModelId: 'grok-4.6' } } } });
  if (frame.method === 'session/new') send({ id: frame.id, result: { sessionId: nativeSessionId, models: { currentModelId: 'grok-4.6' }, configOptions,
    _meta: { currentWorkingDirectory: '/workspace/work', 'x.ai/sessionDetail': { sessionId: nativeSessionId, cwd: '/workspace/work', currentModelId: 'grok-4.6' } } } });
  if (frame.method === 'session/prompt') {
    await writeFile('result.txt', `result:${ownerName}:${policy}\n`);
    if (permission === 'true') {
      held.set('prompt', frame);
      send({ id: 'fixture-permission', method: 'session/request_permission', params: { sessionId: nativeSessionId,
        _meta: { kind: 'grok_config', description: 'Fixture mandatory request' },
        toolCall: { toolCallId: 'fixture-tool', kind: 'execute', title: 'Fixture action', rawInput: { command: 'printf fixture' }, _meta: { 'x.ai/tool': { version: 1, name: 'run_terminal_command', kind: 'execute', namespace: 'grok_build' } } },
        options: [{ optionId: 'once', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }] } });
    } else send({ id: frame.id, result: { stopReason: 'end_turn', _meta: { sessionId: nativeSessionId, promptId: `fixture-prompt-${frame.id}`,
      totalTokens: 1662, usage: { inputTokens: 1629, cachedReadTokens: 512, cacheCreationTokens: 0, outputTokens: 26, reasoningTokens: 25,
        totalTokens: 1655, modelCalls: 1, numTurns: 1 } } } });
  }
  if (frame.method) observe(`replied:${frame.method}`);
  if (frame.id === 'fixture-permission') {
    const prompt = held.get('prompt');
    if (prompt) { held.delete('prompt'); send({ id: prompt.id, result: { stopReason: 'end_turn' } }); }
  }
};
const receive = (frame) => {
  observe(frame.method ?? 'response', frame);
  if (frame.method === 'initialize' && holdInitialize === 'true' || frame.method === 'session/new' && holdOpening === 'true') {
    held.set(frame.method, frame); return;
  }
  void reply(frame).catch(() => process.exit(73));
};
process.on('message', (message) => {
  if (message && typeof message === 'object' && typeof message.release === 'string') {
    const frame = held.get(message.release);
    if (frame) { held.delete(message.release); void reply(frame).catch(() => process.exit(74)); }
  }
});
process.stdin.on('data', (chunk) => {
  if (!prepared) {
    input = Buffer.concat([input, chunk]);
    if (input.length < 12) return;
    if (input.toString('ascii', 0, 4) !== 'AGC1') process.exit(64);
    const length = 12 + input.readUInt16BE(4) + input.readUInt32BE(8);
    if (input.length < length) return;
    if (credentialReceipt) writeFileSync(credentialReceipt, input.subarray(12 + input.readUInt16BE(4), length), { flag: 'wx', mode: 0o600 });
    partial = input.subarray(length).toString('utf8'); input.fill(0); input = Buffer.alloc(0);
    prepared = true; process.stdout.write('AGC1 PREPARED\n'); observe('prepared');
  } else partial += chunk.toString('utf8');
  let end;
  while ((end = partial.indexOf('\n')) >= 0) {
    const frame = JSON.parse(partial.slice(0, end)); partial = partial.slice(end + 1); receive(frame);
  }
});
process.stdin.on('end', () => observe('stdin-ended'));
process.stdout.on('error', () => {});
process.stdout.write('AGC1 HELLO\n');
