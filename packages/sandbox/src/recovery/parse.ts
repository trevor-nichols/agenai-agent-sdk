// ------------------------------------------------------------------------------------------------
//                parse.ts - Strict bounded recovery evidence and explicit persistence admission
// ------------------------------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import { z } from 'zod/v4';
import { SandboxValidationError } from '../errors.js';
import { captureData, invalidInput } from '../internal/data.js';
import { parseData } from '../internal/parse.js';
import { SANDBOX_LIMITS } from '../policy/limits.js';
import { identitySchema, namespaceSchema, sandboxIdSchema } from '../policy/schemas.js';
import type { SandboxRecoveryPolicy, SandboxRecoveryRecord } from './types.js';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const resourceSchema = z.strictObject({
  role: z.enum(['compute', 'storage', 'export', 'network']),
  name: identitySchema,
  identity: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('planned') }),
    z.strictObject({ kind: z.literal('creating') }),
    z.strictObject({ kind: z.literal('identified'), id: identitySchema, fingerprint: digestSchema }),
  ]),
});
const recoverySchema = z.strictObject({
  format: z.literal('agenai.sandbox-recovery.v2'),
  backendId: identitySchema,
  backendRevision: identitySchema,
  namespace: namespaceSchema,
  operationId: identitySchema,
  sandboxId: sandboxIdSchema,
  imageDigest: digestSchema,
  policyDigest: digestSchema,
  configurationDigest: digestSchema,
  phase: z.enum(['reserved', 'starting', 'running', 'stopping', 'stopped', 'destroying', 'destroyed', 'uncertain']),
  authority: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('unverified') }),
    z.strictObject({ kind: z.literal('verified'), backendIdentity: identitySchema }),
  ]),
  resources: z.array(resourceSchema).min(1).max(4),
}).superRefine((record, context) => {
  if (new Set(record.resources.map((resource) => resource.role)).size !== record.resources.length) context.addIssue({ code: 'custom', path: ['resources'], message: 'Recovery resource roles must be unique' });
  if (new Set(record.resources.map((resource) => resource.name)).size !== record.resources.length) context.addIssue({ code: 'custom', path: ['resources'], message: 'Recovery resource names must be unique' });
  if (record.authority.kind === 'unverified' && (record.phase !== 'reserved' || record.resources.some((resource) => resource.identity.kind !== 'planned'))) {
    context.addIssue({ code: 'custom', path: ['authority'], message: 'Entered resource operations require verified backend authority' });
  }
});

export function parseSandboxRecoveryRecord(input: unknown): SandboxRecoveryRecord {
  const captured = captureData(input);
  const serialized = JSON.stringify(captured);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > SANDBOX_LIMITS.maxRecoveryBytes) invalidInput('Recovery record exceeds its serialized UTF-8 bound');
  return parseData(recoverySchema, captured);
}

export function parseSandboxRecoveryPolicy(input: unknown): SandboxRecoveryPolicy {
  if (input === null || typeof input !== 'object'
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) invalidInput('Recovery policy must be a plain object');
  const keys = Reflect.ownKeys(input);
  const kind = Object.getOwnPropertyDescriptor(input, 'kind');
  if (kind === undefined || !('value' in kind)) invalidInput('Recovery policy requires a data kind');
  if (kind.value === 'in_process' && keys.length === 1) return Object.freeze({ kind: 'in_process' });
  const persist = Object.getOwnPropertyDescriptor(input, 'persist');
  if (kind.value !== 'persisted' || keys.length !== 2 || persist === undefined || !('value' in persist) || typeof persist.value !== 'function') invalidInput('Persisted recovery requires only a persist function');
  const callback: (record: SandboxRecoveryRecord) => unknown = persist.value;
  return Object.freeze({ kind: 'persisted', async persist(record: SandboxRecoveryRecord): Promise<void> {
    const result = callback(record);
    if (result === null || typeof result !== 'object' || !('then' in result) || typeof result.then !== 'function') {
      throw new SandboxValidationError([{ code: 'invalid_input', path: ['persist'], message: 'Recovery persistence must return a promise' }]);
    }
    await result;
  } });
}
