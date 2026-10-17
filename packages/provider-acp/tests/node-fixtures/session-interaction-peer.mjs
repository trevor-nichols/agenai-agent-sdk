import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.ACP_SESSION_FIXTURE_MODE;
if (!new Set(['none', 'early', 'late', 'during-turn', 'initialization-question', 'wrong-native-id', 'wrong-cwd',
  'invalid-config', 'double-early', 'invalid-setup', 'observer-failure', 'withdrawal', 'disconnect', 'late-fatal',
  'second-retained', 'pending', 'all-config', 'late-wrong-native-id', 'late-wrong-cwd', 'plan', 'plan-held-terminal',
  'plan-version', 'plan-null', 'plan-wrong-session', 'plan-stale-prompt', 'plan-wrong-output', 'plan-wrong-terminal',
  'plan-count-pressure', 'plan-byte-pressure', 'plan-cancel-before-output', 'plan-cancel-after-output',
  'plan-replay-queue-reuse', 'plan-replay-output-reuse', 'plan-replay-terminal-reuse',
  'plan-historical-output-reuse', 'plan-historical-terminal-reuse', 'plan-current-replay',
  'plan-active-interrupted', 'plan-terminal-error', 'plan-native-cancelled', 'plan-native-cancelled-before-output']).has(mode)) throw new Error('Unknown controlled peer scenario.');
const log = (entry) => appendFileSync(process.env.ACP_SESSION_FIXTURE_LOG, `${JSON.stringify(entry)}\n`);
const sessionId = 'controlled-native-session';
const requestId = 'controlled-folder-trust:1';
const plan = mode.startsWith('plan');
const promptId = 'plan-resume-controlled';
const terminal = (stopReason = 'end_turn') => send({ jsonrpc: '2.0', method: '_x.ai/session_notification', params: { sessionId,
  update: { sessionUpdate: 'turn_completed', prompt_id: mode === 'plan-wrong-terminal' ? 'plan-resume-foreign' : promptId,
    stop_reason: mode === 'plan-active-interrupted' ? 'interrupted' : stopReason,
    ...(mode === 'plan-terminal-error' ? { error: { message: 'Controlled native failure.' } } : {}) } } });
const queue = (id, replay = false) => send({ jsonrpc: '2.0', method: '_x.ai/queue/changed', params: { sessionId,
  entries: [], runningKind: 'prompt', runningPromptId: id, ...(replay ? { _meta: { isReplay: true } } : {}) } });
const replayUpdate = (channel, id, replay = true) => send({ jsonrpc: '2.0', method: channel === 'output' ? 'session/update' : '_x.ai/session_notification', params: {
  sessionId, _meta: { ...(channel === 'output' ? { promptId: id } : {}), ...(replay ? { isReplay: true } : {}) },
  update: channel === 'output' ? { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Historical output must stay hidden.' } }
    : { sessionUpdate: 'turn_completed', prompt_id: id, stop_reason: 'interrupted' },
} });
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
  if (mode === 'plan-held-terminal') terminal();
  else if (mode === 'withdrawal') send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId } });
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
      ...(plan ? { _meta: { agentVersion: mode === 'plan-version' ? '1.0.50' : '1.0.60' } } : {}),
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} }, mcpCapabilities: { http: true } },
    } });
  } else if (frame.method === 'session/load') {
    const historicalId = mode === 'plan-replay-queue-reuse' ? promptId : 'plan-resume-historical';
    send({ jsonrpc: '2.0', method: '_x.ai/queue/changed', params: { sessionId, entries: [{ id: historicalId }], _meta: { isReplay: true } } });
    if (mode === 'plan-replay-output-reuse' || mode === 'plan-historical-output-reuse') replayUpdate('output', promptId, mode === 'plan-replay-output-reuse');
    if (mode === 'plan-replay-terminal-reuse' || mode === 'plan-historical-terminal-reuse') replayUpdate('terminal', promptId, mode === 'plan-replay-terminal-reuse');
    if (mode === 'plan-stale-prompt') send({ jsonrpc: '2.0', method: '_x.ai/queue/changed', params: { sessionId, entries: [{ id: promptId }] } });
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    setImmediate(() => send({ jsonrpc: '2.0', id: 'controlled-plan:1', method: '_x.ai/exit_plan_mode', params: {
      sessionId: mode === 'plan-wrong-session' ? 'foreign-native-session' : sessionId,
      toolCallId: 'exit-plan-mode-resume-controlled', planContent: mode === 'plan-null' ? null : '# Controlled plan\n\nPerform the owned task.\n',
    } }));
  } else if (!frame.method && frame.id === 'controlled-plan:1') {
    if (frame.result?.outcome === 'abandoned') continue;
    queue(promptId);
    if (mode === 'plan-current-replay') {
      queue(promptId, true);
      replayUpdate('output', promptId);
      replayUpdate('terminal', promptId);
      queue(promptId);
    }
    if (mode !== 'plan-cancel-before-output' && mode !== 'plan-native-cancelled-before-output') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
      _meta: { promptId: mode === 'plan-wrong-output' ? 'plan-resume-foreign' : promptId },
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Native continued output.' } } } });
    if (!['plan-held-terminal', 'plan-cancel-before-output', 'plan-cancel-after-output'].includes(mode)) {
      terminal(mode === 'plan-native-cancelled' || mode === 'plan-native-cancelled-before-output' ? 'cancelled' : 'end_turn');
    }
  } else if (frame.method === 'session/cancel') {
    terminal('cancelled');
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
    if (mode === 'plan-count-pressure' || mode === 'plan-byte-pressure') {
      for (let index = 0; index < (mode === 'plan-count-pressure' ? 17 : 7); index += 1) {
        send({ jsonrpc: '2.0', id: `pressure:${index}`, method: 'session/request_permission', params: { sessionId,
          toolCall: { toolCallId: `pressure-tool:${index}`, title: mode === 'plan-byte-pressure' ? 'x'.repeat(80_000) : 'Controlled tool', status: 'in_progress' },
          options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }] } });
      }
      send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
      continue;
    }
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
