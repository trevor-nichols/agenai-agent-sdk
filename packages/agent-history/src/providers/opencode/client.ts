import { AgentHistoryError } from '../../lifecycle/errors.js';
import type { OpenCodeHistoryClient } from './contracts.js';
import { assertOpenCodeClientIdentity } from './identity.js';
import { OPENCODE_RESPONSE_BYTES } from './native.js';
import type { ResolvedOpenCodeHistoryOptions } from './options.js';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nativeError(error: unknown): AgentHistoryError {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof AgentHistoryError) return current;
    if (!object(current)) break;
    switch (current._tag) {
      case 'UnauthorizedError': case 'ForbiddenError': return new AgentHistoryError('access_denied', 'OpenCode server access was denied.');
      case 'SessionNotFoundError': case 'MessageNotFoundError': return new AgentHistoryError('not_found', 'OpenCode saved history is missing or unavailable.');
      case 'InvalidCursorError': return new AgentHistoryError('invalid_cursor', 'OpenCode rejected the native history continuation.');
      case 'InvalidRequestError': return new AgentHistoryError('invalid_input', 'OpenCode rejected the history request.');
      case 'ProjectNotFoundError': case 'LocationNotFoundError': return new AgentHistoryError('unsupported_scope', 'OpenCode cannot access the selected project scope.');
    }
    if (current.reason === 'UnexpectedStatus' && object(current.cause)) {
      if (current.cause.status === 401 || current.cause.status === 403) return new AgentHistoryError('access_denied', 'OpenCode server access was denied.');
      if ([404, 405, 501].includes(Number(current.cause.status))) return new AgentHistoryError('unsupported_scope', 'The supplied OpenCode server does not provide this history operation.');
    }
    current = current.cause;
  }
  return new AgentHistoryError('native_failure', 'The OpenCode server could not complete the history request.');
}

function boundedFetch(baseUrl: string, mutation?: Readonly<{ method: 'PATCH' | 'DELETE'; sessionID: string; dispatch: () => void }>): typeof globalThis.fetch {
  const base = new URL(baseUrl);
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const path = url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : '';
    const method = init?.method ?? 'GET';
    const read = mutation === undefined && method === 'GET' && init?.body == null
      && /^(?:api\/info|api\/session(?:\/[^/]+(?:\/message)?)?)$/u.test(path);
    const write = mutation !== undefined && method === mutation.method && path === `api/session/${encodeURIComponent(mutation.sessionID)}`
      && (method === 'DELETE' ? init?.body == null : typeof init?.body === 'string');
    if (url.origin !== base.origin || (!read && !write)) {
      throw new AgentHistoryError('unsupported_scope', 'OpenCode history requests must stay within the selected native history operation.');
    }
    const headers = new Headers(init?.headers);
    let requestBytes = Buffer.byteLength(url.href);
    if (typeof init?.body === 'string') requestBytes += Buffer.byteLength(init.body);
    for (const [key, value] of headers) requestBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (requestBytes > 32_768) throw new AgentHistoryError('limit_exhausted', 'OpenCode history request exceeds its input budget.');
    const controller = new AbortController();
    const signal = init?.signal == null ? controller.signal : AbortSignal.any([controller.signal, init.signal]);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal.throwIfAborted();
      mutation?.dispatch();
      response = await globalThis.fetch(input, { ...init, signal, redirect: 'manual', credentials: 'omit' });
      if (response.status >= 300 && response.status < 400) {
        throw new AgentHistoryError('unsupported_scope', 'OpenCode history does not follow server redirects.');
      }
      if (response.status === 401 || response.status === 403) {
        throw new AgentHistoryError('access_denied', 'OpenCode server access was denied.');
      }
      const declaredBytes = response.headers.get('content-length');
      if (declaredBytes !== null && /^\d+$/u.test(declaredBytes) && Number(declaredBytes) > OPENCODE_RESPONSE_BYTES) {
        throw new AgentHistoryError('limit_exhausted', 'OpenCode history response exceeds its 1 MiB raw body limit.');
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      while (reader !== undefined) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > OPENCODE_RESPONSE_BYTES - bytes) {
          throw new AgentHistoryError('limit_exhausted', 'OpenCode history response exceeds its 1 MiB raw body limit.');
        }
        decoder.decode(chunk.value, { stream: true });
        bytes += chunk.value.byteLength;
        chunks.push(chunk.value);
      }
      decoder.decode();
      return new Response(response.status === 204 ? null : Buffer.concat(chunks, bytes), { status: response.status, headers: response.headers });
    } catch (error) {
      controller.abort();
      try { if (reader !== undefined) await reader.cancel(); else await response?.body?.cancel(); } catch { /* The request was already aborted. */ }
      throw error;
    } finally { reader?.releaseLock(); }
  };
}

export async function createOpenCodeClient(options: ResolvedOpenCodeHistoryOptions): Promise<OpenCodeHistoryClient> {
  await assertOpenCodeClientIdentity();
  const { OpenCode } = await import('@opencode/client/promise');
  const client = OpenCode.make({ baseUrl: options.server.baseUrl, headers: options.server.headers,
    fetch: boundedFetch(options.server.baseUrl) });
  const call = async (operation: () => Promise<unknown>, signal: AbortSignal): Promise<unknown> => {
    try { signal.throwIfAborted(); return await operation(); }
    catch (error) {
      if (signal.aborted) {
        throw new AgentHistoryError(signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
          ? 'deadline_exceeded' : 'cancelled', 'OpenCode history request was interrupted.');
      }
      throw nativeError(error);
    }
  };
  return {
    info: (signal) => call(() => client.server.info({ signal }), signal),
    sessions: (input, signal) => call(() => client.session.list(input, { signal }), signal),
    session: (sessionID, signal) => call(() => client.session.get({ sessionID }, { signal }), signal),
    messages: (input, signal) => call(() => client.message.list(input, { signal }), signal),
    active: (signal) => call(() => client.session.active({ signal }), signal),
    update: async (input, signal, dispatch) => {
      const mutation = OpenCode.make({ baseUrl: options.server.baseUrl, headers: options.server.headers,
        fetch: boundedFetch(options.server.baseUrl, { method: 'PATCH', sessionID: input.sessionID, dispatch }) });
      await call(() => mutation.session.update(input, { signal }), signal);
    },
    remove: async (sessionID, signal, dispatch) => {
      const mutation = OpenCode.make({ baseUrl: options.server.baseUrl, headers: options.server.headers,
        fetch: boundedFetch(options.server.baseUrl, { method: 'DELETE', sessionID, dispatch }) });
      await call(() => mutation.session.remove({ sessionID }, { signal }), signal);
    },
  };
}
