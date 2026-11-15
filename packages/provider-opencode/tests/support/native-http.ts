// ------------------------------------------------------------------------------------------------
//                native-http.ts - A loopback OpenCode session API read through the pinned client and event parser
// ------------------------------------------------------------------------------------------------

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type test from 'node:test';
import { createNativeClient } from '../../src/node/client.js';
import { classifyNativeEvent } from '../../src/node/native-events.js';
import type { NativeSession, NativeSignal } from '../../src/node/native.js';
import { NATIVE_SESSION } from './session.js';

/** One `session.get` answer: a session record, a dropped connection, or no answer at all. */
export type Readback = Readonly<{ session: unknown }> | Readonly<{ body: string; contentType: string }> | 'drop' | 'hang';
export const tokens = (input: number, output: number, reasoning: number, read: number, write: number) =>
  ({ input, output, reasoning, cache: { read, write } });
export const sessionRecord = (value: ReturnType<typeof tokens>, id = NATIVE_SESSION) =>
  ({ id, title: 'AgenAI session', cost: 0, tokens: value, agent: 'build', time: { created: 1 } });

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

/**
 * Serves the event stream, prompts, interrupts, saved grants and readback of one native session.
 * Tests script native events from `onPrompt` and `onInterrupt`; `delivered` waits until the session
 * received every event written so far.
 */
export async function loopbackNative(t: test.TestContext) {
  let stream: ServerResponse | undefined;
  const opened = Promise.withResolvers<void>();
  const control = {
    prompts: 0,
    interrupts: 0,
    reads: 0,
    onPrompt: (_count: number) => {},
    onInterrupt: () => {},
    readback: (_count: number): Readback | Promise<Readback> => 'drop',
  };
  let sent = 0;
  let received = 0;
  const waiters: Array<() => void> = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://loopback').pathname;
    if (path === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      stream = response;
      opened.resolve();
      return;
    }
    request.resume();
    request.on('end', () => {
      if (path === `/api/session/${NATIVE_SESSION}/prompt`) {
        control.prompts += 1;
        json(response, 200, { data: { id: `inb_${control.prompts}` } });
        control.onPrompt(control.prompts);
      } else if (path === `/api/session/${NATIVE_SESSION}/interrupt`) {
        control.interrupts += 1;
        json(response, 200, { interrupted: true });
        control.onInterrupt();
      } else if (path === '/api/permission/saved') json(response, 200, { data: [] });
      else if (path === `/api/session/${NATIVE_SESSION}`) {
        control.reads += 1;
        void Promise.resolve(control.readback(control.reads)).then((answer) => {
          if (answer === 'drop') response.destroy();
          else if (answer !== 'hang') {
            if ('session' in answer) json(response, 200, { data: answer.session });
            else { response.writeHead(200, { 'content-type': answer.contentType }); response.end(answer.body); }
          }
        });
      } else json(response, 404, { message: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const lifetime = new AbortController();
  const client = createNativeClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'password', lifetime.signal);
  let listener: ((signal: NativeSignal) => void) | undefined;
  const backlog: NativeSignal[] = [];
  const deliver = (signal: NativeSignal) => {
    if (listener) listener(signal); else backlog.push(signal);
    if (signal.type === 'event') received += 1;
    if (received >= sent) for (const wake of waiters.splice(0)) wake();
  };
  const pump = (async () => {
    try {
      for await (const raw of client.events(lifetime.signal)) {
        try { deliver({ type: 'event', event: classifyNativeEvent(raw, NATIVE_SESSION) }); } catch (error) {
          deliver({ type: 'failed', reason: (error as Error).message });
          return;
        }
      }
      deliver({ type: 'failed', reason: 'The native event stream ended.' });
    } catch {
      if (!lifetime.signal.aborted) deliver({ type: 'failed', reason: 'The native event stream failed.' });
    }
  })();
  await opened.promise;
  const close = async () => {
    lifetime.abort();
    await pump;
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  };
  t.after(close);
  const native: NativeSession = {
    sessionID: NATIVE_SESSION,
    listen(next) { listener = next; for (const signal of backlog.splice(0)) next(signal); },
    prompt: (text) => client.prompt(NATIVE_SESSION, text),
    readSession: () => client.readSession(NATIVE_SESSION, 5_000),
    interrupt: () => client.interrupt(NATIVE_SESSION),
    rejectPermission: () => Promise.reject(new Error('unused')),
    cancelForm: () => Promise.reject(new Error('unused')),
    savedGrants: () => client.savedGrants(),
    reply() {},
    close,
  };
  return {
    native,
    control,
    /** Writes one native event as OpenCode frames it on the stream. */
    send(type: string, data: Record<string, unknown>) {
      sent += 1;
      stream!.write(`data: ${JSON.stringify({ id: `evt_${sent}`, created: sent, type, data: { sessionID: NATIVE_SESSION, ...data } })}\n\n`);
    },
    /** Ends the event stream, as a lost native server would. */
    endStream() { stream!.end(); },
    delivered(): Promise<void> {
      if (received >= sent) return Promise.resolve();
      return new Promise((resolve) => { waiters.push(resolve); });
    },
  };
}
