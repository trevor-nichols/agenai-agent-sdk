// ------------------------------------------------------------------------------------------------
//                native.ts - One owned OpenCode session: server, plugin endpoint, events and readiness proof
// ------------------------------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import type { NodeProviderToolDefinition } from '@agen-ai/provider-tools/node';
import { OPENCODE_VERSION, type NodeOpenCodeModelProvider, type NodeOpenCodeUsageLimits } from '../index.js';
import { createNativeClient, type NativeClient, type NativeSessionReadback } from './client.js';
import {
  expectedConfigSources, NATIVE_AGENT, nativeEnvironment, OWNED_PERMISSION, OWNED_TOOLS, SESSION_RULES, writeNativeFiles, type NativeLayout,
} from './config.js';
import { openPluginEndpoint, type PluginCall, type PluginEndpoint } from './endpoint.js';
import { NativeFailure } from './errors.js';
import { classifyNativeEvent, type NativeEvent } from './native-events.js';
import { NativeCleanupFailure, startNativeServer, type NativeServer } from './server.js';

const READINESS_TIMEOUT_MS = 60_000;
/** Plugins finish setup before OpenCode reports `plugin.updated`; this only absorbs frame delivery. */
const PLUGIN_GRACE_MS = 5_000;
const READBACK_TIMEOUT_MS = 5_000;
const BACKLOG = 1_024;

export type NativeSignal =
  | Readonly<{ type: 'event'; event: NativeEvent }>
  | Readonly<{ type: 'call'; call: PluginCall }>
  | Readonly<{ type: 'cancel'; id: number }>
  | Readonly<{ type: 'failed'; reason: string }>;

/** The session-facing boundary over one owned server; the session never sees the client or plugin. */
export interface NativeSession {
  readonly sessionID: string;
  /** The sole consumer of native signals after readiness; installed once. */
  listen(listener: (signal: NativeSignal) => void): void;
  prompt(text: string): Promise<void>;
  /** One bounded `session.get`; transport loss or timeout is unavailable, malformed responses reject. No replay. */
  readSession(): Promise<NativeSessionReadback>;
  interrupt(): Promise<boolean>;
  rejectPermission(requestID: string): Promise<void>;
  cancelForm(formID: string): Promise<void>;
  savedGrants(): Promise<number>;
  /** Answers one admitted plugin call exactly once. */
  reply(id: number, result: Readonly<{ text: string; isError: boolean }>): void;
  /** Stops events, joins the server group and closes the endpoint. Retryable. */
  close(): Promise<void>;
}

export interface NativeOpening {
  readonly executable: string;
  readonly layout: NativeLayout;
  readonly provider: NodeOpenCodeModelProvider;
  readonly model: string;
  readonly apiKey: string;
  readonly apiBaseUrl: string;
  readonly tools: readonly NodeProviderToolDefinition[];
  readonly usageLimits: NodeOpenCodeUsageLimits;
  readonly signal?: AbortSignal;
}

const secret = () => randomBytes(32).toString('base64url');

function sameRules(rules: ReadonlyArray<{ action: string; resource: string; effect: string }> | undefined): boolean {
  return rules?.length === SESSION_RULES.length
    && rules.every((rule, index) => rule.action === SESSION_RULES[index]!.action && rule.resource === SESSION_RULES[index]!.resource
      && rule.effect === SESSION_RULES[index]!.effect);
}

/** Every agent starts by denying everything, may allow only the owned tool permission and never asks. */
function lockedAgent(rules: ReadonlyArray<{ action: string; resource: string; effect: string }>): boolean {
  return rules[0]?.action === '*' && rules[0].resource === '*' && rules[0].effect === 'deny'
    && rules.every((rule) => rule.effect === 'deny' || (rule.effect === 'allow' && rule.action === OWNED_PERMISSION));
}

async function proveConfiguration(client: NativeClient, layout: NativeLayout): Promise<void> {
  const sources = await client.configSources(layout.location);
  const expected = expectedConfigSources(layout);
  if (sources.length !== expected.length || sources.some((source, index) => source.type !== expected[index]!.type || source.path !== expected[index]!.path)) {
    throw new NativeFailure('readiness', 'OpenCode loaded configuration outside the private document.');
  }
  const agents = await client.agents(layout.location);
  if (!agents.some((agent) => agent.id === NATIVE_AGENT) || agents.some((agent) => !lockedAgent(agent.permissions))) {
    throw new NativeFailure('readiness', 'OpenCode agents do not carry the locked owned-tool rules.');
  }
  if (await client.savedGrants() !== 0) throw new NativeFailure('readiness', 'OpenCode reported saved permission grants.');
}

/**
 * Opens one fresh server and session and proves readiness before any prompt: the plugin's
 * authenticated nonce acknowledgement of the exact owned inventory, the end of the location-load
 * burst, private-only configuration and locked agents. Any failure dispatches no model request.
 */
export async function openNativeSession(opening: NativeOpening): Promise<NativeSession> {
  const { layout } = opening;
  const token = secret();
  const nonce = secret();
  const password = secret();
  const lifetime = new AbortController();
  let endpoint: PluginEndpoint | undefined;
  let server: NativeServer | undefined;
  let serverClose: (() => Promise<void>) | undefined;
  let pump: Promise<void> | undefined;
  let closing = false;

  let phase: 'connecting' | 'opening' | 'open' = 'connecting';
  let sessionID: string | undefined;
  const created: string[] = [];
  let listener: ((signal: NativeSignal) => void) | undefined;
  const backlog: NativeSignal[] = [];
  let overflowed = false;
  const connected = Promise.withResolvers<void>();
  const barrier = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => undefined);

  const deliver = (signal: NativeSignal) => {
    if (listener) { listener(signal); return; }
    if (backlog.length < BACKLOG) { backlog.push(signal); return; }
    if (!overflowed) { overflowed = true; backlog.push({ type: 'failed', reason: 'Native signals exceeded their bound before the session listened.' }); }
  };
  const fail = (reason: string) => {
    if (closing) return;
    if (phase === 'open') deliver({ type: 'failed', reason });
    else failed.reject(new NativeFailure('readiness', reason));
  };
  const route = (event: NativeEvent) => {
    if (phase === 'open') {
      if (event.kind === 'connected') deliver({ type: 'event', event: { kind: 'drift', type: 'server.connected' } });
      else if (event.kind === 'created') deliver({ type: 'event', event: { kind: 'drift', type: 'session.created' } });
      else if (event.kind === 'opening') deliver({ type: 'event', event: { kind: 'drift', type: event.type } });
      else deliver({ type: 'event', event });
      return;
    }
    if (phase === 'connecting') {
      if (event.kind !== 'connected') { fail('The native event stream did not start with its connection receipt.'); return; }
      phase = 'opening';
      connected.resolve();
      return;
    }
    if (event.kind === 'created') { created.push(event.sessionID); return; }
    if (event.kind === 'opening') {
      if (event.type === 'plugin.updated' && created.length) barrier.resolve();
      return;
    }
    if (event.kind !== 'benign') fail(`OpenCode emitted ${event.kind === 'drift' ? event.type : event.kind} before readiness.`);
  };

  const cleanup = async () => {
    closing = true;
    lifetime.abort();
    try { await serverClose?.(); } finally { await endpoint?.close(); }
    await pump;
  };

  try {
    opening.signal?.throwIfAborted();
    endpoint = await openPluginEndpoint({ token, nonce, tools: OWNED_TOOLS });
    await writeNativeFiles(layout, {
      provider: opening.provider, model: opening.model, apiKey: opening.apiKey, apiBaseUrl: opening.apiBaseUrl, port: endpoint.port, token, nonce, tools: opening.tools,
      usageLimits: opening.usageLimits,
    });
    void endpoint.ready.catch((error: unknown) => fail(error instanceof Error ? error.message : 'The plugin did not become ready.'));
    server = await startNativeServer({ executable: opening.executable, directory: layout.location, environment: nativeEnvironment(layout, password), signal: opening.signal })
      .catch((error: unknown) => {
        if (error instanceof NativeCleanupFailure) serverClose = error.retryCleanup;
        throw error;
      });
    serverClose = server.close;
    void server.exited.then(() => fail('The OpenCode server exited.'));
    const client = createNativeClient(server.url, password, lifetime.signal);
    const ready = async <T>(work: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const abort = () => failed.reject(opening.signal?.reason ?? new DOMException('OpenCode session opening was aborted.', 'AbortError'));
      opening.signal?.addEventListener('abort', abort, { once: true });
      try {
        return await Promise.race([work, failed.promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new NativeFailure('readiness', 'OpenCode did not prove readiness in time.')), READINESS_TIMEOUT_MS);
        })]);
      } finally {
        clearTimeout(timer);
        opening.signal?.removeEventListener('abort', abort);
      }
    };

    const info = await ready(client.info());
    if (info.version !== OPENCODE_VERSION) throw new NativeFailure('readiness', 'The OpenCode server reported another version.');
    pump = (async () => {
      try {
        for await (const raw of client.events(lifetime.signal)) {
          let event: NativeEvent;
          try { event = classifyNativeEvent(raw, sessionID); } catch (error) {
            fail(error instanceof Error ? error.message : 'OpenCode sent an invalid event.');
            return;
          }
          route(event);
        }
        fail('The native event stream ended.');
      } catch {
        fail('The native event stream failed.');
      }
    })();
    await ready(connected.promise);
    const session = await ready(client.createSession({
      directory: layout.location, agent: NATIVE_AGENT, providerID: opening.provider, model: opening.model, permissions: SESSION_RULES,
    }));
    if (session.agent !== NATIVE_AGENT || session.model?.id !== opening.model || session.model.providerID !== opening.provider
      || session.location.directory !== layout.location || !sameRules(session.permissions)) {
      throw new NativeFailure('readiness', 'OpenCode created a session other than the requested one.');
    }
    sessionID = session.id;
    await ready(client.loadLocation(layout.location));
    await ready(barrier.promise);
    const pluginReady = endpoint.ready;
    await ready(new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new NativeFailure('readiness', 'The plugin did not acknowledge readiness after plugins loaded.')), PLUGIN_GRACE_MS);
      void pluginReady.then(resolve, reject).finally(() => clearTimeout(timer));
    }));
    if (created.length !== 1 || created[0] !== sessionID) throw new NativeFailure('readiness', 'OpenCode reported a session other than its own.');
    await ready(proveConfiguration(client, layout));
    phase = 'open';
    const id = sessionID;
    const owned = endpoint;
    owned.listen((signal) => {
      if (signal.type === 'failed') fail(signal.reason);
      else if (!closing) deliver(signal);
    });

    let closed = false;
    let closingSession: Promise<void> | undefined;
    return Object.freeze<NativeSession>({
      sessionID: id,
      listen(next) {
        if (listener) throw new Error('The native session already has its owner.');
        listener = next;
        for (const signal of backlog.splice(0)) next(signal);
      },
      prompt: (text) => client.prompt(id, text),
      readSession: () => client.readSession(id, READBACK_TIMEOUT_MS),
      interrupt: () => client.interrupt(id),
      rejectPermission: (requestID) => client.rejectPermission(id, requestID),
      cancelForm: (formID) => client.cancelForm(id, formID),
      savedGrants: () => client.savedGrants(),
      reply: (callId, result) => owned.reply(callId, result),
      close() {
        if (closed) return Promise.resolve();
        closingSession ??= cleanup().then(() => { closed = true; }).finally(() => { closingSession = undefined; });
        return closingSession;
      },
    });
  } catch (cause) {
    try { await cleanup(); } catch (cleanupError) { throw new NativeCleanupFailure(cause, cleanupError, cleanup); }
    throw cause;
  }
}
