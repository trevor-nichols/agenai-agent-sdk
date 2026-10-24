// ------------------------------------------------------------------------------------------------
//                peer.ts - Bounded serialized ACP peer for packed input-support proof
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import type { AcpConnectionLease } from '@agen-ai/provider-acp';

export const nativeSessionId = 'packed-input-native-session';
export const unsolicitedInputId = 'packed-unregistered-input';

interface HostFrame {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly error?: unknown;
}

function parseFrame(line: string): HostFrame {
  const frame: unknown = JSON.parse(line);
  assert.ok(frame !== null && typeof frame === 'object' && !Array.isArray(frame));
  assert.ok('jsonrpc' in frame && frame.jsonrpc === '2.0');
  const id = 'id' in frame ? frame.id : undefined;
  const method = 'method' in frame ? frame.method : undefined;
  assert.ok(id === undefined || typeof id === 'string' || typeof id === 'number');
  assert.ok(method === undefined || typeof method === 'string');
  return {
    ...(id === undefined ? {} : { id }),
    ...(method === undefined ? {} : { method }),
    ...('params' in frame ? { params: frame.params } : {}),
    ...('error' in frame ? { error: frame.error } : {}),
  };
}

export function createUnsupportedInputPeer(initialization: AcpJsonObject, ownership: 'borrowed' | 'owned') {
  const stdout = new PassThrough();
  const frames: HostFrame[] = [];
  let releases = 0;
  let buffered = '';
  let promptId: string | number | undefined;
  let answerInput!: () => void;
  const inputAnswered = new Promise<void>((resolve) => { answerInput = resolve; });
  const send = (frame: AcpJsonObject) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        buffered += chunk.toString('utf8');
        assert.ok(Buffer.byteLength(buffered) <= 32_768, 'The synthetic peer accepts bounded frames only.');
        for (;;) {
          const newline = buffered.indexOf('\n');
          if (newline < 0) break;
          const frame = parseFrame(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          frames.push(frame);
          assert.ok(frames.length <= 8, 'The synthetic peer accepts only its finite scenario.');
          if (frame.method === undefined) {
            assert.equal(frame.id, unsolicitedInputId);
            answerInput();
            continue;
          }
          assert.ok(frame.id !== undefined, 'The expected native operations are requests.');
          if (frame.method === 'initialize') send({ id: frame.id, result: initialization });
          else if (frame.method === 'session/new') send({ id: frame.id, result: { sessionId: nativeSessionId } });
          else if (frame.method === 'session/prompt') {
            assert.equal(promptId, undefined, 'The original execution owns exactly one native prompt.');
            promptId = frame.id;
            send({ method: '_x.ai/queue/changed', params: { sessionId: nativeSessionId,
              entries: [{ id: 'unowned-command', status: 'queued' }] } });
            send({ method: '_x.ai/session/interjection', params: { sessionId: nativeSessionId,
              interjectionId: 'unsupported-update', text: 'Change the answer.', status: 'queued' } });
            send({ id: unsolicitedInputId, method: '_x.ai/interject', params: { sessionId: nativeSessionId,
              interjectionId: 'unsupported-update', text: 'Change the answer.' } });
            send({ method: 'session/update', params: { sessionId: nativeSessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Original packed prompt output.' } } } });
          } else assert.fail(`Unexpected native operation: ${frame.method}`);
        }
        callback();
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
    },
  });
  const lease: AcpConnectionLease = ownership === 'borrowed' ? { ownership, stdout, stdin } : {
    ownership, stdout, stdin, release() { releases += 1; stdout.destroy(); stdin.destroy(); },
  };
  return {
    lease, frames, stdout, stdin, inputAnswered,
    releases: () => releases,
    complete() {
      assert.ok(promptId !== undefined, 'An original prompt must precede its completion.');
      send({ id: promptId, result: { stopReason: 'end_turn' } });
    },
    dispose() { stdout.destroy(); stdin.destroy(); },
  };
}
