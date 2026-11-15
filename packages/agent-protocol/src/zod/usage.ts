// ------------------------------------------------------------------------------------------------
//                usage.ts - Token-usage observation and capability schemas - Dependencies: Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { AGENT_PROTOCOL_COLLECTION_MAX_LENGTH } from '../foundation/types.js';
import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS,
  AGENT_TOKEN_USAGE_COUNTER_SUBSETS,
  AGENT_TOKEN_USAGE_COUNTERS,
  AGENT_TOKEN_USAGE_GAP_REASONS,
  AGENT_TOKEN_USAGE_LIMITS,
  AGENT_TOKEN_USAGE_SCOPE_KINDS,
  type AgentTokenCount,
  type AgentTokenUsageCapability,
  type AgentTokenUsageCounters,
  type AgentTokenUsageObservation,
  type AgentUsageCountBasis,
  type AgentUsageModel,
} from '../usage/types.js';
import { addCanonicalListIssues } from './canonicalLists.js';
import {
  AgentTurnIdSchema,
  AgentUsageObservationIdSchema,
  AgentUsagePopulationIdSchema,
  AgentUsageScopeIdSchema,
  AgentUsageViewIdSchema,
  createAgentCanonicalOpaqueStringSchema,
  withAcyclicProtocolInput,
} from './foundation.js';

// ------------------------------------------------------------------------------------------------
//                Counts and Reasons
// ------------------------------------------------------------------------------------------------

const TokenValueSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const GapReasonSchema = z.enum(AGENT_TOKEN_USAGE_GAP_REASONS);

function asNonEmptyList<Item>(schema: z.ZodType<readonly Item[]>): z.ZodType<readonly [Item, ...Item[]]> {
  // A minimum length of one admits exactly the nonempty tuple type; this type-only assertion names
  // it while keeping the portable JSON Schema a strict array.
  return schema as unknown as z.ZodType<readonly [Item, ...Item[]]>;
}

const ReasonsSchema = asNonEmptyList(z
  .array(GapReasonSchema)
  .min(1)
  .max(AGENT_TOKEN_USAGE_GAP_REASONS.length)
  .meta({ uniqueItems: true })
  .refine(
    (reasons) => reasons.every((reason, index) => index === 0
      || AGENT_TOKEN_USAGE_GAP_REASONS.indexOf(reasons[index - 1]!)
        < AGENT_TOKEN_USAGE_GAP_REASONS.indexOf(reason)),
    { message: 'Usage reasons must be unique and use canonical order.' },
  )
  .readonly());

const UnavailableReasonsSchema = z.union([
  z.tuple([z.literal('unsupported')]).meta({ minItems: 1, maxItems: 1 }).readonly(),
  ReasonsSchema,
]);

export const AgentTokenCountSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), value: TokenValueSchema }).strict().readonly(),
  z
    .object({ kind: z.literal('at_least'), value: TokenValueSchema, reasons: ReasonsSchema })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('unavailable'), reasons: UnavailableReasonsSchema })
    .strict()
    .readonly(),
]);

const CountersSchema = z
  .object({
    inputTokens: AgentTokenCountSchema,
    cacheReadInputTokens: AgentTokenCountSchema,
    cacheCreationInputTokens: AgentTokenCountSchema,
    cacheCreationFiveMinuteInputTokens: AgentTokenCountSchema,
    cacheCreationOneHourInputTokens: AgentTokenCountSchema,
    outputTokens: AgentTokenCountSchema,
    reasoningOutputTokens: AgentTokenCountSchema,
    modelCalls: AgentTokenCountSchema,
    turns: AgentTokenCountSchema,
  })
  .strict()
  .readonly();

const CoverageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('complete') }).strict().readonly(),
  z
    .object({ kind: z.enum(['partial', 'unknown']), reasons: ReasonsSchema })
    .strict()
    .readonly(),
]);

// ------------------------------------------------------------------------------------------------
//                Attribution
// ------------------------------------------------------------------------------------------------

const UsageModelSchema = z
  .object({
    modelProvider: createAgentCanonicalOpaqueStringSchema(
      AGENT_TOKEN_USAGE_LIMITS.modelProviderLength,
      'Model providers must be canonical and contain no control or surrounding whitespace.',
    ).optional(),
    modelId: createAgentCanonicalOpaqueStringSchema(
      AGENT_TOKEN_USAGE_LIMITS.identifierLength,
      'Model IDs must be canonical and contain no control or surrounding whitespace.',
    ),
  })
  .strict()
  .readonly();

const AttributionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), model: UsageModelSchema }).strict().readonly(),
  z.object({ kind: z.literal('unknown') }).strict().readonly(),
  z
    .object({
      kind: z.literal('mixed'),
      rowCoverage: z.enum(['complete', 'partial']),
      rows: z
        .array(z.object({ model: UsageModelSchema, counters: CountersSchema }).strict().readonly())
        .max(AGENT_TOKEN_USAGE_LIMITS.modelRows)
        .readonly(),
    })
    .strict()
    .readonly(),
]);

// ------------------------------------------------------------------------------------------------
//                Measurements, Views, and Scopes
// ------------------------------------------------------------------------------------------------

const ComparisonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict().readonly(),
  z
    .object({ kind: z.literal('stable'), populationId: AgentUsagePopulationIdSchema })
    .strict()
    .readonly(),
]);

const MeasurementSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('delta'),
      coverage: CoverageSchema,
      counters: CountersSchema,
      attribution: AttributionSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('snapshot'),
      epoch: z.number().int().nonnegative().max(AGENT_TOKEN_USAGE_LIMITS.epochsPerScope - 1),
      revision: TokenValueSchema,
      origin: z
        .object({
          kind: z.enum(['fresh_zero', 'historical', 'unknown']),
          cause: z.enum(['initial', 'native_reset', 'native_new_origin']),
        })
        .strict()
        .readonly(),
      comparison: z
        .object({
          inputTokens: ComparisonSchema,
          cacheReadInputTokens: ComparisonSchema,
          cacheCreationInputTokens: ComparisonSchema,
          cacheCreationFiveMinuteInputTokens: ComparisonSchema,
          cacheCreationOneHourInputTokens: ComparisonSchema,
          outputTokens: ComparisonSchema,
          reasoningOutputTokens: ComparisonSchema,
          modelCalls: ComparisonSchema,
          turns: ComparisonSchema,
        })
        .strict()
        .readonly(),
      coverage: CoverageSchema,
      counters: CountersSchema,
      attribution: AttributionSchema,
    })
    .strict()
    .readonly(),
  z.object({ kind: z.literal('unavailable'), reasons: ReasonsSchema }).strict().readonly(),
]);

const CountBasisSchema = z.enum(['provider_reported', 'observed', 'unsupported']);
const InclusionSchema = z.enum(['included', 'excluded', 'unknown']);

export const AgentTokenUsageViewSchema = z
  .object({
    viewId: AgentUsageViewIdSchema,
    authority: z.enum(['authoritative', 'detail']),
    accounting: z.enum(['delta', 'snapshot']),
    countBasis: z
      .object({ modelCalls: CountBasisSchema, turns: CountBasisSchema })
      .strict()
      .readonly(),
    population: z
      .object({ descendants: InclusionSchema, auxiliary: InclusionSchema })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

const ScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      scopeId: AgentUsageScopeIdSchema,
      kind: z.enum(['session', 'materialization']),
      containedIn: AgentUsageScopeIdSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      scopeId: AgentUsageScopeIdSchema,
      kind: z.literal('turn'),
      turnId: AgentTurnIdSchema,
      containedIn: AgentUsageScopeIdSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      scopeId: AgentUsageScopeIdSchema,
      kind: z.literal('model_call'),
      turnId: AgentTurnIdSchema.optional(),
      containedIn: AgentUsageScopeIdSchema.optional(),
    })
    .strict()
    .readonly(),
]);

export const AgentTokenUsageObservationPortableSchema = z
  .object({
    observationId: AgentUsageObservationIdSchema,
    view: AgentTokenUsageViewSchema,
    scope: ScopeSchema,
    measurement: MeasurementSchema,
    finality: z.enum(['open', 'final']),
  })
  .strict()
  .readonly();

// ------------------------------------------------------------------------------------------------
//                Authoritative Observation Rules
// ------------------------------------------------------------------------------------------------

type PortableObservation = z.output<typeof AgentTokenUsageObservationPortableSchema>;
type IssuePath = readonly (string | number)[];

const known = (count: AgentTokenCount): number => (count.kind === 'unavailable' ? 0 : count.value);
const modelOrder = (left: AgentUsageModel, right: AgentUsageModel): number =>
  compareStringsByUnicodeCodePoint(left.modelProvider ?? '', right.modelProvider ?? '')
  || compareStringsByUnicodeCodePoint(left.modelId, right.modelId);

function addCounterIssues(
  input: {
    readonly counters: AgentTokenUsageCounters;
    readonly complete: boolean;
    readonly basis: Readonly<Record<'modelCalls' | 'turns', AgentUsageCountBasis>>;
    readonly path: IssuePath;
  },
  context: z.RefinementCtx,
): void {
  for (const name of AGENT_TOKEN_USAGE_COUNTERS) {
    if (!input.complete && input.counters[name].kind === 'exact') {
      context.addIssue({
        code: 'custom',
        path: [...input.path, name],
        message: 'Exact usage counters require complete coverage.',
      });
    }
  }
  for (const { parent, parts } of AGENT_TOKEN_USAGE_COUNTER_SUBSETS) {
    const total = input.counters[parent];
    const lower = parts.reduce((sum, part) => sum + known(input.counters[part]), 0);
    if (total.kind === 'exact' && lower > total.value) {
      context.addIssue({
        code: 'custom',
        path: [...input.path, parent],
        message: `Known ${parts.join(' and ')} cannot exceed exact ${parent}.`,
      });
    }
  }
  for (const name of ['modelCalls', 'turns'] as const) {
    const count = input.counters[name];
    const unsupported = count.kind === 'unavailable' && count.reasons[0] === 'unsupported';
    if ((input.basis[name] === 'unsupported') !== unsupported) {
      context.addIssue({
        code: 'custom',
        path: [...input.path, name],
        message: `The ${name} counter contradicts its declared count basis.`,
      });
    }
  }
}

function addMeasurementIssues(observation: PortableObservation, context: z.RefinementCtx): void {
  const { measurement, view } = observation;
  if (measurement.kind === 'unavailable') return;
  const complete = measurement.coverage.kind === 'complete';
  addCounterIssues({
    counters: measurement.counters,
    complete,
    basis: view.countBasis,
    path: ['measurement', 'counters'],
  }, context);

  if (measurement.kind === 'snapshot'
    && (measurement.epoch === 0) !== (measurement.origin.cause === 'initial')) {
    context.addIssue({
      code: 'custom',
      path: ['measurement', 'origin', 'cause'],
      message: 'Only counter epoch 0 has the initial cause.',
    });
  }

  const attribution = measurement.attribution;
  if (attribution.kind !== 'mixed') return;
  const rowsPath = ['measurement', 'attribution', 'rows'];
  if (attribution.rowCoverage === 'complete' && attribution.rows.length < 2) {
    context.addIssue({
      code: 'custom',
      path: rowsPath,
      message: 'A complete model partition names at least two models.',
    });
  }
  attribution.rows.forEach((row, index) => {
    if (index > 0 && modelOrder(attribution.rows[index - 1]!.model, row.model) >= 0) {
      context.addIssue({
        code: 'custom',
        path: [...rowsPath, index, 'model'],
        message: 'Model rows must be unique and sorted by model provider and model ID.',
      });
    }
    addCounterIssues({
      counters: row.counters,
      complete,
      basis: { modelCalls: view.countBasis.modelCalls, turns: 'unsupported' },
      path: [...rowsPath, index, 'counters'],
    }, context);
  });
  for (const name of AGENT_TOKEN_USAGE_COUNTERS) {
    const total = measurement.counters[name];
    if (total.kind !== 'exact') continue;
    const lower = attribution.rows.reduce((sum, row) => sum + known(row.counters[name]), 0);
    const partitioned = attribution.rowCoverage === 'complete'
      && attribution.rows.every((row) => row.counters[name].kind === 'exact');
    if (lower > total.value || (partitioned && lower !== total.value)) {
      context.addIssue({
        code: 'custom',
        path: rowsPath,
        message: `Model rows do not reconcile with exact ${name}.`,
      });
    }
  }
}

function addObservationIssues(observation: PortableObservation, context: z.RefinementCtx): void {
  const { measurement, scope, view } = observation;
  if (measurement.kind !== 'unavailable' && measurement.kind !== view.accounting) {
    context.addIssue({
      code: 'custom',
      path: ['measurement', 'kind'],
      message: `A ${view.accounting} view admits only ${view.accounting} or unavailable measurements.`,
    });
  }
  if (scope.containedIn !== undefined && view.authority !== 'detail') {
    context.addIssue({
      code: 'custom',
      path: ['scope', 'containedIn'],
      message: 'Only detail-view scopes may name a container.',
    });
  }
  if (scope.containedIn === scope.scopeId) {
    context.addIssue({
      code: 'custom',
      path: ['scope', 'containedIn'],
      message: 'A usage scope cannot contain itself.',
    });
  }
  addMeasurementIssues(observation, context);
}

function asTokenUsageObservationSchema(
  schema: z.ZodType<PortableObservation>,
): z.ZodType<AgentTokenUsageObservation> {
  // The flat wire shape plus addObservationIssues admits exactly the discriminated plain union;
  // this type-only assertion names that refined result without transforming JSON.
  return schema as unknown as z.ZodType<AgentTokenUsageObservation>;
}

export const AgentTokenUsageObservationSchema = asTokenUsageObservationSchema(
  withAcyclicProtocolInput(AgentTokenUsageObservationPortableSchema, {
    maxDepth: 16,
    maxCollectionLength: AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  }).superRefine(addObservationIssues),
);

// ------------------------------------------------------------------------------------------------
//                Capability
// ------------------------------------------------------------------------------------------------

const AgentTokenUsageViewCapabilitySchema = z
  .object({
    view: AgentTokenUsageViewSchema,
    scopeKind: z.enum(AGENT_TOKEN_USAGE_SCOPE_KINDS),
    reportedCounters: z
      .array(z.enum(AGENT_TOKEN_USAGE_COUNTERS))
      .min(1)
      .max(AGENT_TOKEN_USAGE_COUNTERS.length)
      .meta({ uniqueItems: true })
      .readonly(),
    attribution: z
      .array(z.enum(AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS))
      .min(1)
      .max(AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS.length)
      .meta({ uniqueItems: true })
      .readonly(),
  })
  .strict()
  .readonly();

export const AgentTokenUsageCapabilityPortableSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      views: z
        .tuple([AgentTokenUsageViewCapabilitySchema])
        .rest(AgentTokenUsageViewCapabilitySchema)
        .refine((views) => views.length <= AGENT_TOKEN_USAGE_LIMITS.views, {
          message: `Token usage capabilities declare at most ${AGENT_TOKEN_USAGE_LIMITS.views} views.`,
        })
        .meta({ minItems: 1, maxItems: AGENT_TOKEN_USAGE_LIMITS.views })
        .readonly(),
    })
    .strict()
    .readonly(),
]);

export const AgentTokenUsageCapabilitySchema: z.ZodType<AgentTokenUsageCapability> =
  AgentTokenUsageCapabilityPortableSchema.superRefine((capability, context) => {
    if (capability.kind === 'unsupported') return;
    const viewIds = new Set<string>();
    let authoritative = 0;
    capability.views.forEach((declared, index) => {
      const path = ['views', index];
      if (viewIds.has(declared.view.viewId)) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'view', 'viewId'],
          message: 'Token usage view IDs must be unique.',
        });
      }
      viewIds.add(declared.view.viewId);
      if (declared.view.authority === 'authoritative') authoritative += 1;
      addCanonicalListIssues({
        values: declared.reportedCounters,
        canonicalOrder: AGENT_TOKEN_USAGE_COUNTERS,
        path: [...path, 'reportedCounters'],
        label: 'Reported usage counters',
      }, context);
      addCanonicalListIssues({
        values: declared.attribution,
        canonicalOrder: AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS,
        path: [...path, 'attribution'],
        label: 'Usage attribution kinds',
      }, context);
      for (const name of ['modelCalls', 'turns'] as const) {
        if ((declared.view.countBasis[name] === 'unsupported') === declared.reportedCounters.includes(name)) {
          context.addIssue({
            code: 'custom',
            path: [...path, 'reportedCounters'],
            message: `Reported ${name} must match its declared count basis.`,
          });
        }
      }
    });
    if (authoritative > 1) {
      context.addIssue({
        code: 'custom',
        path: ['views'],
        message: 'Token usage capabilities declare at most one authoritative view.',
      });
    }
  });
