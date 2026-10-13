// ------------------------------------------------------------------------------------------------
//                harness.ts - Deterministic in-memory ACP peer harness - Dependencies: streams
// ------------------------------------------------------------------------------------------------

import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createAcpClient,
  type AcpClient,
  type AcpJsonValue,
  type CreateAcpClientOptions,
} from '../src/index.js';

export interface AcpTestHarness {
  readonly client: AcpClient;
  readonly stdout: PassThrough;
  readonly stdin: PassThrough;
  readonly stderr: PassThrough;
  readonly send: (message: unknown, fragments?: readonly number[]) => void;
  readonly sendRaw: (bytes: Buffer | string, fragments?: readonly number[]) => void;
  readonly nextOutbound: () => Promise<Record<string, unknown>>;
}

export function createAcpTestHarness(
  options: Omit<CreateAcpClientOptions, 'stdout' | 'stdin' | 'stderr' | 'schemaChannel'>
    & Partial<Pick<CreateAcpClientOptions, 'schemaChannel'>> = {},
): AcpTestHarness {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const outbound: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  let buffered = '';

  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else outbound.push(message);
      newline = buffered.indexOf('\n');
    }
  });

  const sendRaw = (value: Buffer | string, fragments: readonly number[] = []) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    let offset = 0;
    for (const length of fragments) {
      stdout.write(bytes.subarray(offset, offset + length));
      offset += length;
    }
    if (offset < bytes.byteLength) stdout.write(bytes.subarray(offset));
  };

  return {
    client: createAcpClient({ stdout, stdin, stderr, schemaChannel: 'unstable', ...options }),
    stdout,
    stdin,
    stderr,
    send: (message, fragments) => sendRaw(`${JSON.stringify(message)}\n`, fragments),
    sendRaw,
    nextOutbound: () => {
      const message = outbound.shift();
      return message
        ? Promise.resolve(message)
        : new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
    },
  };
}

export const INITIALIZE_PARAMS: AcpJsonValue = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  },
  clientInfo: { name: 'agenai-adapter-acp-test', version: '0.1.0' },
};

export const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: true },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: {},
  },
  authMethods: [],
} satisfies AcpJsonValue;


export async function withTestDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`Test promise did not settle within ${timeoutMs}ms.`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}
