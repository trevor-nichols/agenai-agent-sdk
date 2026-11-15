// ------------------------------------------------------------------------------------------------
//                plugin.ts - The packaged OpenCode plugin: exclusive owned tools forwarded to the broker
// ------------------------------------------------------------------------------------------------

// Loaded by the pinned OpenCode runtime from a private read-only copy. It imports only Node
// built-ins, performs no effect itself and forwards each owned tool call to the driver's endpoint.

import { connect, type Socket } from 'node:net';

const TOOL_NAMES = ['read', 'glob', 'grep', 'write', 'edit', 'patch', 'bash'] as const;
const OWNED = TOOL_NAMES.map((name) => `agenai_${name}`);
const OWNED_PERMISSION = 'agenai.tool';
const NATIVE_VERSION = '2.2.7';
const CALL_FRAME_BYTES = 16 * 1024 * 1024;
const REPLY_FRAME_BYTES = 1024 * 1024;
const PENDING_CALLS = 64;
const MAX_OUTPUT_TOKENS = 256_000;
/** Every session hook whose event carries the options of one model request, titles included. */
const REQUEST_HOOKS = ['context', 'compaction', 'generate', 'title'] as const;
const RULES = [{ action: '*', resource: '*', effect: 'deny' }, { action: OWNED_PERMISSION, resource: '*', effect: 'allow' }];

interface Definition { readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }
interface Options {
  readonly port: number; readonly token: string; readonly nonce: string; readonly provider: string; readonly tools: readonly Definition[];
  readonly maxOutputTokens?: number;
}
interface SessionEvent { decision?: unknown; options?: Record<string, unknown> }
interface CallIdentity { readonly sessionID: string; readonly messageID: string; readonly id: string }
interface ToolContext extends CallIdentity { readonly signal: AbortSignal }
/** OpenCode passes `execute.before` the model's input as received, before decoding it against the tool schema. */
interface ToolEvent extends CallIdentity { readonly tool: string; readonly input: unknown }
interface ToolEditor {
  list(): ReadonlyArray<{ id: string }>;
  remove(id: string): void;
  add(tool: { name: string; description: string; input: unknown; options: unknown; execute(input: unknown, context: ToolContext): Promise<unknown> }): void;
}
/** The subset of the OpenCode 2.2.7 plugin context this plugin uses; anything missing refuses setup. */
interface PluginContext {
  readonly app: { readonly version: string };
  readonly options: unknown;
  readonly tool: {
    transform(edit: (editor: ToolEditor) => void): Promise<void>;
    list(): Promise<ReadonlyArray<{ id: string }>>;
    hook(name: 'execute.before' | 'execute.after', run: (event: ToolEvent) => void): Promise<void>;
  };
  readonly provider: { transform(edit: (editor: { list(): ReadonlyArray<{ provider: { id: string } }>; remove(id: string): void }) => void): Promise<void> };
  readonly mcp: { transform(edit: (editor: { list(): ReadonlyArray<readonly [string, unknown]>; remove(name: string): void }) => void): Promise<void> };
  readonly skill: { transform(edit: (editor: { list(): ReadonlyArray<{ id: unknown }>; remove(id: string): void }) => void): Promise<void> };
  readonly agent: { transform(edit: (editor: { list(): ReadonlyArray<{ id: unknown }>; update(id: string, change: (value: { permissions: unknown }) => void): void }) => void): Promise<void> };
  readonly permission: { hook(name: 'evaluate', run: (event: { action: string; effect: string; message?: string }) => void): Promise<void> };
  readonly session: { hook(name: string, run: (event: SessionEvent) => void): Promise<void> };
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function parseLink(value: unknown): Pick<Options, 'port' | 'token'> {
  const options = value as Partial<Options> | null;
  const port = options?.port;
  if (!options || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535 || !text(options.token, 256)) {
    throw new Error('The AgenAI tool plugin has no broker endpoint.');
  }
  return { port, token: options.token };
}

function parseOptions(value: unknown): Options {
  const options = value as Partial<Options>;
  const tools = options.tools;
  if (!text(options.nonce, 256) || !text(options.provider, 64) || !Array.isArray(tools) || tools.length !== TOOL_NAMES.length
    || tools.some((tool, index) => tool?.name !== TOOL_NAMES[index] || !text(tool.description, 4_096) || !tool.inputSchema || typeof tool.inputSchema !== 'object')
    || options.maxOutputTokens !== undefined && !(Number.isInteger(options.maxOutputTokens) && options.maxOutputTokens >= 1
      && options.maxOutputTokens <= MAX_OUTPUT_TOKENS)) {
    throw new Error('The AgenAI tool plugin options are invalid.');
  }
  return options as Options;
}

/** One authenticated driver connection carrying newline-delimited bounded JSON frames. */
function link(socket: Socket) {
  const pending = new Map<number, (reply: { text: string; isError: boolean }) => void>();
  let buffer = '';
  let closed = false;
  let next = 0;
  const fail = () => {
    closed = true;
    for (const resolve of pending.values()) resolve({ text: 'Tool call failed: the AgenAI broker is unavailable.', isError: true });
    pending.clear();
    socket.destroy();
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > REPLY_FRAME_BYTES) { fail(); return; }
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let reply: { type?: unknown; id?: unknown; text?: unknown; isError?: unknown };
      try { reply = JSON.parse(line); } catch { fail(); return; }
      const resolve = typeof reply.id === 'number' ? pending.get(reply.id) : undefined;
      if (reply.type !== 'result' || !resolve || typeof reply.text !== 'string' || typeof reply.isError !== 'boolean') { fail(); return; }
      pending.delete(reply.id as number);
      resolve({ text: reply.text, isError: reply.isError });
    }
  });
  socket.on('error', fail);
  socket.on('close', fail);
  const send = (frame: unknown) => { if (!closed) socket.write(`${JSON.stringify(frame)}\n`); };
  return {
    send,
    call(tool: string, input: unknown, context: ToolContext): Promise<{ text: string; isError: boolean }> {
      if (closed) return Promise.resolve({ text: 'Tool call failed: the AgenAI broker is unavailable.', isError: true });
      if (pending.size >= PENDING_CALLS) return Promise.resolve({ text: 'Tool call refused: too many calls are pending.', isError: true });
      const id = ++next;
      const frame = JSON.stringify({ type: 'call', id, tool, input, sessionID: context.sessionID, messageID: context.messageID, callID: context.id });
      if (Buffer.byteLength(frame) > CALL_FRAME_BYTES) return Promise.resolve({ text: 'Tool call refused: the input exceeds the transport bound.', isError: true });
      return new Promise((resolve) => {
        const cancel = () => send({ type: 'cancel', id });
        pending.set(id, (reply) => { context.signal.removeEventListener('abort', cancel); resolve(reply); });
        socket.write(`${frame}\n`);
        if (context.signal.aborted) cancel();
        else context.signal.addEventListener('abort', cancel, { once: true });
      });
    },
    close() { closed = true; socket.end(); },
  };
}

class Refusal extends Error {
  constructor(readonly reason: 'version' | 'inventory') {
    super(reason);
  }
}

/** Locks the native surface, replaces the complete tool inventory and acknowledges readiness last. */
async function register(ctx: PluginContext, options: Options, broker: ReturnType<typeof link>): Promise<void> {
  if (ctx.app?.version !== NATIVE_VERSION) throw new Refusal('version');
  await ctx.provider.transform((editor) => {
    for (const entry of editor.list()) if (entry.provider.id !== options.provider) editor.remove(entry.provider.id);
  });
  await ctx.mcp.transform((editor) => { for (const [name] of editor.list()) editor.remove(name); });
  await ctx.skill.transform((editor) => { for (const skill of editor.list()) editor.remove(String(skill.id)); });
  await ctx.agent.transform((editor) => {
    for (const agent of editor.list()) editor.update(String(agent.id), (value) => { value.permissions = RULES.map((rule) => ({ ...rule })); });
  });
  await ctx.permission.hook('evaluate', (event) => {
    if (event.action !== OWNED_PERMISSION) { event.effect = 'deny'; event.message = 'Only AgenAI-owned tools are available.'; }
  });
  await ctx.session.hook('retry', (event) => { event.decision = { retry: false }; });
  await ctx.session.hook('experimental.ws.handshake', () => { throw new Error('AgenAI requires HTTP model dispatch.'); });
  const bound = options.maxOutputTokens;
  if (bound !== undefined) {
    for (const name of REQUEST_HOOKS) {
      await ctx.session.hook(name, (event) => {
        const requested = event.options?.maxTokens;
        event.options = { ...event.options, maxTokens: typeof requested === 'number' && requested >= 1 ? Math.min(requested, bound) : bound };
      });
    }
  }
  // OpenCode drops undeclared fields before `execute`; the broker must judge the complete original request.
  const observed = new Map<string, unknown>();
  const key = (call: CallIdentity) => `${call.sessionID}\u0000${call.messageID}\u0000${call.id}`;
  await ctx.tool.hook('execute.before', (event) => {
    if (!OWNED.includes(event.tool)) throw new Error('Only AgenAI-owned tools are available.');
    if (observed.size >= PENDING_CALLS) observed.delete(observed.keys().next().value!);
    observed.set(key(event), event.input);
  });
  await ctx.tool.hook('execute.after', (event) => { observed.delete(key(event)); });
  await ctx.tool.transform((editor) => {
    for (const existing of editor.list()) editor.remove(existing.id);
    for (const definition of options.tools) {
      editor.add({
        name: `agenai_${definition.name}`, description: definition.description, input: definition.inputSchema,
        options: { codemode: false, permission: OWNED_PERMISSION },
        async execute(_decoded, context) {
          const id = key(context);
          if (!observed.has(id)) throw new Error('Tool call refused: its complete input was not observed.');
          const input = observed.get(id);
          observed.delete(id);
          const reply = await broker.call(definition.name, input, context);
          if (reply.isError) throw new Error(reply.text);
          return { content: reply.text };
        },
      });
    }
  });
  const inventory = (await ctx.tool.list()).map((tool) => tool.id).sort();
  const expected = [...OWNED].sort();
  if (inventory.length !== expected.length || inventory.some((id, index) => id !== expected[index])) throw new Refusal('inventory');
  broker.send({ type: 'ready', token: options.token, nonce: options.nonce, tools: inventory });
}

export default {
  id: 'agenai.owned-tools',
  async setup(ctx: PluginContext) {
    const endpoint = parseLink(ctx.options);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const opened = connect({ host: '127.0.0.1', port: endpoint.port }, () => resolve(opened));
      opened.once('error', reject);
    });
    const broker = link(socket);
    try {
      await register(ctx, parseOptions(ctx.options), broker);
    } catch (error) {
      const reason = error instanceof Refusal ? error.reason : 'setup';
      broker.send({ type: 'refused', token: endpoint.token, reason });
      broker.close();
      throw new Error(`The AgenAI tool plugin refused setup: ${reason}.`, { cause: error });
    }
    return async () => { broker.close(); };
  },
};
