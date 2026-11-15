// ------------------------------------------------------------------------------------------------
//                client.ts - The exact OpenCode V2 client boundary: bounded transport, parsed responses
// ------------------------------------------------------------------------------------------------

import { ClientError, OpenCode } from '@opencode/client';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { z } from 'zod/v4';
import { NativeFailure } from './errors.js';
import { CALL_FRAME_BYTES } from './endpoint.js';

const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_BYTES = 4 * 1024 * 1024;
// Native events echo parsed inputs and JSON argument text. Canonical text can double in size when JSON-encoded again.
// This remains an independent raw-event cap: noncanonical argument text and provider metadata must fit it too.
const EVENT_BYTES = 2 * CALL_FRAME_BYTES + 65_536;

export type NativeRule = Readonly<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }>;
export type NativeSessionReadback = Readonly<{ kind: 'available'; session: unknown } | { kind: 'unavailable' }>;

const rule = z.object({ action: z.string(), resource: z.string(), effect: z.enum(['allow', 'deny', 'ask']) });
const info = z.object({ version: z.string() });
const session = z.object({
  id: z.string().min(1).max(256),
  agent: z.string().optional(),
  model: z.object({ id: z.string(), providerID: z.string() }).optional(),
  location: z.object({ directory: z.string() }),
  permissions: z.array(rule).optional(),
});
const sources = z.array(z.object({ type: z.string(), path: z.string().optional() }));
const agents = z.object({ data: z.array(z.object({ id: z.string(), permissions: z.array(rule) })) });
const saved = z.array(z.unknown());
const interrupted = z.object({ interrupted: z.boolean() });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NativeFailure('transport', `OpenCode returned an unexpected ${what}.`);
  return parsed.data;
}

/**
 * Counts every wire byte of each event, comments and line framing included, before the chunk reaches the
 * parser. Lines end with CRLF, LF or CR, and a blank line ends the event, as the OpenCode client parses them.
 */
function eventBound(): (chunk: Uint8Array) => void {
  let bytes = 0;
  let content = false;
  let cr = false;
  let ended = false;
  return (chunk) => {
    for (const byte of chunk) {
      // The LF of a CRLF belongs to the line its CR ended; any other byte after an event-ending CR starts the next event.
      const crlf = cr && byte === 0x0a;
      if (cr && !crlf && ended) bytes = 0;
      cr = false;
      bytes += 1;
      if (bytes > EVENT_BYTES) throw new NativeFailure('transport', 'An OpenCode event exceeded its bound.');
      if (crlf) {
        if (ended) bytes = 0;
        ended = false;
        continue;
      }
      ended = false;
      if (byte !== 0x0a && byte !== 0x0d) { content = true; continue; }
      const blank = !content;
      content = false;
      if (byte === 0x0d) { cr = true; ended = blank; } else if (blank) bytes = 0;
    }
  };
}

/** Rejects responses past their total bound and event streams past their per-event bound, before enqueueing. */
function bounded(body: ReadableStream<Uint8Array>, events: boolean): ReadableStream<Uint8Array> {
  let total = 0;
  const event = eventBound();
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (events) event(chunk);
      else {
        total += chunk.byteLength;
        if (total > RESPONSE_BYTES) throw new NativeFailure('capacity', 'An OpenCode response exceeded its bound.');
      }
      controller.enqueue(chunk);
    },
  }));
}

/** Pins every request to the announced loopback origin, refuses redirects and bounds every body. */
function boundedFetch(origin: string, lifetime: AbortSignal): typeof fetch {
  return async (resource, init) => {
    const request = new Request(resource, init);
    if (new URL(request.url).origin !== origin) throw new NativeFailure('transport', 'The OpenCode client addressed another origin.');
    const response = await fetch(request, { redirect: 'error', signal: AbortSignal.any([request.signal, lifetime]) });
    if (!response.body) return response;
    const events = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
    return new Response(bounded(response.body, events), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** The pinned client's SSE parser has an unconfigurable 16-MiB cap, below admitted argument echoes. */
async function* subscribeEvents(request: typeof fetch, origin: string, headers: HeadersInit, signal: AbortSignal): AsyncIterable<unknown> {
  const response = await request(new URL('/api/event', origin), { headers, signal });
  if (response.status !== 200 || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) {
    await response.body?.cancel();
    throw new NativeFailure('transport', 'OpenCode returned an unexpected event stream response.');
  }
  // The byte guard owns admission. The parser may retain a trailing CR and part of the next event together.
  const reader = response.body.pipeThrough(new TextDecoderStream('utf-8', { fatal: true }))
    .pipeThrough(new EventSourceParserStream()).getReader();
  try {
    while (true) {
      const event = await reader.read();
      if (event.done) return;
      if (event.value.data !== '') yield JSON.parse(event.value.data);
    }
  } catch (cause) {
    if (cause instanceof NativeFailure) throw cause;
    throw new NativeFailure('transport', 'The OpenCode event stream failed.', { cause });
  } finally {
    // A failed/aborted stream also rejects cancellation; preserve the original transport failure.
    try { await reader.cancel(); } catch { /* Already failed. */ }
    reader.releaseLock();
  }
}

export interface NativeClient {
  info(): Promise<Readonly<{ version: string }>>;
  createSession(input: Readonly<{ directory: string; agent: string; providerID: string; model: string; permissions: readonly NativeRule[] }>): Promise<z.infer<typeof session>>;
  /** Materializes the location, which loads configured plugins. */
  loadLocation(directory: string): Promise<void>;
  configSources(directory: string): Promise<z.infer<typeof sources>>;
  agents(directory: string): Promise<z.infer<typeof agents>['data']>;
  savedGrants(): Promise<number>;
  prompt(sessionID: string, text: string): Promise<void>;
  /** The raw session record; its usage contract is judged by the caller. */
  readSession(sessionID: string, timeoutMs: number): Promise<NativeSessionReadback>;
  interrupt(sessionID: string): Promise<boolean>;
  rejectPermission(sessionID: string, requestID: string): Promise<void>;
  cancelForm(sessionID: string, formID: string): Promise<void>;
  /** One native event subscription; it ends or throws on loss and is never reconnected. */
  events(signal: AbortSignal): AsyncIterable<unknown>;
}

export function createNativeClient(url: string, password: string, lifetime: AbortSignal): NativeClient {
  const origin = new URL(url).origin;
  const request = boundedFetch(origin, lifetime);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  const client = OpenCode.make({
    baseUrl: origin,
    fetch: request,
    headers,
  });
  const options = () => ({ signal: AbortSignal.any([lifetime, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
  const call = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (cause) {
      if (cause instanceof NativeFailure) throw cause;
      throw new NativeFailure('transport', `The OpenCode ${what} request failed.`, { cause });
    }
  };
  return Object.freeze<NativeClient>({
    info: () => call('server info', async () => parse(info, await client.server.info(options()), 'server identity')),
    createSession: (input) => call('session creation', async () => parse(session, await client.session.create({
      title: 'AgenAI session', agent: input.agent, location: { directory: input.directory },
      model: { id: input.model, providerID: input.providerID }, permissions: input.permissions.map((entry) => ({ ...entry })),
    }, options()), 'session')),
    loadLocation: (directory) => call('location', async () => { await client.location.get({ location: { directory } }, options()); }),
    configSources: (directory) => call('configuration', async () => parse(sources, await client.config.get({ location: { directory } }, options()), 'configuration')),
    agents: async (directory) => (await call('agent list', async () => parse(agents, await client.agent.list({ location: { directory } }, options()), 'agent list'))).data,
    savedGrants: () => call('saved permission', async () => parse(saved, await client.permission.saved.list({}, options()), 'saved permission list').length),
    prompt: (sessionID, text) => call('prompt', async () => { await client.session.prompt({ sessionID, text }, options()); }),
    readSession: (sessionID, timeoutMs) => call('session readback', async () => {
      try {
        const session = await client.session.get({ sessionID }, { signal: AbortSignal.any([lifetime, AbortSignal.timeout(timeoutMs)]) });
        return { kind: 'available', session };
      } catch (cause) {
        if (cause instanceof ClientError && cause.reason === 'Transport') {
          // The client wraps both network loss and our body-bound guard. Only network loss is optional absence.
          if (cause.cause instanceof NativeFailure) throw cause.cause;
          return { kind: 'unavailable' };
        }
        throw cause;
      }
    }),
    interrupt: (sessionID) => call('interrupt', async () => parse(interrupted, await client.session.interrupt({ sessionID }, options()), 'interrupt receipt').interrupted),
    rejectPermission: (sessionID, requestID) => call('permission reply', () => client.permission.reply({ sessionID, requestID, decision: 'reject' }, options())),
    cancelForm: (sessionID, formID) => call('form cancel', () => client.session.form.cancel({ sessionID, formID }, options())),
    events: (signal) => subscribeEvents(request, origin, headers, AbortSignal.any([lifetime, signal])),
  });
}
