import { PassThrough } from 'node:stream';
import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import type { AcpConnectionLease } from '../../src/index.js';

export interface PeerFrame {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: AcpJsonObject;
  readonly result?: AcpJsonValue;
}

export function createStreamPeer(initialize: AcpJsonObject = {
  protocolVersion: 1,
  agentInfo: { name: 'stream-fixture', version: '1.0.0' },
}) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const frames: PeerFrame[] = [];
  let buffered = '';
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let index: number;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffered.slice(0, index)) as PeerFrame;
      buffered = buffered.slice(index + 1);
      frames.push(message);
      if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: initialize });
      else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native-session' } });
      else if (message.method === 'session/prompt') send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    }
  });
  function send(value: unknown): void { stdout.write(`${JSON.stringify(value)}\n`); }
  const lease: AcpConnectionLease = { ownership: 'borrowed', stdout, stdin };
  return { stdout, stdin, frames, lease, send };
}
