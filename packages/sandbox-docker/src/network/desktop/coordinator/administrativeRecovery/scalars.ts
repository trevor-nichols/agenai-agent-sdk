import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { SandboxStateError } from '@agen-ai/sandbox';

export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const uuidSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
export const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const positiveSequenceSchema = sequenceSchema.min(1);
export const physicalIdSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u);
export const claimSchema = z.strictObject({ rootDevice: physicalIdSchema, rootInode: physicalIdSchema,
  lockDevice: physicalIdSchema, lockInode: physicalIdSchema }).readonly();
const executableSchema = z.strictObject({ path: z.string().refine((value) => value.startsWith('/') && value.isWellFormed()
  && Buffer.byteLength(value) <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value)
  && value.slice(1).split('/').every((part) => part !== '' && part !== '.' && part !== '..')),
sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).readonly();
export const originalHelperSchema = z.strictObject({ protocol: z.literal('agenai.desktop-coordinator.v1'),
  sourceDigest: digestSchema, executable: executableSchema }).readonly();
export const recoveryHelperSchema = z.strictObject({ protocol: z.literal('agenai.desktop-recovery-observer.v1'),
  sourceDigest: digestSchema, executable: executableSchema }).readonly();
export const endpointSchema = z.string().max(512).regex(/^unix:\/\/\/[a-zA-Z0-9_.\-/]+$/u)
  .refine((value) => !value.includes('//', 7) && value.slice(7).split('/').slice(1).every((part) => part !== '' && part !== '.' && part !== '..'));
export const transportAdmissionSchema = z.strictObject({ kind: z.literal('sdk-current-transport.v1'),
  admittedAtSequence: sequenceSchema, endpointDigest: digestSchema, nativeFactsDigest: digestSchema,
  engineFactsDigest: digestSchema }).readonly();
export type CurrentTransportAdmission = z.infer<typeof transportAdmissionSchema>;
export type RecoveryClaim = z.infer<typeof claimSchema>;
export type OriginalRecoveryHelper = z.infer<typeof originalHelperSchema>;
export type RecoveryHelper = z.infer<typeof recoveryHelperSchema>;

export class RecoveryJournalError extends SandboxStateError {
  constructor(readonly reason: 'invalid' | 'capacity' | 'unsupported_no_id_noncontainer' | 'transition' | 'publication' | 'evidence', message: string,
    options?: ErrorOptions) { super(message); this.name = 'RecoveryJournalError'; if (options && 'cause' in options) this.cause = options.cause; }
}

export function rawDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
export function immutable<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
export function jsonValue(text: string): unknown {
  try { return JSON.parse(text); } catch (cause) { throw new RecoveryJournalError('invalid', 'Recovery state requires complete JSON.', { cause }); }
}
export function requireByteBound(value: unknown, maximum: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) throw new RecoveryJournalError('capacity', `${label} exceeds its byte capacity.`);
}
