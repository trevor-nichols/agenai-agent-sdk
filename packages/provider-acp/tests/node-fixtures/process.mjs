import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const log = (entry) => appendFileSync(process.env.ACP_FIXTURE_LOG, `${JSON.stringify(entry)}\n`);
if (process.env.ACP_FIXTURE_ROLE === 'descendant') {
  log({ type: 'descendant_started', pid: process.pid });
  process.on('SIGTERM', () => log({ type: 'descendant_ignored_term' }));
  setInterval(() => {}, 1_000);
  process.send('ready');
  await new Promise(() => {});
}
const descendantPeer = process.env.ACP_FIXTURE_ROLE === 'peer';
log({ type: descendantPeer ? 'descendant_started' : 'started', pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), inherited: process.env.ACP_PARENT_ONLY ?? null });
if (descendantPeer) process.send('ready');
if (!descendantPeer && process.env.ACP_FIXTURE_MODE.startsWith('descendant_')) {
  const delegates = process.env.ACP_FIXTURE_MODE === 'descendant_peer';
  const child = spawn(process.execPath, [process.argv[1]], {
    env: { ...process.env, ACP_FIXTURE_ROLE: delegates ? 'peer' : 'descendant' },
    stdio: delegates ? ['inherit', 'inherit', 'inherit', 'ipc'] : process.env.ACP_FIXTURE_MODE === 'descendant_ignored_stdio'
      ? ['ignore', 'ignore', 'ignore', 'ipc'] : ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  await once(child, 'message');
  child.disconnect();
  if (delegates) process.exit(0);
  if (process.env.ACP_FIXTURE_MODE === 'descendant_early_exit') process.exit(17);
}
if (process.env.ACP_FIXTURE_MODE === 'early_exit') process.exit(17);
if (process.env.ACP_FIXTURE_MODE === 'ignore_term') {
  process.on('SIGTERM', () => log({ type: 'ignored_term' }));
}
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let permissionPrompt;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  log({ type: 'received', method: message.method, params: message.params, id: message.id, result: message.result });
  if (message.method === 'initialize') {
    if (process.env.ACP_FIXTURE_MODE === 'unknown_extension') send({ jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: { servers: [] } });
    if (process.env.ACP_FIXTURE_MODE === 'malformed') process.stdout.write('{bad-json}\n');
    else send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'node-fixture', version: '1.0.0' } } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: `native:${process.pid}` } });
  } else if (message.method === 'session/prompt') {
    if (process.env.ACP_FIXTURE_MODE === 'remembered_permission') {
      permissionPrompt = message.id;
      send({ jsonrpc: '2.0', id: 'node:permission', method: 'session/request_permission', params: {
        sessionId: message.params.sessionId, toolCall: { toolCallId: 'node:edit', title: 'Edit file', kind: 'edit', status: 'in_progress' },
        options: [{ optionId: 'native:node-remember', name: 'Allow permanently', kind: 'allow_always' }],
      } });
      continue;
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture output' } } } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.id === 'node:permission' && !message.method) {
    send({ jsonrpc: '2.0', id: permissionPrompt, result: { stopReason: 'end_turn' } });
  }
}
if (process.env.ACP_FIXTURE_MODE === 'ignore_term') setInterval(() => {}, 1_000);
