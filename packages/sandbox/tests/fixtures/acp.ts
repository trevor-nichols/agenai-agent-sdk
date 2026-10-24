// ------------------------------------------------------------------------------------------------
//                acp.ts - Controlled ACP peer and observable physical sandbox ports
// ------------------------------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgentProviderOutput } from '@agen-ai/agent-runtime';
import { createSandboxBackend } from '../../src/backend/index.js';
import type { OperationOptions, SandboxProcessSpec } from '../../src/index.js';
import { fixture, request, type FixtureOptions } from './backend.js';

export interface PeerFrame {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: Readonly<{ code: number; message: string }>;
}

interface ControlledAcpPeer {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly frames: PeerFrame[];
  send(frame: unknown): void;
  wait(predicate: (frame: PeerFrame) => boolean): Promise<PeerFrame>;
  message(text: string): void;
  permission(id: string): void;
  complete(stopReason?: string): void;
  request(method: string, params: Record<string, unknown>, id: string): Promise<PeerFrame>;
}

export function acpPeer(options: {
  readonly initialize?: Readonly<Record<string, unknown>>;
  readonly onPrompt?: (peer: ControlledAcpPeer, frame: PeerFrame) => void;
  readonly onResponse?: (peer: ControlledAcpPeer, frame: PeerFrame) => void;
} = {}): ControlledAcpPeer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const frames: PeerFrame[] = [];
  const received = new EventEmitter();
  let buffered = '';
  let promptId: string | number | undefined;
  const send = (frame: unknown) => { stdout.write(Buffer.from(`${JSON.stringify(frame)}\n`)); };
  const wait = (predicate: (frame: PeerFrame) => boolean): Promise<PeerFrame> => {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const listener = (frame: PeerFrame) => {
        if (predicate(frame)) { received.off('frame', listener); resolve(frame); }
      };
      received.on('frame', listener);
    });
  };
  const peer = {
    stdin, stdout, stderr, frames, send, wait,
    message(text: string) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    },
    permission(id: string) {
      send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
        sessionId: 'native-session', toolCall: { toolCallId: 'guest-edit', title: 'Edit guest file', kind: 'edit', status: 'in_progress' },
        options: [{ optionId: 'guest:allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'guest:deny', name: 'Deny once', kind: 'reject_once' }],
      } });
    },
    complete(stopReason = 'end_turn') {
      if (promptId === undefined) throw new Error('Controlled peer has no entered prompt.');
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason } });
      promptId = undefined;
    },
    request(method: string, params: Record<string, unknown>, id: string) {
      const response = wait((frame) => frame.id === id && frame.method === undefined);
      send({ jsonrpc: '2.0', id, method, params });
      return response;
    },
  };
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffered.slice(0, newline)) as PeerFrame;
      buffered = buffered.slice(newline + 1);
      frames.push(frame);
      received.emit('frame', frame);
      if (frame.method === 'initialize') {
        stderr.write(Buffer.from([0x00, 0xff, 0x7b, 0x0a]));
        send({ jsonrpc: '2.0', id: frame.id, result: options.initialize ?? {
          protocolVersion: 1, agentInfo: { name: 'sandbox-controlled-peer', version: '1' }, authMethods: [],
        } });
      } else if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'native-session' } });
      else if (frame.method === 'session/prompt') { promptId = frame.id; options.onPrompt?.(peer, frame); }
      else if (frame.method === 'session/cancel') peer.complete('cancelled');
      else if (frame.method === 'authenticate') send({ jsonrpc: '2.0', id: frame.id, result: {} });
      else if (frame.method === undefined) options.onResponse?.(peer, frame);
    }
  });
  return peer;
}

export async function acpSandbox(peer: ReturnType<typeof acpPeer>, options: Pick<FixtureOptions, 'failFirstStop' | 'processReply'> = {}) {
  const physical = fixture({ input: peer.stdin, output: peer.stdout, errorOutput: peer.stderr, ...options });
  const recipes: SandboxProcessSpec[] = [];
  const starts: OperationOptions[] = [];
  const backend = createSandboxBackend({ ...physical.driver, reserve(admitted) {
    const reservation = physical.driver.reserve(admitted);
    return { ...reservation, async start(context) {
      const ready = await reservation.start(context);
      return { ...ready, reserveProcess(spec) {
        recipes.push(spec);
        const process = ready.reserveProcess(spec);
        return { ...process, start(context) { starts.push(context ?? {}); return process.start(context); } };
      } };
    } };
  } });
  const reservation = backend.reserve(request({ execution: { kind: 'deadline', timeoutMs: 30_000 } }), { kind: 'in_process' });
  const sandbox = await reservation.start();
  return { physical, sandbox, recipes, starts };
}

export async function collect(outputs: AsyncIterable<AgentProviderOutput>): Promise<AgentProviderOutput[]> {
  const collected: AgentProviderOutput[] = [];
  for await (const output of outputs) collected.push(output);
  return collected;
}

export async function untilRequest(reader: AsyncIterator<AgentProviderOutput>) {
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await reader.next();
    if (next.done) throw new Error('Expected a portable approval request.');
    outputs.push(next.value);
    if (next.value.kind === 'event' && next.value.event.type === 'request.opened') {
      const request = next.value.event.payload.request;
      if (request.requestKind !== 'approval') throw new Error('Expected a portable approval request.');
      return { outputs, request };
    }
  }
}

export async function remaining(reader: AsyncIterator<AgentProviderOutput>): Promise<AgentProviderOutput[]> {
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await reader.next();
    if (next.done) return outputs;
    outputs.push(next.value);
  }
}
