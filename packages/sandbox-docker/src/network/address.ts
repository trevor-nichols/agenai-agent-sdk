// ------------------------------------------------------------------------------------------------
//                address.ts - Canonical numeric address admission, representation and prefix arithmetic
// ------------------------------------------------------------------------------------------------

import { isIP } from 'node:net';

export type AddressFamily = 4 | 6;
export interface NumericAddress { readonly family: AddressFamily; readonly value: bigint }

function numericValue(address: string, family: AddressFamily): bigint {
  if (family === 4) return address.split('.').reduce((value, part) => value * 256n + BigInt(part), 0n);
  let value = address;
  if (value.includes('.')) {
    const index = value.lastIndexOf(':');
    const ipv4 = numericValue(value.slice(index + 1), 4);
    value = `${value.slice(0, index)}:${(ipv4 >> 16n).toString(16)}:${(ipv4 & 65535n).toString(16)}`;
  }
  const [left, right] = value.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const words = right === undefined ? before : [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after];
  return words.reduce((result, word) => result * 65536n + BigInt(`0x${word}`), 0n);
}

/** Numeric literals are parsed once, without hostname resolution or accepting interface zones. */
export function parseNumericAddress(address: string): NumericAddress | undefined {
  const family = isIP(address);
  if ((family !== 4 && family !== 6) || address.includes('%')) return undefined;
  return Object.freeze({ family, value: numericValue(address, family) });
}

/** Native observer documents use separate address-family/zone fields and forbid mapped text. */
export function nativeAddressNumber(value: string, family: AddressFamily): bigint {
  const address = parseNumericAddress(value);
  if (value.length > 45 || address === undefined || address.family !== family) throw new TypeError('A complete numeric address without a zone is required.');
  if (family === 6 && value.includes('.')) throw new TypeError('IPv4-mapped IPv6 observation addresses are unsupported.');
  return address.value;
}

export function formatNumericAddress(value: bigint, family: AddressFamily): string {
  if (family === 4) return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join('.');
  return Array.from({ length: 8 }, (_, index) => ((value >> BigInt((7 - index) * 16)) & 65535n).toString(16)).join(':');
}

export function addressWidth(family: AddressFamily): number { return family === 4 ? 32 : 128; }

export function prefixMask(family: AddressFamily, prefix: number): bigint {
  const width = addressWidth(family);
  if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > width) throw new TypeError('Invalid numeric address prefix.');
  return ((1n << BigInt(width)) - 1n) ^ ((1n << BigInt(width - prefix)) - 1n);
}
