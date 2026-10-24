// ------------------------------------------------------------------------------------------------
//                acp-peer.mjs - Controlled guest ACP conversation - No model or host facilities
// ------------------------------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const scenario = process.argv[2];
if (!['normal', 'eager', 'control'].includes(scenario)) throw new Error('An explicit controlled scenario is required.');
const workspace = process.cwd();
const input = await readFile(resolve(workspace, 'input.txt'), 'utf8');
const pending = new Map();
const permissionResponses = [];
const hostReplies = [];
let initializeCount = 0;
let sessionCreates = 0;
let prompts = 0;
let promptId;
let requestSequence = 0;
let stderrBytes = 0;

const send = (frame) => {
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
  const unicode = bytes.indexOf(Buffer.from('α'));
  if (unicode < 0) process.stdout.write(bytes);
  else { process.stdout.write(bytes.subarray(0, unicode + 1)); process.stdout.write(bytes.subarray(unicode + 1)); }
};
const snapshot = () => ({ scenario, node: process.version, input, initializeCount, sessionCreates, prompts, permissionResponses, hostReplies, stderrBytes });
const save = () => writeFile(resolve(workspace, 'artifact.json'), `${JSON.stringify(snapshot())}\n`);
const request = (method, params) => {
  const id = `guest:${++requestSequence}`;
  const response = Promise.withResolvers();
  pending.set(id, response);
  send({ jsonrpc: '2.0', id, method, params });
  return response.promise;
};
const complete = (stopReason, expectedPrompt = promptId) => {
  if (promptId === undefined || promptId !== expectedPrompt) return;
  send({ jsonrpc: '2.0', id: promptId, result: { stopReason } });
  promptId = undefined;
};

async function prompt(frame) {
  if (promptId !== undefined) throw new Error('Controlled peer received overlapping prompts.');
  promptId = frame.id;
  prompts += 1;
  if (scenario === 'control') await save();
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'guest-session',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `guest turn ${prompts}: α\n` } } } });
  const response = await request('session/request_permission', { sessionId: 'guest-session',
    toolCall: { toolCallId: `guest-edit:${prompts}`, title: 'Edit the isolated artifact', kind: 'edit', status: 'in_progress' },
    options: [{ optionId: 'guest:allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'guest:deny', name: 'Deny once', kind: 'reject_once' }],
  });
  permissionResponses.push(response.result);
  if (scenario === 'control') { complete('cancelled', frame.id); return; }
  if (JSON.stringify(response.result) !== '{"outcome":{"outcome":"selected","optionId":"guest:allow"}}') {
    throw new Error('Controlled permission did not receive its exact offered answer.');
  }
  if (prompts === 1) {
    const requests = [
      ['fs/read_text_file', { path: process.env.CONTROLLED_HOST_SENTINEL }],
      ['fs/write_text_file', { path: process.env.CONTROLLED_HOST_SENTINEL, content: 'escaped guest write' }],
      ['terminal/create', { command: '/usr/bin/touch', args: [process.env.CONTROLLED_HOST_MARKER] }],
    ];
    for (const [method, params] of requests) {
      const result = await request(method, { sessionId: 'guest-session', ...params });
      hostReplies.push({ method, error: result.error });
      if (result.error?.code !== -32602) throw new Error('A disabled host facility was not denied.');
    }
  }
  await save();
  complete('end_turn', frame.id);
}

async function receive(frame) {
  if (frame.method === undefined) {
    const response = pending.get(frame.id);
    if (!response) throw new Error('Controlled peer received a duplicate or unknown response.');
    pending.delete(frame.id);
    response.resolve(frame);
  } else if (frame.method === 'initialize') {
    initializeCount += 1;
    const diagnostic = Buffer.from([0x73, 0x74, 0x64, 0x65, 0x72, 0x72, 0x00, 0xff, 0x0a]);
    process.stderr.write(diagnostic);
    stderrBytes += diagnostic.byteLength;
    await save();
    send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1,
      agentInfo: { name: 'sandbox-docker-controlled-peer', version: '1' }, authMethods: [] } });
  } else if (frame.method === 'session/new') {
    if (frame.params.cwd !== workspace) throw new Error('SDK session cwd differs from the guest workspace.');
    sessionCreates += 1;
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'guest-session' } });
  } else if (frame.method === 'session/prompt') await prompt(frame);
  else if (frame.method === 'session/cancel') complete('cancelled');
  else throw new Error(`Controlled peer received an unexpected method: ${frame.method}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Controlled frame exceeded its bound.');
  void receive(JSON.parse(line)).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
    lines.close();
    process.stdin.destroy();
  });
});
