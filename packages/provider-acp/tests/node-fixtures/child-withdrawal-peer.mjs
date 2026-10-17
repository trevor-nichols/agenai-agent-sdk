import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.ACP_SESSION_FIXTURE_MODE;
const root = 'controlled-native-session';
const child = 'child:A';
const attempt = 'attempt:A';
const tool = 'tool:A';
const log = (entry) => appendFileSync(process.env.ACP_SESSION_FIXTURE_LOG, `${JSON.stringify(entry)}\n`);
const send = (frame) => { log({ kind: 'outbound', frame }); process.stdout.write(`${JSON.stringify(frame)}\n`); };
const notification = (sessionId, update, meta) => send({ jsonrpc: '2.0', method: '_x.ai/session_notification',
  params: { sessionId, update, ...(meta ? { _meta: meta } : {}) } });
const spawn = (fields = {}) => notification(root, { sessionUpdate: 'subagent_spawned', parent_session_id: root,
  child_session_id: child, subagent_id: child, attempt_id: attempt, parent_prompt_id: 'parent-prompt', ...fields });
const pending = (toolId = tool, fields = {}, meta) => notification(child, { sessionUpdate: 'pending_interaction', tool_call_id: toolId, kind: 'permission', ...fields }, meta);
const permission = (id, target = child, toolId = tool) => send({ jsonrpc: '2.0', id, method: 'session/request_permission',
  params: { sessionId: root, toolCall: { toolCallId: toolId, title: 'Controlled child edit', status: 'in_progress',
    _meta: { 'x.ai/requestingSessionId': target } }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }] } });
const resolved = (meta) => notification(child, { sessionUpdate: 'interaction_resolved', tool_call_id: tool }, meta);
const finish = (fields = {}, meta) => notification(root, { sessionUpdate: 'subagent_finished', child_session_id: child,
  subagent_id: child, attempt_id: attempt, status: 'cancelled', ...fields }, meta);
let prompt;
let signals = 0;
let turns = 0;
const barrier = (id) => send({ jsonrpc: '2.0', id, method: '_fixture/child_withdrawal_barrier', params: {} });
const complete = () => {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: root,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Surviving parent output.' } } } });
  send({ jsonrpc: '2.0', id: prompt, result: { stopReason: 'end_turn' } });
};
process.on('SIGUSR1', () => {
  signals += 1;
  if (mode === 'gap' && signals === 1) { resolved(); barrier('resolved-barrier'); return; }
  if (mode === 'gap' && signals === 2) { barrier('gap-barrier'); return; }
  if (mode === 'generic-resolved') { resolved(); barrier('facts-barrier'); return; }
  if (mode === 'foreign-resolution') notification('child:foreign', { sessionUpdate: 'interaction_resolved', tool_call_id: tool });
  else if (mode === 'root-resolution') notification(root, { sessionUpdate: 'interaction_resolved', tool_call_id: tool });
  else if (mode !== 'gap' && mode !== 'turn-terminal-only' && mode !== 'finish-before-resolved') resolved(mode === 'replay-resolved' ? { isReplay: true } : undefined);
  notification(child, { sessionUpdate: 'turn_completed', prompt_id: 'child-prompt', stop_reason: 'cancelled' });
  if (mode !== 'turn-terminal-only') finish(mode === 'completed' ? { status: 'completed' }
    : mode === 'attempt-mismatch' ? { attempt_id: 'attempt:other' }
      : mode === 'subagent-mismatch' ? { subagent_id: 'child:other' } : {}, mode === 'replay-finish' ? { isReplay: true } : undefined);
  if (mode === 'finish-before-resolved') resolved();
  if (mode === 'active' || mode === 'gap') permission('survivor', root, 'tool:survivor');
  barrier('facts-barrier');
});
log({ kind: 'started', pid: process.pid, argv: process.argv.slice(2) });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  log({ kind: 'inbound', frame });
  if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'Grok Build', version: '1.0.60' },
    _meta: { agentVersion: '1.0.60' },
  } });
  else if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: root } });
  else if (frame.method === 'session/prompt') {
    prompt = frame.id;
    turns += 1;
    if (mode === 'reuse-next-turn' && turns === 2) { pending(); permission('future-permission'); continue; }
    spawn(mode === 'missing-attempt' ? { attempt_id: undefined } : {});
    if (mode === 'foreign-resolution') spawn({ child_session_id: 'child:foreign', subagent_id: 'child:foreign', attempt_id: 'attempt:foreign' });
    if (mode === 'census-count') { pending(); continue; }
    if (mode === 'census-byte') {
      for (let index = 0; index < 300; index += 1) pending(`${index}:`.padEnd(256, 'x'));
      continue;
    }
    if (mode !== 'no-precursor') pending(tool, mode === 'wrong-kind' ? { kind: 'question' } : {}, mode === 'replay-pending' ? { isReplay: true } : undefined);
    if (mode === 'pre-resolved') resolved();
    if (mode === 'pre-finished') finish();
    if (mode === 'queued') permission('survivor', root, 'tool:survivor');
    permission('child-permission', mode === 'wrong-requester' ? 'child:unannounced' : child, mode === 'wrong-tool' ? 'tool:other' : tool);
    if (mode === 'close-pending') {
      spawn({ child_session_id: 'child:B', subagent_id: 'child:B', attempt_id: 'attempt:B' });
      notification('child:B', { sessionUpdate: 'pending_interaction', tool_call_id: 'tool:B', kind: 'permission' });
      permission('child-permission:B', 'child:B', 'tool:B');
      barrier('callbacks-live');
    }
  } else if (frame.method === 'session/cancel' && mode === 'close-pending') {
    if (prompt === undefined) throw new Error('The controlled original prompt was already settled.');
    resolved(); finish();
    notification('child:B', { sessionUpdate: 'interaction_resolved', tool_call_id: 'tool:B' });
    notification(root, { sessionUpdate: 'subagent_finished', child_session_id: 'child:B', subagent_id: 'child:B', attempt_id: 'attempt:B', status: 'cancelled' });
    send({ jsonrpc: '2.0', id: prompt, result: { stopReason: 'cancelled' } });
    prompt = undefined;
  } else if (!frame.method && frame.id === 'survivor') complete();
  else if (!frame.method && frame.id === 'child-permission' && frame.result !== undefined) {
    if (mode === 'close-pending') continue;
    if (mode === 'entered') { resolved(); finish(); permission('survivor', root, 'tool:survivor'); }
    else complete();
  }
}
