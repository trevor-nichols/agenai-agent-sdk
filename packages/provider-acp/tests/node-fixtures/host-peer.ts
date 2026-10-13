import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId } from '@agen-ai/agent-protocol';
import type { AcpConnectionLease } from '../../src/index.js';

export interface HostPeerFrame {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: AcpJsonObject;
  readonly result?: AcpJsonValue;
  readonly error?: Readonly<{ code: number; message: string }>;
}

export function createHostPeer(initialize: AcpJsonObject = { protocolVersion: 1 }) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const events = new EventEmitter();
  const frames: HostPeerFrame[] = [];
  let buffer = '';
  let sequence = 10_000;
  let handler: ((frame: HostPeerFrame) => boolean | void) | undefined;
  const send = (value: unknown) => { stdout.write(`${JSON.stringify(value)}\n`); };
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, index)) as HostPeerFrame;
      buffer = buffer.slice(index + 1);
      frames.push(frame);
      events.emit('frame', frame);
      if (handler?.(frame)) continue;
      if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: initialize });
      else if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'native-session' } });
      else if (frame.method === 'session/prompt') send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
    }
  });
  const wait = (predicate: (frame: HostPeerFrame) => boolean): Promise<HostPeerFrame> => {
    const prior = frames.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve) => {
      const listener = (frame: HostPeerFrame) => { if (predicate(frame)) { events.off('frame', listener); resolve(frame); } };
      events.on('frame', listener);
    });
  };
  const lease: AcpConnectionLease = { ownership: 'borrowed', stdout, stdin };
  return {
    lease, stdout, stdin, frames, send, wait,
    handle(callback: (frame: HostPeerFrame) => boolean | void) { handler = callback; },
    request(method: string, params: AcpJsonObject, id: string | number = ++sequence): Promise<HostPeerFrame> {
      const response = wait((frame) => frame.id === id && frame.method === undefined);
      send({ jsonrpc: '2.0', id, method, params });
      return response;
    },
    destroy() { stdout.destroy(); stdin.destroy(); events.removeAllListeners(); },
  };
}

export const hostProviderKey = parseAgentProviderKey('acp-host-fixture');
export const hostDefinition = { providerKey: hostProviderKey, instanceId: parseAgentInstanceId('acp:host-fixture'), driverConfiguration: {} };
export const hostSessionContext = (id = 'session:host-fixture') => ({
  sessionId: parseAgentSessionId(id), workingDirectory: '/fixture',
  configuration: { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('config:host-fixture') }, onBindingCreated() {},
});

export function fixtureDeferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
