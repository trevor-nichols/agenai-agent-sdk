// ------------------------------------------------------------------------------------------------
//                records.ts - Component-ordered UTF-8 keys and metadata conflict receipts
// ------------------------------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import { SANDBOX_LIMITS } from '../../policy/limits.js';
import { parseSandboxRelativePath, parseSandboxSymlinkTarget } from '../paths.js';
import type { MetadataRecord } from './types.js';

export const RECORD_HEADER_BYTES = 9;
export const DESCRIPTOR_BYTES = 16;
export const MAX_RECORD_BYTES = SANDBOX_LIMITS.minMetadataBatchBytes;

export interface EncodedRecord {
  readonly kind: MetadataRecord['kind'];
  readonly key: Buffer;
  readonly target: Buffer;
}

export function encodeRecord(record: MetadataRecord): EncodedRecord {
  const key = Buffer.from(record.path, 'utf8');
  // NUL sorts a completed component before every valid byte in the next component.
  for (let index = 0; index < key.length; index += 1) if (key[index] === 47) key[index] = 0;
  return { kind: record.kind, key, target: record.kind === 'symlink' ? Buffer.from(record.target, 'utf8') : Buffer.alloc(0) };
}

export function decodeRecord(record: EncodedRecord): MetadataRecord {
  const encoded = record.key.toString('utf8');
  if (record.key.includes(47) || !Buffer.from(encoded, 'utf8').equals(record.key)) {
    throw new Error('Spill path encoding is invalid.');
  }
  const path = parseSandboxRelativePath(encoded.replaceAll('\0', '/'));
  if (record.kind === 'symlink') {
    const target = record.target.toString('utf8');
    if (!Buffer.from(target, 'utf8').equals(record.target)) throw new Error('Spill target encoding is invalid.');
    return Object.freeze({ kind: record.kind, path, target: parseSandboxSymlinkTarget(target) });
  }
  if (record.target.length !== 0) throw new Error('Non-link spill metadata cannot carry a target.');
  return Object.freeze({ kind: record.kind, path });
}

export function compareRecords(left: EncodedRecord, right: EncodedRecord): number {
  return Buffer.compare(left.key, right.key);
}

export function isDescendant(record: EncodedRecord, ancestor: EncodedRecord): boolean {
  return record.key.length > ancestor.key.length && record.key[ancestor.key.length] === 0
    && record.key.subarray(0, ancestor.key.length).equals(ancestor.key);
}

export function recordHeader(record: EncodedRecord): Buffer {
  const header = Buffer.alloc(RECORD_HEADER_BYTES);
  header.writeUInt32BE(record.key.length);
  header.writeUInt32BE(record.target.length, 4);
  header[8] = record.kind === 'file' ? 1 : record.kind === 'directory' ? 2 : 3;
  return header;
}
