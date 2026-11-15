// ------------------------------------------------------------------------------------------------
//                worker.ts - The SDK host process: one Claude query whose only tools are owned tools
// ------------------------------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'node:child_process';
import { chunkAgentCanonicalText } from '@agen-ai/agent-runtime';
import { z } from 'zod/v4';
import {
  boundedLines, configureMessage, driverMessage, encodeLine, MCP_SERVER, MODEL_USAGE_ROWS, parseLine, TOOL_CALL_BYTES, type ConfigureMessage,
  type NativeCount, type NativeModelUsage, type NativeTurnUsage, type WorkerMessage,
} from './protocol.js';
import { toolCallBytes } from './toolInput.js';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');
type UserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;
type ToolResult = Readonly<{ text: string; isError: boolean }>;

/** Native names whose calls dispatch to the owned server instead of the disabled built-ins. */
const ALIASES = Object.freeze({ Bash: 'bash', Write: 'write', Edit: 'edit', Read: 'read', Glob: 'glob', Grep: 'grep' } as const);
const qualified = (name: string) => `mcp__${MCP_SERVER}__${name}`;

const emit = (message: WorkerMessage) => { process.stdout.write(encodeLine(message)); };
const clip = (value: unknown, max: number) => String(value).slice(0, max);
/** Bounded like `clip`, but a shortened model id ends in a character a configured model id cannot contain, so it never matches one. */
const modelId = (value: unknown) => { const text = String(value); return text.length <= 256 ? text : `${text.slice(0, 255)}…`; };

// Native usage is reduced here to its allowlisted counters; the session decides what they mean.
type NativeRecord = Readonly<Record<string, unknown>>;
const absent = (value: unknown): value is null | undefined => value === undefined || value === null;
const record = (value: unknown): NativeRecord | null | 'invalid' =>
  absent(value) ? null : typeof value === 'object' && !Array.isArray(value) ? value as NativeRecord : 'invalid';
const count = (value: unknown): NativeCount =>
  absent(value) ? null : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 'invalid';
const field = (source: NativeRecord | null | 'invalid', name: string): NativeCount =>
  source === null ? null : source === 'invalid' ? 'invalid' : count(source[name]);

function turnUsage(value: unknown): NativeTurnUsage {
  const usage = record(value);
  if (usage === null || usage === 'invalid') return usage;
  const split = record(usage.cache_creation);
  return {
    input: count(usage.input_tokens), cacheRead: count(usage.cache_read_input_tokens), cacheCreation: count(usage.cache_creation_input_tokens),
    cache5m: field(split, 'ephemeral_5m_input_tokens'), cache1h: field(split, 'ephemeral_1h_input_tokens'), output: count(usage.output_tokens),
  };
}

function modelUsage(value: unknown): NativeModelUsage {
  const models = record(value);
  if (models === null || models === 'invalid') return models;
  const entries = Object.entries(models);
  return {
    entries: entries.length,
    models: entries.slice(0, MODEL_USAGE_ROWS).map(([model, entry]) => {
      const usage = record(entry) ?? 'invalid';
      return {
        model: modelId(model), input: field(usage, 'inputTokens'), cacheRead: field(usage, 'cacheReadInputTokens'),
        cacheCreation: field(usage, 'cacheCreationInputTokens'), cache5m: field(usage, 'cacheCreationEphemeral5mInputTokens'),
        cache1h: field(usage, 'cacheCreationEphemeral1hInputTokens'), output: field(usage, 'outputTokens'),
      };
    }),
  };
}

/** A single-slot prompt source: the driver admits one prompt per idle turn, so nothing queues. */
function promptSource() {
  let waiting: ((message: IteratorResult<UserMessage>) => void) | undefined;
  let held: UserMessage | undefined;
  let ended = false;
  return {
    push(text: string) {
      const message: UserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as UserMessage;
      if (waiting) { const deliver = waiting; waiting = undefined; deliver({ value: message, done: false }); }
      else if (held || ended) throw new Error('A prompt is already pending.');
      else held = message;
    },
    end() { ended = true; waiting?.({ value: undefined, done: true }); waiting = undefined; },
    iterable: { [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<UserMessage>>((resolve) => {
        if (held) { const message = held; held = undefined; resolve({ value: message, done: false }); }
        else if (ended) resolve({ value: undefined, done: true });
        else waiting = resolve;
      }),
      return: async () => ({ value: undefined, done: true as const }),
    }) } as AsyncIterable<UserMessage>,
  };
}

function ownedServer(sdk: Sdk, configure: ConfigureMessage, call: (tool: string, input: unknown, nativeRef: string | null) => Promise<ToolResult>) {
  const tools = configure.tools.map((definition) => {
    const schema = z.fromJSONSchema(definition.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    if (!(schema instanceof z.ZodObject)) throw new Error(`Owned tool ${definition.name} has no object input schema.`);
    // The SDK accepts a complete object schema here, which keeps undeclared fields refused before dispatch.
    return sdk.tool(definition.name, definition.description, schema as unknown as z.ZodRawShape, async (args: unknown, extra: unknown) => {
      const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
      const reference = typeof meta?.['claudecode/toolUseId'] === 'string' ? clip(meta['claudecode/toolUseId'], 128) : null;
      const result = await call(definition.name, args, reference);
      return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
    }, { alwaysLoad: true });
  });
  return sdk.createSdkMcpServer({ name: MCP_SERVER, version: '1.0.0', tools });
}

async function main(): Promise<void> {
  const lines = boundedLines(process.stdin)[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) return;
  const configure = parseLine(configureMessage, first.value);
  const sdk = await import(configure.sdkEntry) as Sdk;
  const owned = configure.tools.map((tool) => qualified(tool.name));
  const pending = new Map<string, (result: ToolResult) => void>();
  let pendingBytes = 0;
  const children: Promise<Readonly<{ code: number | null; signal: string | null }>>[] = [];
  const prompts = promptSource();
  const abortController = new AbortController();
  let sequence = 0;
  let closing = false;
  let ready = false;

  const call = (tool: string, input: unknown, nativeRef: string | null) => new Promise<ToolResult>((resolve) => {
    if (closing) { resolve({ text: 'The session is closing; the tool did not run.', isError: true }); return; }
    sequence += 1;
    const callId = `call-${sequence}`;
    const message: WorkerMessage = { type: 'tool_call', callId, tool, input: input ?? {}, nativeRef };
    let bytes: number;
    let line: string;
    try {
      if (pending.size >= 64) throw new RangeError('Owned tool input queue is full; wait for pending calls to settle.');
      bytes = toolCallBytes(message, TOOL_CALL_BYTES - pendingBytes);
      line = encodeLine(message, TOOL_CALL_BYTES);
    } catch (cause) {
      resolve({ text: cause instanceof RangeError ? cause.message : 'Owned tool input could not be encoded; the tool did not run.', isError: true });
      return;
    }
    pendingBytes += bytes;
    pending.set(callId, (result) => { pendingBytes -= bytes; resolve(result); });
    try { process.stdout.write(line); } catch {
      pending.get(callId)!({ text: 'The worker output is unavailable; the tool did not run.', isError: true });
      pending.delete(callId);
    }
  });
  const spawnClaude = (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }): ChildProcess => {
    if (options.command !== configure.executable) throw new Error('The SDK selected an executable other than the verified Claude Code binary.');
    // The worker's own environment is driver-composed, so the SDK-merged environment carries no ambient values.
    const child = spawn(options.command, options.args, { cwd: configure.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(new Promise((resolve) => { child.once('close', (code, signal) => resolve({ code, signal })); }));
    return child;
  };

  const query = sdk.query({
    prompt: prompts.iterable,
    options: {
      abortController, cwd: configure.cwd, env: { ...configure.environment }, model: configure.model, maxTurns: configure.maxTurns,
      ...(configure.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: configure.maxBudgetUsd }),
      pathToClaudeCodeExecutable: configure.executable, persistSession: false, plugins: [], settingSources: [], strictMcpConfig: true,
      settings: { disableAllHooks: true, permissions: { disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable' } } as never,
      tools: [], disallowedTools: [...sdk.BUILTIN_TOOL_NAMES], toolAliases: Object.fromEntries(Object.entries(ALIASES).map(([alias, name]) => [alias, qualified(name)])),
      mcpServers: { [MCP_SERVER]: ownedServer(sdk, configure, call) }, allowedTools: owned, permissionMode: 'default',
      async canUseTool(toolName: string) {
        emit({ type: 'residual', tool: clip(toolName, 128) });
        return { behavior: 'deny' as const, message: 'Only host-owned tools are available.' };
      },
      spawnClaudeCodeProcess: spawnClaude as never,
      stderr() {},
    } as never,
  });

  let failure: string | undefined;
  const control = (async () => {
    try {
      for await (const line of { [Symbol.asyncIterator]: () => lines }) {
        const message = parseLine(driverMessage, line);
        if (message.type === 'prompt') prompts.push(message.text);
        else if (message.type === 'tool_result') {
          const resolve = pending.get(message.callId);
          pending.delete(message.callId);
          resolve?.({ text: message.text, isError: message.isError });
        } else if (message.type === 'interrupt') void query.interrupt().catch(() => {});
        else break;
      }
    } catch (cause) {
      failure ??= clip(cause instanceof Error ? `Driver input failed: ${cause.message}` : cause, 1_000);
    }
    closing = true;
    prompts.end();
    query.close();
  })();

  try {
    await query.initializationResult();
    const status = await query.mcpServerStatus();
    const server = status.find((entry) => entry.name === MCP_SERVER);
    const listed = (server?.tools ?? []).map((tool) => qualified(tool.name)).sort();
    if (status.length !== 1 || server?.status !== 'connected' || JSON.stringify(listed) !== JSON.stringify([...owned].sort())) {
      throw new Error(`Owned tool server is not exactly connected (${status.map((entry) => `${entry.name}:${entry.status}`).join(',')}).`);
    }
    ready = true;
    emit({ type: 'ready', tools: listed, claudeCodeVersion: null });
    for await (const message of query) {
      if (message.type === 'system' && message.subtype === 'init') {
        emit({ type: 'init', tools: message.tools.slice(0, 256).map((tool) => clip(tool, 128)), model: modelId(message.model),
          permissionMode: clip(message.permissionMode, 64), claudeCodeVersion: clip(message.claude_code_version, 64) });
      } else if (message.type === 'system' && message.subtype === 'status') {
        if (message.permissionMode !== undefined) emit({ type: 'status', permissionMode: clip(message.permissionMode, 64) });
      } else if (message.type === 'system' && message.subtype === 'model_refusal_fallback') {
        emit({ type: 'model_fallback', model: modelId(message.fallback_model) });
      } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        for (const block of message.message.content) if (block.type === 'text' && block.text) {
          const chunks = chunkAgentCanonicalText(block.text);
          for (const [index, text] of chunks.entries()) emit({ type: 'assistant_text', text, complete: index === chunks.length - 1 });
        }
      } else if (message.type === 'result') {
        emit({ type: 'result', subtype: clip(message.subtype, 64), isError: message.is_error,
          denials: (message.permission_denials ?? []).slice(0, 64).map((denial) => clip(denial.tool_name, 128)),
          resultIndex: count(message.result_index), usage: turnUsage(message.usage), modelUsage: modelUsage(message.modelUsage) });
      }
    }
    if (!closing) failure ??= 'Claude Code stopped without a close request.';
  } catch (cause) {
    if (!closing) failure ??= clip(cause instanceof Error ? cause.message : cause, 1_000);
  } finally {
    closing = true;
    for (const resolve of pending.values()) resolve({ text: 'The session closed before the tool settled.', isError: true });
    pending.clear();
    prompts.end();
    query.close();
  }
  if (failure !== undefined) emit({ type: 'failed', stage: ready ? 'runtime' : 'startup', message: failure });
  await control.catch(() => {});
  emit({ type: 'closed', children: await Promise.all(children) });
}

main().catch((cause: unknown) => {
  try { emit({ type: 'failed', stage: 'startup', message: clip(cause instanceof Error ? cause.message : cause, 1_000) }); } catch { /* stdout gone */ }
  process.exitCode = 1;
});
