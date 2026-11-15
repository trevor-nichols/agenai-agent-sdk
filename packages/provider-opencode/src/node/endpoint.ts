// ------------------------------------------------------------------------------------------------
//                endpoint.ts - The private broker endpoint: one authenticated plugin connection
// ------------------------------------------------------------------------------------------------

import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { NODE_PROVIDER_TOOL_NAMES } from '@agen-ai/provider-tools';
import { z } from 'zod/v4';
import { NativeFailure } from './errors.js';

/** Serialized plugin-call ceiling, separate from per-file limits; the native event allowance includes canonical echoes of it. */
export const CALL_FRAME_BYTES = 16 * 1024 * 1024;
const BACKLOG = 64;

const nativeId = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/u);
const authentication = z.string().min(1).max(256);
const opening = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), token: authentication, nonce: authentication, tools: z.array(z.string().max(64)).max(16) }),
  z.strictObject({ type: z.literal('refused'), token: authentication, reason: z.enum(['version', 'inventory', 'setup']) }),
]);
const frame = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('call'), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), tool: z.enum(NODE_PROVIDER_TOOL_NAMES),
    input: z.record(z.string(), z.unknown()), sessionID: nativeId, messageID: nativeId, callID: nativeId,
  }),
  z.strictObject({ type: z.literal('cancel'), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
]);

export type PluginCall = Readonly<Omit<Extract<z.infer<typeof frame>, { type: 'call' }>, 'type'>>;
export type EndpointSignal =
  | Readonly<{ type: 'call'; call: PluginCall }>
  | Readonly<{ type: 'cancel'; id: number }>
  | Readonly<{ type: 'failed'; reason: string }>;

/**
 * The endpoint listens on loopback in the guest network namespace, which commands never share; a
 * filesystem socket would bound the caller's state path to the 107-byte `sun_path` limit.
 */
export interface PluginEndpoint {
  readonly port: number;
  /** Resolves once the authenticated plugin acknowledged the exact owned inventory with this session's nonce. */
  readonly ready: Promise<void>;
  /** The sole consumer of plugin frames after readiness; installed once. */
  listen(listener: (signal: EndpointSignal) => void): void;
  /** Answers one admitted call exactly once. */
  reply(id: number, result: Readonly<{ text: string; isError: boolean }>): void;
  /** Stops listening and closes the connection. Idempotent. */
  close(): Promise<void>;
}

const same = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Newline-delimited frames whose bytes before the newline never exceed the bound, however the transport
 * splits them; every segment is counted before it is buffered. Returns false once the bound is exceeded.
 */
function lineReader(onLine: (line: string) => void) {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  return (chunk: Buffer): boolean => {
    for (let start = 0; !exceeded;) {
      const index = chunk.indexOf(0x0a, start);
      const end = index === -1 ? chunk.length : index;
      bytes += end - start;
      if (bytes > CALL_FRAME_BYTES) { exceeded = true; break; }
      if (index === -1) {
        if (end > start) chunks.push(chunk.subarray(start));
        return true;
      }
      chunks.push(chunk.subarray(start, index));
      const line = Buffer.concat(chunks).toString('utf8');
      chunks = [];
      bytes = 0;
      start = index + 1;
      onLine(line);
    }
    chunks = [];
    return false;
  };
}

export async function openPluginEndpoint(input: Readonly<{ token: string; nonce: string; tools: readonly string[] }>): Promise<PluginEndpoint> {
  const expected = [...input.tools].sort();
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => undefined);
  let opened = false;
  let failed: string | undefined;
  let connection: Socket | undefined;
  let listener: ((signal: EndpointSignal) => void) | undefined;
  const backlog: EndpointSignal[] = [];
  const admitted = new Set<number>();
  let lastId = 0;

  const deliver = (signal: EndpointSignal) => {
    if (listener) { listener(signal); return; }
    if (backlog.length < BACKLOG) { backlog.push(signal); return; }
    fail('The plugin sent more frames than its bound before the session listened.');
  };
  const fail = (reason: string) => {
    if (failed !== undefined) return;
    failed = reason;
    connection?.destroy();
    if (opened) deliver({ type: 'failed', reason });
    else ready.reject(new NativeFailure('readiness', reason));
  };

  const onLine = (line: string) => {
    if (failed !== undefined) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { fail('The plugin sent a malformed frame.'); return; }
    if (!opened) {
      const parsed = opening.safeParse(value);
      if (!parsed.success || !same(parsed.data.token, input.token)) { fail('The plugin endpoint received an unauthenticated opening.'); return; }
      if (parsed.data.type === 'refused') { fail(`The plugin refused setup (${parsed.data.reason}).`); return; }
      const tools = [...parsed.data.tools].sort();
      if (!same(parsed.data.nonce, input.nonce) || tools.length !== expected.length || tools.some((tool, index) => tool !== expected[index])) {
        fail('The plugin readiness did not prove this session\'s exact owned inventory.');
        return;
      }
      opened = true;
      ready.resolve();
      return;
    }
    const parsed = frame.safeParse(value);
    if (!parsed.success) { fail('The plugin sent an invalid frame.'); return; }
    if (parsed.data.type === 'cancel') {
      if (parsed.data.id > lastId) { fail('The plugin canceled a call it never sent.'); return; }
      if (admitted.has(parsed.data.id)) deliver({ type: 'cancel', id: parsed.data.id });
      return;
    }
    const { type: _type, ...call } = parsed.data;
    if (call.id <= lastId) { fail('The plugin reused a call identity.'); return; }
    lastId = call.id;
    admitted.add(call.id);
    deliver({ type: 'call', call: Object.freeze(call) });
  };

  const server: Server = createServer({ allowHalfOpen: false }, (socket) => {
    if (connection) { socket.destroy(); fail('A second connection reached the private broker endpoint.'); return; }
    connection = socket;
    server.close();
    const read = lineReader(onLine);
    socket.on('data', (chunk: Buffer) => { if (!read(chunk)) fail('The plugin sent a frame larger than its bound.'); });
    socket.on('error', () => fail('The plugin connection failed.'));
    socket.on('close', () => fail('The plugin connection closed.'));
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new NativeFailure('startup', 'The private broker endpoint did not bind a loopback port.');

  let closing: Promise<void> | undefined;
  return Object.freeze<PluginEndpoint>({
    port: address.port,
    ready: ready.promise,
    listen(next) {
      if (listener) throw new Error('The plugin endpoint already has its owner.');
      listener = next;
      for (const signal of backlog.splice(0)) next(signal);
    },
    reply(id, result) {
      if (!admitted.delete(id)) throw new Error('The plugin call was already answered or never admitted.');
      if (failed === undefined && connection?.writable) connection.write(`${JSON.stringify({ type: 'result', id, text: result.text, isError: result.isError })}\n`);
    },
    close() {
      closing ??= (async () => {
        failed ??= 'The plugin endpoint closed.';
        connection?.destroy();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  });
}
