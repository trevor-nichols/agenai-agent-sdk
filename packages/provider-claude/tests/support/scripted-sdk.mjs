// ------------------------------------------------------------------------------------------------
//                scripted-sdk.mjs - Claude Agent SDK stand-in for worker transport tests; the model id selects a script
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const BUILTIN_TOOL_NAMES = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch'];

/** System messages of the pinned SDK contract that a script sends after its init. */
const OBSERVATIONS = {
  'plan-status': [{ subtype: 'status', status: null, permissionMode: 'plan' }],
  'model-fallback': [{ subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'session', original_model: 'model-fallback',
    fallback_model: 'claude-fallback-model', request_id: null, content: '' }],
  'status-default': [{ subtype: 'status', status: 'requesting' }, { subtype: 'status', status: 'compacting' },
    { subtype: 'status', status: null, compact_result: 'success' }, { subtype: 'status', status: null, permissionMode: 'default' }],
};

// Native result usage shaped like the pinned SDK's `SDKResultMessage`: per-turn main-loop `usage`,
// cumulative per-model `modelUsage` and the query-local `result_index`. Thinking is Claude's default zero.
const usage = (input, cacheRead, cache5m, cache1h, output) => ({
  input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cache5m + cache1h,
  cache_creation: { ephemeral_5m_input_tokens: cache5m, ephemeral_1h_input_tokens: cache1h }, output_tokens: output,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard', output_tokens_details: { thinking_tokens: 0 },
});
const model = (input, cacheRead, cache5m, cache1h, output) => ({
  inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cache5m + cache1h,
  cacheCreationEphemeral5mInputTokens: cache5m, cacheCreationEphemeral1hInputTokens: cache1h, thinkingTokens: 0,
  webSearchRequests: 0, costUSD: 0.01, contextWindow: 200_000, maxOutputTokens: 32_000,
});
const success = (index, turn, models) => ({ subtype: 'success', is_error: false, result_index: index, usage: turn, modelUsage: models });
const first = (name) => success(0, usage(10, 100, 1000, 0, 1), { [name]: model(10, 100, 1000, 0, 1) });
const second = (name) => success(1, usage(20, 200, 0, 2000, 2), { [name]: model(30, 300, 1000, 2000, 3) });
/** Each usage script's results, one per turn; `crash` exits the worker and `interrupt` waits for an interruption. */
const USAGE = {
  'usage-two-turn': [first('usage-two-turn'), second('usage-two-turn')],
  // Code's accumulator turns nullable API cache counters and retention into zero, then loses that provenance.
  'usage-defaulted-zero': [success(0, usage(0, 0, 0, 0, 0), { 'usage-defaulted-zero': model(0, 0, 0, 0, 0) })],
  'usage-defaulted': [success(0, usage(100, 0, 0, 0, 10), { 'usage-defaulted': model(100, 0, 0, 0, 10) }),
    success(1, usage(20, 5, 6, 7, 2), { 'usage-defaulted': model(120, 5, 6, 7, 12) })],
  // Two main-loop requests around one owned call, plus one auxiliary model.
  'usage-tool': [success(0, usage(30, 300, 1000, 2000, 3), { 'usage-tool': model(30, 300, 1000, 2000, 3), 'claude-auxiliary': model(40_000, 0, 0, 0, 400) })],
  'usage-error': [first('usage-error'), { subtype: 'success', is_error: true, result_index: 1, usage: usage(0, 0, 0, 0, 0), modelUsage: {} },
    success(2, usage(20, 200, 0, 2000, 2), { 'usage-error': model(30, 300, 1000, 2000, 3) })],
  'usage-interrupt': [first('usage-interrupt'), 'interrupt', success(2, usage(20, 200, 0, 2000, 2), { 'usage-interrupt': model(40, 400, 1000, 2000, 13) })],
  'usage-crash': [first('usage-crash'), 'crash'],
  'usage-unsplit': [success(0, { ...usage(10, 100, 0, 0, 1), cache_creation_input_tokens: 1000, cache_creation: undefined },
    { 'usage-unsplit': { ...model(10, 100, 600, 0, 1), cacheCreationInputTokens: 1000, cacheCreationEphemeral1hInputTokens: undefined } })],
  'usage-invalid': [success(0, { ...usage(10, 100, 1000, 0, 1), input_tokens: 1.5 }, { 'usage-invalid': model(10, 100, 1000, 0, 1) })],
  'usage-models': [success(0, usage(10, 0, 0, 0, 1), Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`model-${index}`, model(1, 0, 0, 0, 1)])))],
  'usage-regression': [first('usage-regression'), success(1, usage(1, 0, 0, 0, 1), { 'usage-regression': model(5, 100, 1000, 0, 1) })],
};

export function tool(name, description, schema, handler) {
  return { name, description, schema, handler };
}

export function createSdkMcpServer({ name, tools }) {
  return { type: 'sdk', name, tools };
}

export function query({ prompt, options }) {
  const script = options.model;
  const server = options.mcpServers.agenai;
  const prompts = prompt[Symbol.asyncIterator]();
  let closed = false;
  let release;
  let interrupted;
  const stopped = new Promise((resolve) => { release = resolve; });
  let turn = 0;
  if (script === 'orphan') spawn('/bin/sh', ['-c', 'echo $$ > "$TMPDIR/orphan.pid"; exec /bin/sleep 600'], { stdio: 'ignore' }).unref();

  async function* messages() {
    if (script === 'crash') {
      await prompts.next();
      process.exit(3);
    }
    if (script === 'oversize') {
      await prompts.next();
      const chunk = 'x'.repeat(65_536);
      for (let index = 0; index < 2049; index += 1) await new Promise((resolve) => process.stdout.write(chunk, resolve));
      await stopped;
      return;
    }
    for (;;) {
      const next = await Promise.race([prompts.next(), stopped.then(() => ({ done: true }))]);
      if (next.done || closed) return;
      yield { type: 'system', subtype: 'init', tools: server.tools.map((entry) => `mcp__agenai__${entry.name}`),
        model: script === 'model-drift' ? 'claude-other-model' : script, permissionMode: 'default', claude_code_version: '2.1.322' };
      for (const message of OBSERVATIONS[script] ?? []) yield { type: 'system', ...message, uuid: 'scripted', session_id: 'scripted' };
      if (USAGE[script]) {
        const result = USAGE[script][turn];
        turn += 1;
        if (result === 'crash') process.exit(3);
        if (result === 'interrupt') {
          // The interrupted request's placeholder usage never settles into a result of its own.
          const stalled = new Promise((resolve) => { interrupted = resolve; });
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_interrupted', content: [{ type: 'text', text: 'partial' }] } };
          await stalled;
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, result_index: 1, usage: usage(10, 100, 0, 0, 10),
            modelUsage: { [script]: model(20, 200, 1000, 0, 11) }, permission_denials: [] };
          continue;
        }
        // Each content block arrives as its own assistant message with the same id and the message_start placeholder usage.
        const placeholder = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 10 };
        yield { type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${turn}`, content: [{ type: 'text', text: `turn ${turn}` }], usage: placeholder } };
        yield { type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${turn}`, content: [{ type: 'thinking', thinking: '' }], usage: placeholder } };
        if (script === 'usage-tool') {
          const read = server.tools.find((entry) => entry.name === 'read');
          await read.handler(read.schema.parse({ file_path: 'notes.txt' }), { _meta: { 'claudecode/toolUseId': 'toolu_usage' } });
        }
        yield { type: 'result', ...result, permission_denials: [] };
        continue;
      }
      if (script === 'tool-budget') {
        const entry = server.tools.find((entry) => entry.name === 'edit');
        const input = entry.schema.parse({ file_path: 'large.txt', old_string: '\0'.repeat(8_388_608), new_string: '\x01'.repeat(6_291_456) });
        const first = entry.handler(input, {});
        const refused = await entry.handler(input, {});
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: JSON.stringify(refused) }] } };
        const settled = await first;
        const retry = await entry.handler(input, {});
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: JSON.stringify([settled, retry]) }] } };
        yield { type: 'result', subtype: 'success', is_error: false, permission_denials: [] };
        continue;
      }
      if (script === 'tool-input') {
        const size = 8 * 1024 * 1024;
        const cases = [
          ['write', { file_path: 'ascii.txt', content: 'x'.repeat(1024 * 1024) }],
          ['write', { file_path: 'escaped.txt', content: '\0'.repeat(size) }],
          ['edit', { file_path: 'escaped.txt', old_string: '\0'.repeat(size), new_string: '\x01'.repeat(size) }],
          ['patch', { changes: Array.from({ length: 3 }, (_, index) => ({ file_path: `part-${index}.txt`, content: '\0'.repeat(size) })) }],
          ['write', { file_path: 'after.txt', content: 'still usable' }],
        ];
        const results = [];
        for (const [name, input] of cases) {
          const entry = server.tools.find((entry) => entry.name === name);
          results.push(await entry.handler(entry.schema.parse(input), {}));
        }
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: JSON.stringify(results) }] } };
        yield { type: 'result', subtype: 'success', is_error: false, permission_denials: [] };
        continue;
      }
      if (script === 'text') {
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: next.value.message.content }] } };
        yield { type: 'result', subtype: 'success', is_error: false, permission_denials: [] };
        continue;
      }
      if (script === 'budget') {
        // Reports the budget it was given, then ends the query the way the SDK does when a budget is spent.
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `budget ${options.maxBudgetUsd ?? 'none'}` }] } };
        const spent = options.maxBudgetUsd !== undefined;
        yield { type: 'result', subtype: spent ? 'error_max_budget_usd' : 'success', is_error: spent, permission_denials: [] };
        continue;
      }
      const bash = server.tools.find((entry) => entry.name === 'bash');
      const parsed = bash.schema.safeParse({ command: 'echo hi' });
      const result = await bash.handler(parsed.data, { _meta: { 'claudecode/toolUseId': 'toolu_1' } });
      const text = script === 'wire'
        ? createHash('sha256').update(next.value.message.content).update(result.content[0].text).digest('hex')
        : `tool said: ${result.content[0].text}`;
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } };
      yield { type: 'result', subtype: 'success', is_error: false, permission_denials: [] };
    }
  }
  const iterator = messages();
  return Object.assign(iterator, {
    async initializationResult() { return {}; },
    async mcpServerStatus() {
      if (script === 'no-server') return [];
      return [{ name: 'agenai', status: 'connected', tools: server.tools.map((entry) => ({ name: entry.name })) }];
    },
    async interrupt() { interrupted?.(); },
    close() {
      closed = true;
      release();
    },
  });
}
