import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.ACP_SESSION_FIXTURE_MODE;
if (!new Set(['none', 'early', 'late', 'during-turn', 'initialization-question', 'wrong-native-id', 'wrong-cwd',
  'invalid-config', 'double-early', 'invalid-setup', 'observer-failure', 'withdrawal', 'disconnect', 'late-fatal',
  'second-retained', 'pending', 'all-config', 'late-wrong-native-id', 'late-wrong-cwd']).has(mode)) throw new Error('Unknown controlled peer scenario.');
const log = (entry) => appendFileSync(process.env.ACP_SESSION_FIXTURE_LOG, `${JSON.stringify(entry)}\n`);
const sessionId = 'controlled-native-session';
const requestId = 'controlled-folder-trust:1';
let questionCount = 0;
const send = (frame) => { log({ kind: 'outbound', frame }); process.stdout.write(`${JSON.stringify(frame)}\n`); };
const question = (overrides = {}) => {
  questionCount += 1;
  send({ jsonrpc: '2.0', id: questionCount === 1 ? requestId : `controlled-folder-trust:${questionCount}`,
    method: '_x.ai/folder_trust/request', params: {
      sessionId, cwd: process.cwd(), workspace: `${process.cwd()}/configuration-scope`, configKinds: ['mcp'], ...overrides,
    } });
};
log({ kind: 'started', pid: process.pid, argv: process.argv.slice(2) });
process.on('SIGUSR1', () => {
  if (mode === 'withdrawal') send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId } });
  else if (mode === 'second-retained') question();
  else if (mode === 'late-fatal') { log({ kind: 'malformed-output' }); process.stdout.write('{invalid-json}\n'); }
  else if (mode === 'disconnect') { log({ kind: 'peer-disconnect' }); process.exit(19); }
  else if (mode === 'late-wrong-native-id') question({ sessionId: 'different-native-session' });
  else if (mode === 'late-wrong-cwd') question({ cwd: `${process.cwd()}/other` });
});

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  log({ kind: 'inbound', frame });
  if (frame.method === 'initialize') {
    if (mode === 'initialization-question') question();
    send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, authMethods: [],
      agentInfo: { name: 'controlled-session-peer', version: '1' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} }, mcpCapabilities: { http: true } },
    } });
  } else if (frame.method === 'session/new') {
    if (['early', 'wrong-native-id', 'wrong-cwd', 'invalid-config', 'double-early', 'invalid-setup', 'observer-failure'].includes(mode)) {
      question(mode === 'wrong-native-id' ? { sessionId: 'different-native-session' }
        : mode === 'wrong-cwd' ? { cwd: `${process.cwd()}/other` }
          : mode === 'invalid-config' ? { configKinds: ['mcp', 'unknown-effect'] } : {});
      if (mode === 'double-early') question();
    }
    const config = { id: 'duplicated-model', name: 'Model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }] };
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId,
      ...(mode === 'invalid-setup' ? { configOptions: [config, config] } : {}),
    } });
    if (['late', 'withdrawal', 'disconnect', 'late-fatal', 'second-retained', 'pending'].includes(mode)) setImmediate(() => question());
    if (mode === 'all-config') setImmediate(() => question({ configKinds: ['mcp', 'plugins', 'permission', 'lsp', 'envrc',
      'claude', 'hooks', 'agents', 'roles', 'personas', 'workflows', 'instructions', 'skills'] }));
  } else if (frame.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Controlled output before the decision.' } },
    } });
    if (mode === 'during-turn') question();
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Controlled output after the decision.' } },
    } });
    send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
  } else if (frame.method === 'session/close') send({ jsonrpc: '2.0', id: frame.id, result: {} });
}
