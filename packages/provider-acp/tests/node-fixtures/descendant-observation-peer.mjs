import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.ACP_SESSION_FIXTURE_MODE;
const root = 'controlled-native-session';
const child = 'native-child';
const log = (entry) => appendFileSync(process.env.ACP_SESSION_FIXTURE_LOG, `${JSON.stringify(entry)}\n`);
const send = (frame) => { log({ kind: 'outbound', frame }); process.stdout.write(`${JSON.stringify(frame)}\n`); };
const notification = (sessionId, update, meta) => send({ jsonrpc: '2.0', method: '_x.ai/session_notification',
  params: { sessionId, update, ...(meta ? { _meta: meta } : {}) } });
const spawn = (id = child, fields = {}, meta) => notification(root, { sessionUpdate: 'subagent_spawned',
  subagent_id: id, parent_session_id: root, child_session_id: id, parent_prompt_id: 'parent-prompt', attempt_id: `attempt:${id}`, ...fields }, meta);
const queue = (sessionId, runningPromptId = 'child-prompt') => send({ jsonrpc: '2.0', method: '_x.ai/queue/changed',
  params: { sessionId, entries: [], runningPromptId, runningKind: 'prompt' } });
const update = (sessionId, value, meta) => send({ jsonrpc: '2.0', method: 'session/update',
  params: { sessionId, update: value, ...(meta ? { _meta: meta } : {}) } });
const permission = (sessionId, id, toolCallId) => send({ jsonrpc: '2.0', id, method: 'session/request_permission',
  params: { sessionId, toolCall: { toolCallId, title: 'Controlled permission', status: 'in_progress' },
    options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }], _meta: { child_session_id: child } } });
let prompt;
let callerTurns = 0;
let reviews = 0;
let pendingHistoryLoad;
const complete = () => {
  update(root, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Parent survived.' } });
  send({ jsonrpc: '2.0', id: prompt, result: { stopReason: 'end_turn' } });
};
function scenario() {
  if (mode === 'isolation') {
    spawn();
    spawn('native-child-B');
    send({ jsonrpc: '2.0', method: '_x.ai/mcp_initialized', params: { sessionId: child, mcpToolCount: 0, elapsedMs: 0 } });
    queue(child);
    queue('native-child-B');
    update(child, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'child-only', description: 'Child command' }] });
    update(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child output must stay isolated.' } });
    update(child, { sessionUpdate: 'tool_call', toolCallId: 'child-tool', title: 'Child tool' });
    notification(child, { sessionUpdate: 'turn_completed', prompt_id: 'child-prompt', stop_reason: 'end_turn' });
    permission(root, 'parent-permission', 'parent-tool');
    permission(child, 'child-permission', 'child-tool');
    for (const [id, method, params] of [
      ['child-read', 'fs/read_text_file', { path: '/fixture/readme' }],
      ['child-write', 'fs/write_text_file', { path: '/fixture/readme', content: 'child' }],
      ['child-terminal', 'terminal/create', { command: '/fixture/tool', outputByteLimit: 1024 }],
      ['child-form', 'elicitation/create', { mode: 'form', message: 'Child question', requestedSchema: { type: 'object', properties: {} } }],
    ]) send({ jsonrpc: '2.0', id, method, params: { sessionId: child, ...params } });
    return;
  }
  if (mode === 'retention' || mode === 'retention-conflict') {
    if (callerTurns === 1) {
      spawn();
      notification(child, { sessionUpdate: 'turn_completed', prompt_id: 'child-prompt', stop_reason: 'end_turn' });
    } else if (mode === 'retention-conflict') { spawn(child, { attempt_id: 'new-attempt' }); return; }
    else queue(child);
    complete();
  } else if (mode === 'duplicate') {
    spawn();
    spawn();
    queue(child);
    complete();
  } else if (mode === 'count-pressure') {
    for (let index = 0; index < 3; index += 1) spawn(`child:${index}`);
  } else if (mode === 'byte-pressure') {
    for (let index = 0; index < 64; index += 1) {
      const suffix = `${index}:`.padEnd(254, 'x');
      spawn(`c:${suffix}`, { subagent_id: `s:${suffix}`, attempt_id: `a:${suffix}`, parent_prompt_id: `p:${suffix}` });
    }
  } else if (mode === 'foreign-extension') queue('foreign-session');
  else if (mode === 'foreign-standard') update('foreign-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Foreign output' } });
  else if (mode === 'child-conflict') { spawn(); spawn(child, { subagent_id: 'other-subagent' }); }
  else if (mode === 'subagent-conflict') { spawn(); spawn('other-session', { subagent_id: child }); }
  else if (mode === 'attempt-conflict') { spawn(); spawn(child, { attempt_id: 'new-attempt' }); }
  else if (mode === 'wrong-parent') spawn(child, { parent_session_id: 'foreign-session' });
  else if (mode === 'root-alias') spawn(root);
  else if (mode === 'missing-identity') spawn(child, { subagent_id: null });
  else if (mode === 'identity-byte-pressure') spawn('é'.repeat(129));
  else if (mode === 'nested') {
    spawn();
    notification(child, { sessionUpdate: 'subagent_spawned', subagent_id: 'grandchild', child_session_id: 'grandchild', parent_session_id: child });
  } else if (mode === 'unknown-extension') {
    send({ jsonrpc: '2.0', method: '_x.ai/unregistered', params: { sessionId: root,
      update: { sessionUpdate: 'subagent_spawned', subagent_id: child, parent_session_id: root, child_session_id: child } } });
    queue(child);
  } else if (mode === 'tool-text') {
    update(root, { sessionUpdate: 'tool_call', toolCallId: 'root-tool', title: 'spawn_subagent', rawOutput: {
      text: `subagent_id: ${child}`, child_session_id: child, parent_session_id: root } });
    queue(child);
  } else if (mode === 'permission-metadata') {
    permission(root, 'metadata-only', 'root-tool');
    queue(child);
  } else if (mode === 'child-queue-invalid') { spawn(); queue(child, 'é'.repeat(129)); }
  else if (mode === 'replay-live') { spawn(child, {}, { isReplay: true }); queue(child); }
  else if (mode === 'replay-revive') { spawn(child, {}, { isReplay: true }); spawn(); }
  else if (mode === 'replay-marker-invalid') spawn(child, {}, { isReplay: 'true' });
  else if (mode === 'history-live') queue('native-history');
  else throw new Error('Unknown descendant observation scenario.');
}
function planReview() {
  reviews += 1;
  send({ jsonrpc: '2.0', id: `review:${reviews}`, method: '_x.ai/exit_plan_mode', params: {
    sessionId: root, toolCallId: `plan:${reviews}`, planContent: '# Owned parent plan',
  } });
}
process.on('SIGUSR1', planReview);
log({ kind: 'started', pid: process.pid, argv: process.argv.slice(2) });

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  log({ kind: 'inbound', frame });
  if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [],
    agentInfo: { name: 'Grok Build', version: '1.0.60' }, _meta: { agentVersion: '1.0.60' },
  } });
  else if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: root } });
  else if (frame.method === 'session/load') {
    spawn('native-history');
    queue('native-history', 'plan-resume-next');
    update('native-history', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hidden history.' } });
    if (mode === 'history-pressure') {
      pendingHistoryLoad = frame.id;
      send({ jsonrpc: '2.0', id: 'history-barrier', method: '_fixture/history_barrier', params: {} });
      continue;
    }
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    if (mode === 'continuation') setImmediate(planReview);
  }
  else if (!frame.method && frame.id === 'history-barrier') {
    if (frame.error?.code !== -32601 || pendingHistoryLoad === undefined) throw new Error('Expected the correlated history barrier rejection.');
    queue('native-history');
    queue('native-history');
    send({ jsonrpc: '2.0', id: pendingHistoryLoad, result: {} });
    pendingHistoryLoad = undefined;
  }
  else if (frame.method === 'session/prompt') {
    prompt = frame.id;
    callerTurns += 1;
    scenario();
  } else if (!frame.method && frame.id === 'parent-permission') {
    complete();
  } else if (!frame.method && String(frame.id).startsWith('review:')) {
    const parentPrompt = reviews === 1 ? 'plan-resume-current' : 'plan-resume-next';
    queue(root, parentPrompt);
    if (reviews === 1) {
      spawn();
      queue(child, 'plan-resume-next');
      update(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hidden child output.' } }, { promptId: 'plan-resume-next' });
      notification(child, { sessionUpdate: 'turn_completed', prompt_id: 'plan-resume-next', stop_reason: 'end_turn' });
    }
    update(root, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Parent continuation ${reviews}.` } }, { promptId: parentPrompt });
    notification(root, { sessionUpdate: 'turn_completed', prompt_id: parentPrompt, stop_reason: 'end_turn' });
  }
}
