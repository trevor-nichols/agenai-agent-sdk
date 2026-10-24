// ------------------------------------------------------------------------------------------------
//                pax.ts - Bounded local path and inert timestamp records - No sparse/size overrides
// ------------------------------------------------------------------------------------------------

import { archiveName, unsafeArchive } from '../paths.js';
import { text } from './header.js';

export function parsePax(bytes: Uint8Array): string | undefined {
  const keys = new Set<string>();
  let offset = 0;
  let path: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || space - offset > 5) unsafeArchive('PAX requires bounded decimal lengths.');
    const digits = text(bytes.subarray(offset, space));
    if (!/^[1-9][0-9]*$/u.test(digits)) unsafeArchive('PAX length must be canonical decimal.');
    const end = offset + Number(digits);
    if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) unsafeArchive('PAX length or newline mismatch.');
    const record = text(bytes.subarray(space + 1, end - 1));
    const equals = record.indexOf('=');
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (equals <= 0 || keys.has(key)) unsafeArchive('PAX keys must be unique.');
    keys.add(key);
    if (key === 'path') { archiveName(value, true); path = value; }
    else if (!['mtime', 'atime', 'ctime'].includes(key) || !/^-?[0-9]{1,16}(?:\.[0-9]{1,9})?$/u.test(value)) {
      unsafeArchive('only path and inert timestamps are supported in PAX records.');
    }
    offset = end;
  }
  return path;
}

export function encodePaxPath(path: string): Uint8Array {
  const payload = ` path=${path}\n`;
  let size = Buffer.byteLength(payload) + 1;
  while (String(size).length + Buffer.byteLength(payload) !== size) size = String(size).length + Buffer.byteLength(payload);
  return Buffer.from(`${size}${payload}`);
}
