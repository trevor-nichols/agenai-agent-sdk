// ------------------------------------------------------------------------------------------------
//                foundation.ts - Protocol primitive schemas - Dependencies: plain types, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_CODE_MAX_LENGTH,
  AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  AGENT_PROTOCOL_ID_MAX_LENGTH,
  AGENT_PROTOCOL_JSON_BYTES_LIMIT,
  AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
  AGENT_PROTOCOL_JSON_KEY_MAX_LENGTH,
  AGENT_PROTOCOL_PROVIDER_KEY_MAX_LENGTH,
  AGENT_PROTOCOL_PROVIDER_REFERENCE_MAX_LENGTH,
  AGENT_PROTOCOL_TEXT_MAX_LENGTH,
  agentProtocolSerializedJsonBytes,
  type AgentArtifactId,
  type AgentApprovalOptionId,
  type AgentConfigurationRevisionId,
  type AgentError,
  type AgentInstanceId,
  type AgentIsoDateTime,
  type AgentItemId,
  type AgentJsonValue,
  type AgentProviderConversationId,
  type AgentProviderHistoryAnchor,
  type AgentProviderItemRef,
  type AgentProviderKey,
  type AgentProviderRefs,
  type AgentProviderRequestRef,
  type AgentProviderTurnRef,
  type AgentRequestFieldId,
  type AgentRequestId,
  type AgentSessionId,
  type AgentTurnId,
} from '../foundation/types.js';

// ------------------------------------------------------------------------------------------------
//                Canonical Strings and IDs
// ------------------------------------------------------------------------------------------------

const CANONICAL_OPAQUE_STRING_PATTERN =
  /^(?![\s\S]*[\u0000-\u001F\u007F-\u009F])\S(?:[\s\S]*\S)?$/u;
const CANONICAL_NON_BLANK_STRING_PATTERN = /^(?:\S|\S[\s\S]*\S)$/u;

function canonicalOpaqueStringSchema(
  maxLength: number,
  message: string,
): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .regex(CANONICAL_OPAQUE_STRING_PATTERN, message);
}

export const AgentCanonicalIdValueSchema = canonicalOpaqueStringSchema(
  AGENT_PROTOCOL_ID_MAX_LENGTH,
  'Opaque IDs must be canonical and contain no control or surrounding whitespace.',
);

export function createAgentCanonicalNonBlankStringSchema(
  maxLength: number,
): z.ZodString {
  return z.string().min(1).max(maxLength).regex(
    CANONICAL_NON_BLANK_STRING_PATTERN,
    'Canonical text must contain non-whitespace content and no surrounding whitespace.',
  );
}

export const AgentCanonicalNonBlankTextSchema =
  createAgentCanonicalNonBlankStringSchema(AGENT_PROTOCOL_TEXT_MAX_LENGTH);

export const AgentCanonicalCodeSchema =
  createAgentCanonicalNonBlankStringSchema(AGENT_PROTOCOL_CODE_MAX_LENGTH);

const ProviderReferenceSchema = canonicalOpaqueStringSchema(
  AGENT_PROTOCOL_PROVIDER_REFERENCE_MAX_LENGTH,
  'Provider references must be canonical and contain no control or surrounding whitespace.',
);

function opaqueStringSchema<T>(schema: z.ZodString): z.ZodType<T> {
  // Branded IDs are ordinary strings on the wire. This type-only assertion
  // gives successful parses nominal identities without transforming JSON.
  return schema as unknown as z.ZodType<T>;
}

export const AgentInstanceIdSchema =
  opaqueStringSchema<AgentInstanceId>(AgentCanonicalIdValueSchema);
export const AgentSessionIdSchema =
  opaqueStringSchema<AgentSessionId>(AgentCanonicalIdValueSchema);
export const AgentTurnIdSchema =
  opaqueStringSchema<AgentTurnId>(AgentCanonicalIdValueSchema);
export const AgentItemIdSchema =
  opaqueStringSchema<AgentItemId>(AgentCanonicalIdValueSchema);
export const AgentRequestIdSchema =
  opaqueStringSchema<AgentRequestId>(AgentCanonicalIdValueSchema);
export const AgentApprovalOptionIdSchema =
  opaqueStringSchema<AgentApprovalOptionId>(AgentCanonicalIdValueSchema);
export const AgentRequestFieldIdSchema =
  opaqueStringSchema<AgentRequestFieldId>(AgentCanonicalIdValueSchema);
export const AgentArtifactIdSchema =
  opaqueStringSchema<AgentArtifactId>(AgentCanonicalIdValueSchema);
export const AgentConfigurationRevisionIdSchema =
  opaqueStringSchema<AgentConfigurationRevisionId>(AgentCanonicalIdValueSchema);
export const AgentProviderConversationIdSchema =
  opaqueStringSchema<AgentProviderConversationId>(ProviderReferenceSchema);
export const AgentProviderHistoryAnchorSchema =
  opaqueStringSchema<AgentProviderHistoryAnchor>(ProviderReferenceSchema);
export const AgentProviderTurnRefSchema =
  opaqueStringSchema<AgentProviderTurnRef>(ProviderReferenceSchema);
export const AgentProviderItemRefSchema =
  opaqueStringSchema<AgentProviderItemRef>(ProviderReferenceSchema);
export const AgentProviderRequestRefSchema =
  opaqueStringSchema<AgentProviderRequestRef>(ProviderReferenceSchema);

export const AgentProviderKeySchema = opaqueStringSchema<AgentProviderKey>(
  z
    .string()
    .min(1)
    .max(AGENT_PROTOCOL_PROVIDER_KEY_MAX_LENGTH)
    .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u),
);

export const AgentIsoDateTimeSchema = opaqueStringSchema<AgentIsoDateTime>(
  z.string().datetime({ offset: true }),
);

const AGENT_JSON_OBJECT_KEY_PATTERN =
  /^(?!(?:__proto__|constructor|prototype)$)/u;

export const AgentJsonObjectKeySchema = z
  .string()
  .min(1)
  .max(AGENT_PROTOCOL_JSON_KEY_MAX_LENGTH)
  .regex(
    AGENT_JSON_OBJECT_KEY_PATTERN,
    'JSON object keys must not use prototype-sensitive names.',
  );

// ------------------------------------------------------------------------------------------------
//                Bounded JSON Values
// ------------------------------------------------------------------------------------------------

interface ProtocolInputPreflightOptions {
  readonly maxDepth?: number;
  readonly maxCollectionLength?: number;
}

function passesProtocolInputPreflight(
  input: unknown,
  options: ProtocolInputPreflightOptions,
): boolean {
  const activeObjects = new WeakSet<object>();
  const pending: Array<
    | { readonly operation: 'enter'; readonly value: unknown; readonly depth: number }
    | { readonly operation: 'leave'; readonly value: object }
  > = [{ operation: 'enter', value: input, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.operation === 'leave') {
      activeObjects.delete(current.value);
      continue;
    }
    if (options.maxDepth !== undefined && current.depth > options.maxDepth) {
      return false;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (activeObjects.has(current.value)) return false;

    activeObjects.add(current.value);
    pending.push({ operation: 'leave', value: current.value });

    if (Array.isArray(current.value) && options.maxCollectionLength !== undefined) {
      let lengthDescriptor: PropertyDescriptor | undefined;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(current.value, 'length');
      } catch {
        return false;
      }
      if (
        !lengthDescriptor
        || !('value' in lengthDescriptor)
        || typeof lengthDescriptor.value !== 'number'
        || lengthDescriptor.value > options.maxCollectionLength
      ) {
        return false;
      }
    }

    let propertyKeys: readonly PropertyKey[];
    try {
      propertyKeys = Reflect.ownKeys(current.value);
    } catch {
      return false;
    }

    let collectionLength = 0;
    for (const propertyKey of propertyKeys) {
      if (
        typeof propertyKey === 'string'
        && !AGENT_JSON_OBJECT_KEY_PATTERN.test(propertyKey)
      ) {
        return false;
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(current.value, propertyKey);
      } catch {
        return false;
      }
      if (!descriptor?.enumerable) continue;
      if (!('value' in descriptor)) return false;
      collectionLength += 1;
      if (
        options.maxCollectionLength !== undefined
        && collectionLength > options.maxCollectionLength
      ) {
        return false;
      }
      pending.push({
        operation: 'enter',
        value: descriptor.value,
        depth: current.depth + 1,
      });
    }
  }

  return true;
}

export function withAcyclicProtocolInput<Output>(
  schema: z.ZodType<Output>,
  options: ProtocolInputPreflightOptions = {},
): z.ZodType<Output> {
  return z.custom<unknown>(
    (input) => passesProtocolInputPreflight(input, options),
    {
      message:
        'Protocol inputs must be bounded, acyclic, and free of accessor-backed values.',
    },
  ).pipe(schema);
}

export const AgentJsonValuePortableSchema: z.ZodType<AgentJsonValue> = z.lazy(
  () =>
    z.union([
      z.string().max(AGENT_PROTOCOL_JSON_BYTES_LIMIT),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(AgentJsonValuePortableSchema)
        .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
        .readonly(),
      z.record(
        AgentJsonObjectKeySchema,
        AgentJsonValuePortableSchema,
      ).readonly(),
    ]),
);

function addJsonByteBoundsIssue(
  value: AgentJsonValue,
  context: z.RefinementCtx,
): void {
  if (agentProtocolSerializedJsonBytes(value) > AGENT_PROTOCOL_JSON_BYTES_LIMIT) {
    context.addIssue({
      code: 'custom',
      message: `JSON values cannot exceed ${AGENT_PROTOCOL_JSON_BYTES_LIMIT} serialized bytes.`,
    });
  }
}

export const AgentJsonValueSchema: z.ZodType<AgentJsonValue> =
  withAcyclicProtocolInput(AgentJsonValuePortableSchema, {
    maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
    maxCollectionLength: AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  }).superRefine(addJsonByteBoundsIssue);

// ------------------------------------------------------------------------------------------------
//                Correlation and Error Schemas
// ------------------------------------------------------------------------------------------------

export const AgentProviderRefsPortableSchema = z
  .object({
    conversationId: AgentProviderConversationIdSchema.optional(),
    historyAnchor: AgentProviderHistoryAnchorSchema.optional(),
    turnId: AgentProviderTurnRefSchema.optional(),
    itemId: AgentProviderItemRefSchema.optional(),
    requestId: AgentProviderRequestRefSchema.optional(),
  })
  .strict()
  .readonly();

export const AgentProviderRefsSchema: z.ZodType<AgentProviderRefs> =
  AgentProviderRefsPortableSchema.refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    { message: 'At least one provider reference is required.' },
  );

export const AgentErrorContextSchema = z
  .object({
    operation: createAgentCanonicalNonBlankStringSchema(160).optional(),
    component: createAgentCanonicalNonBlankStringSchema(160).optional(),
    status: createAgentCanonicalNonBlankStringSchema(160).optional(),
  })
  .strict()
  .readonly();

export const AgentErrorSchema: z.ZodType<AgentError> = z
  .object({
    code: AgentCanonicalCodeSchema,
    message: AgentCanonicalNonBlankTextSchema,
    retryable: z.boolean(),
    context: AgentErrorContextSchema.optional(),
  })
  .strict()
  .readonly();
