// ------------------------------------------------------------------------------------------------
//                schemas.ts - Internal bounded policy and identity schema composition
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { utf8Within } from '../internal/data.js';
import { SANDBOX_LIMITS } from './limits.js';
import { networkAllowlistSupportSchema, networkSchema } from './network.js';
import type { SandboxId, SandboxNamespace, SandboxProcessId } from './types.js';

const safeIdentity = (value: unknown, maximum: number): value is string => typeof value === 'string'
  && value.length > 0 && utf8Within(value, maximum) && !/[\u0000-\u0020\u007f/\\]/u.test(value);

export const identitySchema = z.string().refine((value) => safeIdentity(value, SANDBOX_LIMITS.maxIdentityBytes), 'Expected a bounded identity without whitespace or separators');
export const namespaceSchema = z.custom<SandboxNamespace>((value) => safeIdentity(value, SANDBOX_LIMITS.maxNamespaceBytes), 'Expected a bounded namespace');
export const sandboxIdSchema = z.custom<SandboxId>((value) => safeIdentity(value, SANDBOX_LIMITS.maxIdentityBytes), 'Expected a bounded sandbox ID');
export const processIdSchema = z.custom<SandboxProcessId>((value) => safeIdentity(value, SANDBOX_LIMITS.maxIdentityBytes), 'Expected a bounded process ID');
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bounded = (maximum: number) => positiveInteger.max(maximum);
const resourcesSchema = z.strictObject({ cpus: z.number().finite().positive(), memoryBytes: positiveInteger, pids: positiveInteger });
const temporaryStorageSchema = z.strictObject({ homeBytes: positiveInteger, tempBytes: positiveInteger });
const noWorkspaceDiskQuotaSchema = z.strictObject({ kind: z.literal('not_requested') });
const workspaceDiskQuotaSchema = z.discriminatedUnion('kind', [
  noWorkspaceDiskQuotaSchema,
  z.strictObject({ kind: z.literal('required'), bytes: positiveInteger, accounting: z.literal('allocated_blocks') }),
]);
const executionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('until_stopped') }),
  z.strictObject({ kind: z.literal('deadline'), timeoutMs: positiveInteger }),
]);
const fileAccessSchema = z.strictObject({ kind: z.enum(['disabled', 'read_only', 'read_write']) });
const fileSupportSchema = z.union([z.literal(false), z.strictObject({ read: z.literal(true), write: z.boolean() })]);

export const transferBuffersSchema = z.strictObject({
  chunkBytes: bounded(SANDBOX_LIMITS.maxTransferChunkBytes).min(512),
  metadataBatchBytes: bounded(SANDBOX_LIMITS.maxMetadataBatchBytes).min(SANDBOX_LIMITS.minMetadataBatchBytes),
  metadataMergeFanIn: bounded(SANDBOX_LIMITS.maxMetadataMergeFanIn).min(2),
});

export const streamLimitsSchema = z.strictObject({
  maxStdinBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  maxOutputBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  maxBufferedInputBytes: bounded(SANDBOX_LIMITS.maxBufferedInputBytes),
  maxBufferedOutputBytes: bounded(SANDBOX_LIMITS.maxBufferedOutputBytes),
  highWaterMarkBytes: bounded(SANDBOX_LIMITS.highWaterMarkBytes),
}).refine((value) => value.highWaterMarkBytes <= value.maxBufferedOutputBytes
  && value.highWaterMarkBytes <= value.maxBufferedInputBytes, 'Stream high-water mark must fit within its buffer bounds');

export const policySchema = z.strictObject({
  resources: resourcesSchema,
  temporaryStorage: temporaryStorageSchema,
  network: networkSchema,
  files: fileAccessSchema.default({ kind: 'disabled' }),
  workspaceDiskQuota: workspaceDiskQuotaSchema.default({ kind: 'not_requested' }),
  execution: executionSchema.default({ kind: 'until_stopped' }),
  deadlines: z.strictObject({ startupMs: bounded(SANDBOX_LIMITS.startupMs), cleanupMs: bounded(SANDBOX_LIMITS.cleanupMs) }),
  transfers: transferBuffersSchema,
  streams: streamLimitsSchema,
});
export const requestSchema = z.strictObject({ policy: policySchema });
export const supportSchema = z.strictObject({
  backendId: identitySchema,
  backendRevision: identitySchema,
  networkModes: z.array(z.enum(['isolated', 'outbound', 'restricted_https'])).min(1).max(3).refine((modes) => new Set(modes).size === modes.length, 'Network modes must be unique'),
  workspaceDiskQuota: z.literal(false),
  networkAllowlist: networkAllowlistSupportSchema,
  independentProcessTermination: z.literal(false),
  files: fileSupportSchema.default(false),
  transferSymlinks: z.union([z.literal(false), z.strictObject({ kind: z.literal('preserve_internal'), import: z.literal('empty_workspace') })]).default(false),
}).refine((support) => support.networkModes.includes('restricted_https') === (support.networkAllowlist !== false),
  'Restricted HTTPS networking requires exactly its declared HTTPS CONNECT support');
export const effectiveSchema = z.strictObject({
  backendIdentity: identitySchema,
  isolation: z.enum(['container', 'virtual_machine']),
  resources: resourcesSchema,
  temporaryStorage: temporaryStorageSchema,
  network: networkSchema,
  files: fileAccessSchema.default({ kind: 'disabled' }),
  nonRoot: z.literal(true),
  readOnlyRoot: z.literal(true),
  workspaceDiskQuota: noWorkspaceDiskQuotaSchema,
});

