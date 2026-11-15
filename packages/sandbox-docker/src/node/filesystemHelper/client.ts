// ------------------------------------------------------------------------------------------------
//                client.ts - Bounded filesystem helper client over caller-owned stdio
// ------------------------------------------------------------------------------------------------

import type { SandboxDriverReadWriteFiles } from '@agen-ai/sandbox/backend';
import { z } from 'zod/v4';
import { DockerFilesystem } from '../../workspace/live/files.js';
import { FILESYSTEM_CHUNK_BYTES } from '../../workspace/live/protocol.js';
import { captureDataFields } from '../preparedHelperOptions.js';
import { FilesystemStreamChannel } from './channel.js';
import type { NodeFilesystemHelperClient, NodeFilesystemHelperClientOptions, NodeFilesystemHelperCloseReceipt } from './contracts.js';

const identity = z.number().int().min(1).max(262143);
const limitsSchema = z.strictObject({
  readyTimeoutMs: z.number().int().min(1).max(60_000).default(10_000),
  responseTimeoutMs: z.number().int().min(1).max(60_000).default(10_000),
  heartbeatMs: z.number().int().min(1).max(60_000).default(5_000),
});
const fileFields = ['signal', 'quotas', 'chunkBytes'];
const fileOptionsSchema = z.strictObject({
  signal: z.instanceof(AbortSignal),
  quotas: z.strictObject({ maxBytes: z.bigint().nonnegative().optional(), maxEntries: z.bigint().nonnegative().optional() }),
  chunkBytes: z.number().int().min(1).max(FILESYSTEM_CHUNK_BYTES),
});
const writeOptionsSchema = fileOptionsSchema.extend({ mode: z.enum(['create', 'replace']) });

function captureFileOptions(input: unknown, fields = fileFields) {
  const captured = captureDataFields(input, fields, 'Filesystem helper file options');
  return { ...captured, quotas: captureDataFields(captured.quotas, ['maxBytes', 'maxEntries'], 'Filesystem helper quotas') };
}

function stream(value: unknown, methods: readonly (string | symbol)[], context: string): void {
  if (value === null || typeof value !== 'object' || methods.some((name) => typeof Reflect.get(value, name) !== 'function')) {
    throw new TypeError(`Filesystem helper ${context} must be an owned stream.`);
  }
}

/**
 * Wraps one already-started helper's stdio. The client acquires no process, Docker resource or
 * filesystem grant; its launcher owns process startup, exit observation and namespace joining.
 */
export function createNodeFilesystemHelperClient(options: NodeFilesystemHelperClientOptions): NodeFilesystemHelperClient {
  const captured = captureDataFields(options, ['input', 'output', 'user', 'limits'], 'Filesystem helper client');
  stream(captured.input, ['write', 'end', 'destroy'], 'input');
  stream(captured.output, [Symbol.asyncIterator, 'destroy'], 'output');
  const user = z.strictObject({ uid: identity, gid: identity }).parse(captureDataFields(captured.user, ['uid', 'gid'], 'Filesystem helper user'));
  const limits = limitsSchema.parse(captured.limits === undefined ? {}
    : captureDataFields(captured.limits, ['readyTimeoutMs', 'responseTimeoutMs', 'heartbeatMs'], 'Filesystem helper limits'));
  const channel = new FilesystemStreamChannel(captured.input as NodeFilesystemHelperClientOptions['input'],
    captured.output as NodeFilesystemHelperClientOptions['output'], user, limits);
  const files = new DockerFilesystem(channel, 'read_write', async () => {}).files as SandboxDriverReadWriteFiles;
  let closing: Promise<NodeFilesystemHelperCloseReceipt> | undefined;
  return Object.freeze({
    ready: channel.ready,
    stat: async (path, options) => files.stat(path, fileOptionsSchema.parse(captureFileOptions(options))),
    list: async (path, consume, options) => files.list(path, consume, fileOptionsSchema.parse(captureFileOptions(options))),
    readFile: async (path, consume, options) => files.readFile(path, consume, fileOptionsSchema.parse(captureFileOptions(options))),
    writeFile: async (path, source, options) => files.writeFile(path, source, writeOptionsSchema.parse(captureFileOptions(options, [...fileFields, 'mode']))),
    close: () => closing ??= channel.close().then(
      () => Object.freeze({ kind: 'closed' as const }),
      (error: unknown) => Object.freeze({ kind: 'failed' as const, error: error instanceof Error ? error : new Error('Filesystem helper close failed.') }),
    ),
  } satisfies NodeFilesystemHelperClient);
}
