import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.PACKED_INTERACTION_MODE;
if (mode !== 'answer' && mode !== 'pending') throw new Error('Unknown packed controlled peer scenario.');
const record = (entry) => appendFileSync(process.env.PACKED_INTERACTION_LOG, JSON.stringify(entry) + '\n');
const send = (frame) => { record({ direction: 'outbound', frame }); process.stdout.write(JSON.stringify(frame) + '\n'); };
const question = () => send({ jsonrpc: '2.0', id: 'packed-native-question', method: '_x.ai/folder_trust/request', params: {
  sessionId: 'packed-native-session', cwd: process.cwd(), workspace: `${process.cwd()}/configuration`, configKinds: ['mcp'],
} });
record({ pid: process.pid, args: process.argv.slice(2) });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  record({ direction: 'inbound', frame });
  if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, authMethods: [],
    agentInfo: { name: 'packed-controlled-peer', version: '1' }, agentCapabilities: {},
  } });
  else if (frame.method === 'session/new') {
    if (mode === 'answer') question();
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'packed-native-session' } });
    if (mode === 'pending') setImmediate(question);
  } else if (frame.method === 'session/prompt') throw new Error('The session interaction proof must never send a model prompt.');
}
