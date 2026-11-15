import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (entry) => appendFileSync(process.env.ACP_CONTROLLED_LOG, `${JSON.stringify(entry)}\n`);
const opening = JSON.parse(process.env.ACP_CONTROLLED_OPENING);
const permission = process.env.ACP_CONTROLLED_PERMISSION ? JSON.parse(process.env.ACP_CONTROLLED_PERMISSION) : undefined;
const send = (frame) => {
  log({ kind: 'outbound', frame });
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};
let openingId;
let promptId;
const completeOpening = () => {
  if (openingId === undefined) return;
  send({ jsonrpc: '2.0', id: openingId, result: opening });
  openingId = undefined;
};
process.on('SIGUSR1', completeOpening);
log({ kind: 'started', pid: process.pid, cwd: process.cwd() });

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  log({ kind: 'inbound', frame });
  if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: {
    protocolVersion: 1, agentCapabilities: {}, _meta: { agentVersion: '1.0.77', grokShell: true,
      currentWorkingDirectory: '/workspace/work', modelState: { currentModelId: 'grok-4.6' } },
  } });
  else if (frame.method === 'session/new') {
    openingId = frame.id;
    if (process.env.ACP_CONTROLLED_DELAY_OPENING !== 'true') completeOpening();
  } else if (frame.method === 'session/prompt') {
    promptId = frame.id;
    if (permission) send({ jsonrpc: '2.0', id: 'native:permission', method: 'session/request_permission', params: permission });
    else send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  } else if (frame.id === 'native:permission' && !frame.method) {
    writeFileSync(process.env.ACP_CONTROLLED_EFFECT, `${opening.sessionId}:${frame.result.outcome.optionId}`);
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
}
