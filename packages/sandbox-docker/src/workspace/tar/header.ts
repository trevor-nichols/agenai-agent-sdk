// ------------------------------------------------------------------------------------------------
//                header.ts - Strict POSIX ustar numeric and entry metadata - Docker wire boundary
// ------------------------------------------------------------------------------------------------

import { SandboxUnsupportedError } from '@agen-ai/sandbox';
import { archiveName, unsafeArchive } from '../paths.js';
import type { TarHeader, TarInputEntry } from './contracts.js';

export const BLOCK_BYTES = 512;
export const MAX_OCTAL_SIZE = 8 * 1024 ** 3 - 1;
export const MAX_PAX_BYTES = 4096;
export const MAX_TRAILER_BYTES = 10 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function text(bytes: Uint8Array): string {
  try { return utf8.decode(bytes); }
  catch { return unsafeArchive('header text must be valid UTF-8.'); }
}

function field(block: Uint8Array, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const terminator = bytes.indexOf(0);
  if (terminator < 0) return text(bytes);
  if (bytes.subarray(terminator).some((byte) => byte !== 0)) unsafeArchive('hidden bytes after a text terminator.');
  return text(bytes.subarray(0, terminator));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const bytes = block.subarray(offset, offset + length);
  if (bytes.some((byte) => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) unsafeArchive('numeric headers require unsigned octal.');
  const encoded = text(bytes);
  if (!/^[ \0]*[0-7]*[ \0]*$/u.test(encoded)) unsafeArchive('numeric headers require unsigned octal.');
  const digits = encoded.replace(/^[ \0]+|[ \0]+$/gu, '');
  const value = digits ? Number.parseInt(digits, 8) : 0;
  if (!Number.isSafeInteger(value)) unsafeArchive('numeric header exceeds the safe integer range.');
  return value;
}

export function parseHeader(block: Uint8Array): TarHeader {
  const checksum = octal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK_BYTES; index += 1) sum += index >= 148 && index < 156 ? 32 : block[index];
  if (sum !== checksum) unsafeArchive('checksum mismatch.');
  if (field(block, 257, 6) !== 'ustar' || text(block.subarray(263, 265)) !== '00') unsafeArchive('only POSIX ustar/PAX is supported.');
  const flag = block[156];
  const kind = flag === 53 ? 'directory' : flag === 48 || flag === 0 ? 'file' : flag === 120 ? 'pax' : undefined;
  if (!kind) unsafeArchive('only regular files, directories and local PAX records are supported; links and special files are forbidden.');
  if (field(block, 157, 100)) unsafeArchive('links and link metadata are forbidden.');
  const prefix = field(block, 345, 155);
  const name = field(block, 0, 100);
  const path = prefix ? `${prefix}/${name}` : name;
  archiveName(path, kind !== 'file');
  const mode = octal(block, 100, 8);
  const size = octal(block, 124, 12);
  for (const [offset, length] of [[108, 8], [116, 8], [136, 12], [329, 8], [337, 8]]) octal(block, offset, length);
  field(block, 265, 32);
  field(block, 297, 32);
  if (mode > 0o7777 || size > MAX_OCTAL_SIZE || block.subarray(500).some((byte) => byte !== 0)) unsafeArchive('unsupported numeric or extension metadata.');
  if (kind === 'directory' && size !== 0) unsafeArchive('directory entries cannot carry payload.');
  return { path, kind, mode, size };
}

function putOctal(header: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value.toString(8).length >= length) {
    throw new SandboxUnsupportedError('Docker tar metadata exceeds the selected unsigned-octal representation.');
  }
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
}

export function makeHeader(entry: Omit<TarInputEntry, 'body' | 'kind'> & { readonly kind: TarHeader['kind'] }): Uint8Array {
  if (Buffer.byteLength(entry.path) > 100 || entry.mode > 0o7777) throw new SandboxUnsupportedError('Docker tar header name or mode is not representable.');
  const header = Buffer.alloc(BLOCK_BYTES);
  header.write(entry.path, 0, 100, 'utf8');
  for (const [offset, length, value] of [[100, 8, entry.mode], [108, 8, entry.uid], [116, 8, entry.gid], [124, 12, entry.size], [136, 12, 0], [329, 8, 0], [337, 8, 0]]) {
    putOctal(header, offset, length, value);
  }
  header[156] = entry.kind === 'directory' ? 53 : entry.kind === 'pax' ? 120 : 48;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.fill(32, 148, 156);
  header.write(header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  return header;
}
