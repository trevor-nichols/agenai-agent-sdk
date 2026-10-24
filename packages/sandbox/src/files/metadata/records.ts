// ------------------------------------------------------------------------------------------------
//                records.ts - Component-ordered UTF-8 keys and metadata conflict receipts
// ------------------------------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import { SandboxValidationError } from '../../errors.js';
import { SANDBOX_LIMITS } from '../../policy/limits.js';
import { parseSandboxRelativePath } from '../paths.js';
import type { MetadataRecord } from './types.js';

export const RECORD_HEADER_BYTES = 5;
export const DESCRIPTOR_BYTES = 16;
export const MAX_RECORD_BYTES = SANDBOX_LIMITS.maxPathBytes + RECORD_HEADER_BYTES;

export interface EncodedRecord {
  readonly kind: MetadataRecord['kind'];
  readonly key: Buffer;
}

export class MetadataConflictError extends SandboxValidationError {
  constructor(readonly code: 'duplicate_path' | 'file_ancestor', readonly path: string) {
    super([{ code: 'invalid_input', path: ['path'], message: `Metadata ${code}: ${path}` }]);
    this.name = 'MetadataConflictError';
  }
}

export function encodeRecord(record: MetadataRecord): EncodedRecord {
  const key = Buffer.from(record.path, 'utf8');
  // NUL sorts a completed component before every valid byte in the next component.
  for (let index = 0; index < key.length; index += 1) if (key[index] === 47) key[index] = 0;
  return { kind: record.kind, key };
}

export function decodeRecord(record: EncodedRecord): MetadataRecord {
  const encoded = record.key.toString('utf8');
  if (record.key.includes(47) || !Buffer.from(encoded, 'utf8').equals(record.key)) {
    throw new Error('Spill path encoding is invalid.');
  }
  return Object.freeze({ kind: record.kind, path: parseSandboxRelativePath(encoded.replaceAll('\0', '/')) });
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
  header[4] = record.kind === 'file' ? 1 : 2;
  return header;
}
