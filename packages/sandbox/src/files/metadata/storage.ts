// ------------------------------------------------------------------------------------------------
//                storage.ts - Exact bounded record I/O and safe native spill addresses
// ------------------------------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import type { SandboxDriverSpillFile } from '../../backend/spill.js';
import { SANDBOX_LIMITS } from '../../policy/limits.js';
import { DESCRIPTOR_BYTES, RECORD_HEADER_BYTES, recordHeader } from './records.js';
import type { EncodedRecord } from './records.js';

export interface RunCursor {
  position: number;
  readonly end: number;
}

export function address(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Spill address exceeds its safe-integer representation.');
  return value;
}

async function writeAll(file: SandboxDriverSpillFile, bytes: Uint8Array, position: number): Promise<number> {
  address(position + bytes.length);
  let written = 0;
  while (written < bytes.length) {
    const remaining = bytes.length - written;
    const { bytesWritten } = await file.write(bytes, written, remaining, position + written);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error('Spill write returned an invalid progress receipt.');
    }
    written += bytesWritten;
  }
  return position + written;
}

async function readExact(file: SandboxDriverSpillFile, length: number, position: number): Promise<Buffer> {
  address(position + length);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const remaining = length - read;
    const { bytesRead } = await file.read(buffer, read, remaining, position + read);
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > remaining) {
      throw new Error('Spill read returned truncated data or an invalid progress receipt.');
    }
    read += bytesRead;
  }
  return buffer;
}

export async function writeRecord(file: SandboxDriverSpillFile, record: EncodedRecord, position: number): Promise<number> {
  return writeAll(file, record.target, await writeAll(file, record.key, await writeAll(file, recordHeader(record), position)));
}

export async function readRecord(file: SandboxDriverSpillFile, cursor: RunCursor): Promise<EncodedRecord | undefined> {
  if (cursor.position === cursor.end) return undefined;
  if (cursor.end - cursor.position < RECORD_HEADER_BYTES) throw new Error('Spill record header is truncated.');
  const header = await readExact(file, RECORD_HEADER_BYTES, cursor.position);
  const length = header.readUInt32BE(0);
  const targetLength = header.readUInt32BE(4);
  const kind = header[8];
  if (length < 1 || length > SANDBOX_LIMITS.maxPathBytes || (kind !== 1 && kind !== 2 && kind !== 3)
    || targetLength > SANDBOX_LIMITS.maxSymlinkTargetBytes || (kind === 3 ? targetLength === 0 : targetLength !== 0)
    || cursor.end - cursor.position - RECORD_HEADER_BYTES < length + targetLength) throw new Error('Spill record metadata is invalid.');
  const key = await readExact(file, length, cursor.position + RECORD_HEADER_BYTES);
  const target = await readExact(file, targetLength, cursor.position + RECORD_HEADER_BYTES + length);
  cursor.position = address(cursor.position + RECORD_HEADER_BYTES + length + targetLength);
  return { kind: kind === 1 ? 'file' : kind === 2 ? 'directory' : 'symlink', key, target };
}

export async function writeOffset(file: SandboxDriverSpillFile, ordinal: number, position: number): Promise<void> {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(address(position)));
  await writeAll(file, bytes, address(ordinal * 8));
}

export async function readOffset(file: SandboxDriverSpillFile, ordinal: number): Promise<number> {
  const bytes = await readExact(file, 8, address(ordinal * 8));
  const value = bytes.readBigUInt64BE();
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Spill index offset exceeds its safe address representation.');
  return Number(value);
}

export async function writeDescriptor(file: SandboxDriverSpillFile, position: number, start: number, end: number): Promise<number> {
  const buffer = Buffer.alloc(DESCRIPTOR_BYTES);
  buffer.writeBigUInt64BE(BigInt(address(start)));
  buffer.writeBigUInt64BE(BigInt(address(end)), 8);
  return writeAll(file, buffer, position);
}

export async function readDescriptor(file: SandboxDriverSpillFile, position: number): Promise<RunCursor> {
  const buffer = await readExact(file, DESCRIPTOR_BYTES, position);
  const first = buffer.readBigUInt64BE(0);
  const last = buffer.readBigUInt64BE(8);
  if (first > BigInt(Number.MAX_SAFE_INTEGER) || last > BigInt(Number.MAX_SAFE_INTEGER) || last <= first) {
    throw new Error('Spill run descriptor exceeds its safe address representation.');
  }
  return { position: Number(first), end: Number(last) };
}
