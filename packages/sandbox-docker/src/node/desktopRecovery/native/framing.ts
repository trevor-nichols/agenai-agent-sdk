import { createHash } from 'node:crypto';
import { RECOVERY_NATIVE_LIMITS } from './schemas.js';
import type { RecoveryNativeReceipt } from './schemas.js';

export function bareDigest(value: string): string {
  const result = value.startsWith('sha256:') ? value.slice(7) : value;
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new TypeError('Recovery native digest must be an exact SHA-256.');
  return result;
}

export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function countedCommand(command: string, text: string, maximum: number): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const control = Buffer.from(`${command} ${payload.length}\n`, 'ascii');
  if (!text.isWellFormed() || payload.length < 1 || payload.length > maximum
    || control.length > 512 || !/^[A-Z_]+(?: [a-z0-9_-]+)* [0-9]+\n$/u.test(control.toString('ascii'))) {
    throw new TypeError('Recovery command exceeds its closed native framing contract.');
  }
  return Buffer.concat([control, payload, Buffer.from('\n')]);
}

export function receiptFrame(response: RecoveryNativeReceipt, engineKey: string, recoveryKey: string): Buffer {
  if (!response.text.isWellFormed()) throw new TypeError('Recovery receipt requires complete UTF-8.');
  const payload = Buffer.from(response.text, 'utf8');
  if (response.recordKind === 'origin_archive' || response.recordKind === 'terminal_archive') {
    return Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${engineKey}\n${digestBytes(payload)}\n`), payload]);
  }
  if (payload.length + RECOVERY_NATIVE_LIMITS.frameHeaderBytes > RECOVERY_NATIVE_LIMITS.frameBytes) {
    throw new TypeError('Recovery receipt exceeds its immutable frame capacity.');
  }
  const text = `AGENAI-RECOVERY-1\n${engineKey}\n${recoveryKey}\n${response.recordKind}\n${response.scope}\n${payload.length}\n${digestBytes(payload)}\n`;
  const header = Buffer.alloc(RECOVERY_NATIVE_LIMITS.frameHeaderBytes);
  if (Buffer.byteLength(text) > header.length) throw new TypeError('Recovery receipt header exceeds its fixed capacity.');
  header.write(text, 'ascii');
  return Buffer.concat([header, payload]);
}
