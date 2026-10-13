import { PassThrough } from 'node:stream';
import type { AgentProviderOutput } from '@agen-ai/agent-runtime';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import type { AcpConnectionLease } from '../../src/contracts.js';

export interface PeerFrame {
  readonly jsonrpc?: string;
  readonly method?: string;
  readonly id?: string | number;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: Readonly<{ code: number; message: string }>;
}

export interface SessionPeer {
  readonly lease: AcpConnectionLease;
  readonly stdout: PassThrough;
  readonly stdin: PassThrough;
  readonly frames: PeerFrame[];
  readonly sessionId: string;
  readonly send: (frame: unknown) => void;
  readonly batch: (frames: readonly unknown[]) => void;
  readonly raw: (text: string) => void;
  readonly update: (update: Record<string, unknown>) => unknown;
  readonly permission: (id: string | number, toolId: string, title?: string) => unknown;
  readonly complete: (stopReason?: string) => void;
  readonly dispose: () => void;
}

export function createSessionPeer(options: {
  readonly onPrompt?: (peer: SessionPeer, frame: PeerFrame) => void;
  readonly onResolution?: (peer: SessionPeer, frame: PeerFrame) => void;
  readonly confirmCancel?: boolean;
  readonly owned?: boolean;
  readonly onRelease?: () => void;
  readonly agentCapabilities?: AcpJsonObject;
  readonly onSetup?: (peer: SessionPeer, frame: PeerFrame) => void;
} = {}): SessionPeer {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const frames: PeerFrame[] = [];
  const sessionId = 'native-session';
  let promptId: string | number | undefined;
  let buffered = '';
  const send = (frame: unknown) => { stdout.write(`${JSON.stringify(frame)}\n`); };
  const peer: SessionPeer = {
    lease: options.owned ? {
      ownership: 'owned', stdout, stdin,
      release: () => { options.onRelease?.(); stdout.destroy(); stdin.destroy(); },
    } : { ownership: 'borrowed', stdout, stdin },
    stdout, stdin, frames, sessionId, send,
    batch: (batch) => { stdout.write(batch.map((frame) => JSON.stringify(frame)).join('\n') + '\n'); },
    raw: (text) => { stdout.write(text); },
    update: (update) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }),
    permission: (id, toolId, title = `Use ${toolId}`) => ({
      jsonrpc: '2.0', id, method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: toolId, title, status: 'in_progress' },
        options: [
          { optionId: `${id}:allow`, name: 'Allow once', kind: 'allow_once' },
          { optionId: `${id}:deny`, name: 'Reject once', kind: 'reject_once' },
          { optionId: `${id}:always`, name: 'Allow permanently', kind: 'allow_always' },
        ],
      },
    }),
    complete: (stopReason = 'end_turn') => {
      if (promptId === undefined) throw new Error('Fixture has no native prompt to complete.');
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason } });
      promptId = undefined;
    },
    dispose: () => { stdout.destroy(); stdin.destroy(); },
  };
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const frame = JSON.parse(buffered.slice(0, newline)) as PeerFrame;
      buffered = buffered.slice(newline + 1);
      frames.push(frame);
      if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: {
        protocolVersion: 1, agentCapabilities: options.agentCapabilities ?? {}, authMethods: [], agentInfo: { name: 'session-fixture', version: '1.0.0' },
      } });
      else if (frame.method === 'session/new' || frame.method === 'session/load' || frame.method === 'session/resume') {
        if (options.onSetup) options.onSetup(peer, frame);
        else send({ jsonrpc: '2.0', id: frame.id, result: frame.method === 'session/new' ? { sessionId } : {} });
      }
      else if (frame.method === 'session/prompt') { promptId = frame.id; options.onPrompt?.(peer, frame); }
      else if (frame.method === 'session/cancel' && options.confirmCancel !== false) peer.complete('cancelled');
      else if (!frame.method) options.onResolution?.(peer, frame);
      newline = buffered.indexOf('\n');
    }
  });
  return peer;
}

export async function takeUntilRequest(iterator: AsyncIterator<AgentProviderOutput>): Promise<AgentProviderOutput[]> {
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error('Expected a request before turn completion.');
    outputs.push(next.value);
    if (next.value.kind === 'event' && next.value.event.type === 'request.opened') return outputs;
  }
}

export async function collectRemaining(iterator: AsyncIterator<AgentProviderOutput>): Promise<AgentProviderOutput[]> {
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return outputs;
    outputs.push(next.value);
  }
}
