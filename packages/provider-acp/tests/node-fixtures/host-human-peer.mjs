import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const record = (entry) => appendFileSync(process.env.ACP_HUMAN_LOG, JSON.stringify(entry) + '\n');
const send = (frame) => { record({ kind: 'outbound', frame }); process.stdout.write(JSON.stringify(frame) + '\n'); };
let receivedCommands = 0;
process.on('SIGUSR1', () => {
  const commands = readFileSync(process.env.ACP_HUMAN_COMMANDS, 'utf8').split('\n').filter(Boolean);
  for (const command of commands.slice(receivedCommands)) send(JSON.parse(command));
  receivedCommands = commands.length;
});
record({ kind: 'started', pid: process.pid });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  record({ kind: 'inbound', frame });
  if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: {
    protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } },
  } });
  else if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'native-session' } });
  else if (frame.method === 'session/close') send({ jsonrpc: '2.0', id: frame.id, result: {} });
}
