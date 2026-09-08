// ------------------------------------------------------------------------------------------------
//                accountQuota.ts - Bounded account allowance schemas - Dependencies: Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_ACCOUNT_QUOTA_MAX_BYTES,
  AGENT_ACCOUNT_QUOTA_MAX_LABEL_LENGTH,
  AGENT_ACCOUNT_QUOTA_MAX_SCOPE_IDS,
  AGENT_ACCOUNT_QUOTA_MAX_WINDOWS,
  AGENT_ACCOUNT_QUOTA_SCHEMA_VERSION,
  type AgentAccountQuotaSnapshot,
  type AgentAccountQuotaWindow,
} from '../accountQuota/types.js';
import { agentProtocolSerializedJsonBytes } from '../foundation/types.js';
import {
  AgentCanonicalIdValueSchema,
  AgentIsoDateTimeSchema,
  createAgentCanonicalOpaqueStringSchema,
  withAcyclicProtocolInput,
} from './foundation.js';

const LabelSchema = createAgentCanonicalOpaqueStringSchema(
  AGENT_ACCOUNT_QUOTA_MAX_LABEL_LENGTH,
  'Quota labels must be canonical and contain no control characters.',
);
const NonnegativeQuantitySchema = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const MinorUnitsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DurationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const AgentAccountQuotaApplicabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account') }).strict().readonly(),
  z.object({ kind: z.literal('product'), productId: AgentCanonicalIdValueSchema }).strict().readonly(),
  z.object({
    kind: z.literal('models'),
    modelIds: z.array(AgentCanonicalIdValueSchema).min(1).max(AGENT_ACCOUNT_QUOTA_MAX_SCOPE_IDS).readonly(),
  }).strict().readonly(),
  z.object({ kind: z.literal('unknown') }).strict().readonly(),
]);

export const AgentAccountQuotaPeriodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rolling'), durationSeconds: DurationSchema.optional() }).strict().readonly(),
  z.object({ kind: z.literal('fixed'), durationSeconds: DurationSchema.optional() }).strict().readonly(),
  z.object({ kind: z.literal('unknown'), durationSeconds: DurationSchema.optional() }).strict().readonly(),
  z.object({
    kind: z.literal('calendar'),
    unit: z.enum(['day', 'week', 'month', 'year']),
    timeZone: LabelSchema,
  }).strict().readonly(),
  z.object({ kind: z.literal('billing_cycle'), unit: z.enum(['month', 'year', 'unknown']) }).strict().readonly(),
]);

export const AgentAccountQuotaMeasurementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict().readonly(),
  z.object({ kind: z.literal('percentage'), usedPercent: NonnegativeQuantitySchema }).strict().readonly(),
  z.object({
    kind: z.literal('quantity'),
    unit: LabelSchema,
    used: NonnegativeQuantitySchema.optional(),
    limit: NonnegativeQuantitySchema.optional(),
    remaining: NonnegativeQuantitySchema.optional(),
    usedPercent: NonnegativeQuantitySchema.optional(),
  }).strict().readonly(),
  z.object({
    kind: z.literal('money'),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    scale: z.number().int().min(0).max(9),
    usedMinorUnits: MinorUnitsSchema.optional(),
    limitMinorUnits: MinorUnitsSchema.optional(),
    remainingMinorUnits: MinorUnitsSchema.optional(),
    usedPercent: NonnegativeQuantitySchema.optional(),
  }).strict().readonly(),
]);

export const AgentAccountQuotaWindowPortableSchema = z.object({
  poolId: AgentCanonicalIdValueSchema,
  windowId: AgentCanonicalIdValueSchema,
  label: LabelSchema,
  allowanceKind: z.enum(['included', 'extra', 'reserve', 'unknown']),
  applicability: AgentAccountQuotaApplicabilitySchema,
  period: AgentAccountQuotaPeriodSchema,
  measurement: AgentAccountQuotaMeasurementSchema,
  observedAt: AgentIsoDateTimeSchema,
  startsAt: AgentIsoDateTimeSchema.optional(),
  reset: z.object({
    at: AgentIsoDateTimeSchema,
    precision: z.enum(['reported', 'estimated']),
    observedAt: AgentIsoDateTimeSchema,
  }).strict().readonly().optional(),
}).strict().readonly();

function validateWindow(
  window: AgentAccountQuotaWindow,
  context: z.RefinementCtx,
  prefix: readonly (string | number)[] = [],
): void {
  if (window.applicability.kind === 'models'
    && new Set(window.applicability.modelIds).size !== window.applicability.modelIds.length) {
    context.addIssue({ code: 'custom', path: [...prefix, 'applicability', 'modelIds'], message: 'Model applicability IDs must be unique.' });
  }
  const measurement = window.measurement;
  if (measurement.kind === 'quantity'
    && measurement.used === undefined && measurement.limit === undefined
    && measurement.remaining === undefined) {
    context.addIssue({ code: 'custom', path: [...prefix, 'measurement'], message: 'A quantity measurement requires a reported quantity.' });
  }
  if (measurement.kind === 'money'
    && measurement.usedMinorUnits === undefined && measurement.limitMinorUnits === undefined
    && measurement.remainingMinorUnits === undefined) {
    context.addIssue({ code: 'custom', path: [...prefix, 'measurement'], message: 'A money measurement requires a reported exact amount.' });
  }
  if (window.startsAt && window.reset && Date.parse(window.startsAt) >= Date.parse(window.reset.at)) {
    context.addIssue({ code: 'custom', path: [...prefix, 'reset', 'at'], message: 'A period reset must follow its start.' });
  }
  if (window.reset && Date.parse(window.reset.observedAt) > Date.parse(window.observedAt)) {
    context.addIssue({ code: 'custom', path: [...prefix, 'reset', 'observedAt'], message: 'Reset evidence cannot be newer than the window observation.' });
  }
}

export const AgentAccountQuotaWindowSchema: z.ZodType<AgentAccountQuotaWindow> =
  withAcyclicProtocolInput(AgentAccountQuotaWindowPortableSchema, {
    maxDepth: 6,
    maxCollectionLength: AGENT_ACCOUNT_QUOTA_MAX_SCOPE_IDS,
  }).superRefine(validateWindow);

const snapshotBase = {
  schemaVersion: z.literal(AGENT_ACCOUNT_QUOTA_SCHEMA_VERSION),
  sourceId: AgentCanonicalIdValueSchema,
  observedAt: AgentIsoDateTimeSchema,
};

export const AgentAccountQuotaSnapshotPortableSchema = z.discriminatedUnion('state', [
  z.object({
    ...snapshotBase,
    state: z.literal('available'),
    completeness: z.enum(['complete', 'partial']),
    accountLabel: LabelSchema.optional(),
    planLabel: LabelSchema.optional(),
    windows: z.array(AgentAccountQuotaWindowPortableSchema).max(AGENT_ACCOUNT_QUOTA_MAX_WINDOWS).readonly(),
    allowance: z.object({
      included: z.enum(['allowed', 'exhausted', 'unknown']),
      extra: z.enum(['allowed', 'unavailable', 'unknown']),
      reserve: z.enum(['allowed', 'unavailable', 'unknown']),
    }).strict().readonly(),
  }).strict().readonly(),
  z.object({ ...snapshotBase, state: z.literal('authentication_required') }).strict().readonly(),
  z.object({ ...snapshotBase, state: z.literal('inapplicable') }).strict().readonly(),
  z.object({ ...snapshotBase, state: z.literal('temporarily_unavailable') }).strict().readonly(),
]);

export const AgentAccountQuotaSnapshotSchema: z.ZodType<AgentAccountQuotaSnapshot> =
  withAcyclicProtocolInput(AgentAccountQuotaSnapshotPortableSchema, {
    maxDepth: 8,
    maxCollectionLength: AGENT_ACCOUNT_QUOTA_MAX_WINDOWS,
  }).superRefine((snapshot, context) => {
    if (agentProtocolSerializedJsonBytes(snapshot) > AGENT_ACCOUNT_QUOTA_MAX_BYTES) {
      context.addIssue({ code: 'custom', message: 'Account quota snapshot exceeds its serialized byte limit.' });
    }
    if (snapshot.state !== 'available') return;
    const identities = new Map<string, Set<string>>();
    snapshot.windows.forEach((window, index) => {
      const windows = identities.get(window.poolId) ?? new Set<string>();
      if (windows.has(window.windowId)) {
        context.addIssue({ code: 'custom', path: ['windows', index, 'windowId'], message: 'Window IDs must be unique within each pool.' });
      }
      windows.add(window.windowId);
      identities.set(window.poolId, windows);
      validateWindow(window, context, ['windows', index]);
      if (Date.parse(window.observedAt) > Date.parse(snapshot.observedAt)) {
        context.addIssue({ code: 'custom', path: ['windows', index, 'observedAt'], message: 'Window evidence cannot be newer than its snapshot.' });
      }
    });
  });
