// ------------------------------------------------------------------------------------------------
//                protocol.ts - Closed bounded controller protocol for the native filesystem helper
// ------------------------------------------------------------------------------------------------

import { parseSandboxRelativePath } from '@agen-ai/sandbox';

export const FILESYSTEM_PROTOCOL = 'agenai.sandbox.filesystem.v1';
export const FILESYSTEM_LAYOUT = 'agenai.sandbox.workspace.v1';
export const FILESYSTEM_EXECUTABLE = '/usr/local/bin/agenai-sandbox-files';
export const FILESYSTEM_STORE = '/store';
export const FILESYSTEM_WORK = 'work';
export const FILESYSTEM_STAGE = 'stage';
export const FILESYSTEM_MARKER = '.agenai-layout';
export const FILESYSTEM_IMAGE_PROTOCOL_LABEL = 'ai.agen.sandbox.filesystem.protocol';
export const FILESYSTEM_IMAGE_SOURCE_LABEL = 'ai.agen.sandbox.filesystem.source';
export const FILESYSTEM_IMAGE_LAYOUT_LABEL = 'ai.agen.sandbox.filesystem.layout';
export const FILESYSTEM_IMAGE_USER_LABEL = 'ai.agen.sandbox.filesystem.user';
export const FILESYSTEM_ENVIRONMENT = Object.freeze(['PATH=/nonexistent']);
export const FILESYSTEM_CHUNK_BYTES = 65536;
export const FILESYSTEM_METADATA_BYTES = 2048;
export const FILESYSTEM_PATH_BYTES = 4079;

export type FilesystemKind = 'file' | 'directory' | 'symlink' | 'unsupported_hardlink' | 'unsupported_special';
export interface FilesystemMetadata { readonly kind: FilesystemKind; readonly byteLength: number; readonly mode: number }
export interface FilesystemEntry extends FilesystemMetadata { readonly nameHex: string }
export interface FilesystemTerminal {
  readonly status: 'ready' | 'complete' | 'changed' | 'rejected' | 'failed' | 'cancelled' | 'uncertain' | 'cleanup_failed' | 'closed';
  readonly effect: 'none' | 'staged' | 'published';
  readonly errno: number;
  readonly count: string;
  readonly mode: number | null;
  readonly entry: FilesystemMetadata | null;
}
export type FilesystemReply =
  | Readonly<{ kind: 'bytes'; bytes: Uint8Array }>
  | Readonly<{ kind: 'entry'; entry: FilesystemEntry }>
  | Readonly<{ kind: 'terminal'; terminal: FilesystemTerminal }>
  | Readonly<{ kind: 'ready'; protocol: typeof FILESYSTEM_PROTOCOL; layout: typeof FILESYSTEM_LAYOUT; uid: number; gid: number }>
  | Readonly<{ kind: 'heartbeat' }>;
export type FilesystemRequest =
  | Readonly<{ operation: 'stat' | 'read' | 'list'; path: string }>
  | Readonly<{ operation: 'write'; path: string; mode: 'create' | 'replace' }>
  | Readonly<{ operation: 'append'; bytes: Uint8Array }>
  | Readonly<{ operation: 'next' | 'commit' | 'cancel' | 'close' | 'heartbeat' }>;

export function filesystemCommand(access: 'read' | 'read_write', leaseTimeoutMs: number): readonly string[] {
  if (!Number.isInteger(leaseTimeoutMs) || leaseTimeoutMs < 1 || leaseTimeoutMs > 2147483647) throw new TypeError('Invalid filesystem lease.');
  return Object.freeze([FILESYSTEM_STORE, access, String(leaseTimeoutMs)]);
}

const operations = { stat: 1, read: 2, list: 3, next: 4, write: 5, append: 6, commit: 7, cancel: 8, close: 9, heartbeat: 10 } as const;

export function encodeFilesystemRequest(request: FilesystemRequest): Uint8Array {
  let path = '';
  let flags = 0;
  let bytes: Uint8Array = new Uint8Array();
  if ('path' in request) {
    path = request.path === '.' && (request.operation === 'stat' || request.operation === 'list') ? '.' : parseSandboxRelativePath(request.path);
  }
  if (request.operation === 'write') {
    flags = request.mode === 'create' ? 1 : 2;
  }
  if (request.operation === 'append') {
    if (!(request.bytes instanceof Uint8Array) || request.bytes.byteLength < 1 || request.bytes.byteLength > FILESYSTEM_CHUNK_BYTES) throw new TypeError('Invalid filesystem chunk.');
    bytes = request.bytes;
  }
  const name = Buffer.from(path, 'utf8');
  if (name.toString('utf8') !== path) throw new TypeError('Filesystem paths require exact UTF-8 text.');
  const result = Buffer.alloc(16 + name.length + bytes.byteLength);
  result.writeUInt32BE(operations[request.operation], 0);
  result.writeUInt32BE(flags, 4);
  result.writeUInt32BE(name.length, 8);
  result.writeUInt32BE(bytes.byteLength, 12);
  name.copy(result, 16);
  result.set(bytes, 16 + name.length);
  return result;
}

function fields(input: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).length !== expected.length || Reflect.ownKeys(input).length !== expected.length
    || expected.some((key) => !Object.hasOwn(input, key))) throw new TypeError('Invalid filesystem response fields.');
  return input as Record<string, unknown>;
}
function integer(input: unknown, maximum: number): input is number { return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 && input <= maximum; }
function metadata(input: unknown, entry = false): FilesystemMetadata | FilesystemEntry {
  const value = fields(input, entry ? ['kind', 'byteLength', 'mode', 'nameHex'] : ['kind', 'byteLength', 'mode']);
  if (!['file', 'directory', 'symlink', 'unsupported_hardlink', 'unsupported_special'].includes(String(value.kind))
    || !integer(value.byteLength, Number.MAX_SAFE_INTEGER) || !integer(value.mode, 0o777)) throw new TypeError('Invalid filesystem metadata.');
  const result: FilesystemMetadata = { kind: value.kind as FilesystemKind, byteLength: value.byteLength, mode: value.mode };
  if (!entry) return result;
  if (typeof value.nameHex !== 'string' || !/^(?:[0-9a-f]{2}){1,255}$/u.test(value.nameHex)) throw new TypeError('Invalid filesystem child name.');
  const nameBytes = Buffer.from(value.nameHex, 'hex');
  const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(nameBytes);
  parseSandboxRelativePath(name);
  if (name.includes('/')) throw new TypeError('Filesystem entry must be a direct child.');
  return { ...result, nameHex: value.nameHex };
}

export function filesystemReplyLength(kind: number, length: number): void {
  if (!integer(length, kind === 1 ? FILESYSTEM_CHUNK_BYTES : FILESYSTEM_METADATA_BYTES)
    || !integer(kind, 5) || kind < 1 || (kind === 1 && length < 1) || (kind === 5 && length !== 0)) throw new TypeError('Invalid filesystem response frame.');
}

export function decodeFilesystemReply(kind: number, bytes: Uint8Array): FilesystemReply {
  filesystemReplyLength(kind, bytes.byteLength);
  if (kind === 1) return { kind: 'bytes', bytes: bytes.slice() };
  if (kind === 5) return { kind: 'heartbeat' };
  const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (kind === 2) return { kind: 'entry', entry: metadata(input, true) as FilesystemEntry };
  if (kind === 4) {
    const value = fields(input, ['protocol', 'layout', 'uid', 'gid']);
    if (value.protocol !== FILESYSTEM_PROTOCOL || value.layout !== FILESYSTEM_LAYOUT || !integer(value.uid, 262143) || !integer(value.gid, 262143)
      || value.uid === 0 || value.gid === 0) throw new TypeError('Invalid filesystem readiness.');
    return { kind: 'ready', protocol: FILESYSTEM_PROTOCOL, layout: FILESYSTEM_LAYOUT, uid: value.uid, gid: value.gid };
  }
  const value = fields(input, ['status', 'effect', 'errno', 'count', 'mode', 'entry']);
  if (!['ready', 'complete', 'changed', 'rejected', 'failed', 'cancelled', 'uncertain', 'cleanup_failed', 'closed'].includes(String(value.status))
    || !['none', 'staged', 'published'].includes(String(value.effect)) || !integer(value.errno, 4095)
    || typeof value.count !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value.count) || BigInt(value.count) > 18446744073709551615n
    || (value.mode !== null && !integer(value.mode, 0o777))) throw new TypeError('Invalid filesystem terminal response.');
  return { kind: 'terminal', terminal: { status: value.status as FilesystemTerminal['status'], effect: value.effect as FilesystemTerminal['effect'],
    errno: value.errno, count: value.count, mode: value.mode as number | null, entry: value.entry === null ? null : metadata(value.entry) } };
}
