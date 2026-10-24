// ------------------------------------------------------------------------------------------------
//                outputSchema.ts - Bounded finite Zod core inspection and portable schema emission
// ------------------------------------------------------------------------------------------------

import * as core from 'zod/v4/core';

import { AgentProtocolValidationError, type ValidationPathSegment } from '../foundation/types.js';
import { isOutputPropertyName, serializedStringBytes } from '../structuredOutput/boundedJson.js';
import {
  AGENT_OUTPUT_SCHEMA_BYTES_LIMIT,
  AGENT_OUTPUT_SCHEMA_DEPTH_LIMIT,
  AGENT_OUTPUT_SCHEMA_ENUM_VALUES_LIMIT,
  AGENT_OUTPUT_SCHEMA_NODES_LIMIT,
  AGENT_OUTPUT_SCHEMA_PROPERTIES_LIMIT,
} from '../structuredOutput/constants.js';
import { StructuredOutputIssues } from '../structuredOutput/issues.js';
import type {
  AgentOutputNumberSchema,
  AgentOutputSchema,
  AgentOutputSchemaNode,
  AgentOutputStringSchema,
} from '../structuredOutput/types.js';

const sourceChecksLimit = 256;
type SchemaPath = readonly ValidationPathSegment[];

function unsupported(message: string, path: SchemaPath): never {
  const issues = new StructuredOutputIssues();
  issues.add('unsupported_output_schema', message, path);
  throw new AgentProtocolValidationError(issues.issues);
}

function finiteNumber(value: unknown, path: SchemaPath): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return unsupported('Output schema bounds must be finite numbers.', path);
  }
  return value;
}

function emitNumber(schema: core.$ZodNumber, entries: readonly core.$ZodCheck[], path: SchemaPath): AgentOutputNumberSchema {
  let integer = false;
  let minimum: number | undefined;
  let maximum: number | undefined;

  function numberFormat(format: string): void {
    if (format !== 'safeint') unsupported('Only the safe-integer Zod numeric format is supported.', path);
    integer = true;
    minimum = Math.max(minimum ?? Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
    maximum = Math.min(maximum ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  }

  if (schema._zod.def.coerce) unsupported('Zod coercion is unsupported; supply a value-preserving neutral output definition.', path);
  if (schema instanceof core.$ZodNumberFormat) {
    if (schema._zod.def.when !== undefined) unsupported('Conditional numeric checks cannot be represented by the portable output schema.', path);
    numberFormat(schema._zod.def.format);
  }
  for (const check of entries) {
    if (check._zod.def.when !== undefined) unsupported('Conditional numeric checks cannot be represented by the portable output schema.', path);
    if (check instanceof core.$ZodCheckGreaterThan && check._zod.def.inclusive === true) {
      minimum = Math.max(minimum ?? -Infinity, finiteNumber(check._zod.def.value, path));
    } else if (check instanceof core.$ZodCheckLessThan && check._zod.def.inclusive === true) {
      maximum = Math.min(maximum ?? Infinity, finiteNumber(check._zod.def.value, path));
    } else if (check instanceof core.$ZodCheckNumberFormat) numberFormat(check._zod.def.format);
    else unsupported('Only inclusive numeric bounds and safe-integer checks are supported.', path);
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    unsupported('Output schema numeric bounds are contradictory.', path);
  }
  return {
    type: integer ? 'integer' : 'number',
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

export function emitZodOutputSchema(root: core.$ZodType): AgentOutputSchema {
  const active = new Set<core.$ZodType>();
  let nodes = 0;
  let checks = 0;
  let stringBytes = 0;

  function chargeNode(depth: number, path: SchemaPath): void {
    nodes += 1;
    if (nodes > AGENT_OUTPUT_SCHEMA_NODES_LIMIT) unsupported('Expanded output schema exceeds the schema node limit.', path);
    if (depth > AGENT_OUTPUT_SCHEMA_DEPTH_LIMIT) unsupported('Output schema exceeds the schema depth limit.', path);
  }

  function chargeString(value: string, path: SchemaPath): void {
    if (value.length > AGENT_OUTPUT_SCHEMA_BYTES_LIMIT) unsupported('Output schema exceeds the serialized UTF-8 byte limit.', path);
    stringBytes += serializedStringBytes(value, AGENT_OUTPUT_SCHEMA_BYTES_LIMIT - stringBytes);
    if (stringBytes > AGENT_OUTPUT_SCHEMA_BYTES_LIMIT) unsupported('Output schema exceeds the serialized UTF-8 byte limit.', path);
  }

  function emitEnum(schema: core.$ZodEnum | core.$ZodLiteral, path: SchemaPath): AgentOutputStringSchema {
    const values: string[] = [];
    function append(value: unknown): void {
      if (values.length === AGENT_OUTPUT_SCHEMA_ENUM_VALUES_LIMIT) unsupported('Output enum exceeds the entry limit.', path);
      if (typeof value !== 'string') unsupported('Only string enum and string literal values are supported.', path);
      chargeString(value, path);
      values.push(value);
    }
    if (schema instanceof core.$ZodEnum) {
      const entries = schema._zod.def.entries;
      for (const key in entries) {
        if (!Object.hasOwn(entries, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(entries, key);
        if (!descriptor || !('value' in descriptor)) unsupported('Zod enum values must be data properties.', path);
        append(descriptor.value);
      }
    } else {
      const entries = schema._zod.def.values;
      if (entries.length > AGENT_OUTPUT_SCHEMA_ENUM_VALUES_LIMIT) unsupported('Output enum exceeds the entry limit.', path);
      for (const entry of entries) append(entry);
    }
    const [first, ...rest] = values;
    if (first === undefined) unsupported('Output string enums must contain at least one value.', path);
    return { type: 'string', enum: [first, ...rest] };
  }

  function visit(schema: core.$ZodType, depth: number, path: SchemaPath): AgentOutputSchemaNode {
    chargeNode(depth, path);
    if (!(schema instanceof core.$ZodType)) unsupported('Output schema children must be Zod core schemas.', path);
    if (active.has(schema)) unsupported('Recursive Zod schemas are unsupported.', path);
    active.add(schema);
    try {
      const entries = schema._zod.def.checks ?? [];
      checks += entries.length;
      if (checks > sourceChecksLimit) unsupported('Expanded output schema exceeds the source check limit.', path);
      for (const entry of entries) {
        if (!(entry instanceof core.$ZodCheck)) unsupported('Unrecognized Zod checks are unsupported.', path);
      }
      if (schema instanceof core.$ZodString) {
        if (schema._zod.def.coerce) unsupported('Zod coercion is unsupported; supply a value-preserving neutral output definition.', path);
        if (schema instanceof core.$ZodStringFormat) unsupported('Zod string formats are unsupported by the portable output schema.', path);
        if (entries.some((check) => check instanceof core.$ZodCheckMinLength || check instanceof core.$ZodCheckMaxLength || check instanceof core.$ZodCheckLengthEquals)) {
          unsupported('Zod string lengths count UTF-16 units. Use createAgentOutputDefinition with JSON Schema minLength/maxLength for code-point bounds, or an explicit local validation-only decoder.', path);
        }
        if (entries.length > 0) unsupported('Zod string checks, refinements and overwrites are unsupported.', path);
        return { type: 'string' };
      }
      if (schema instanceof core.$ZodNumber) return emitNumber(schema, entries, path);
      if (schema instanceof core.$ZodBoolean) {
        if (schema._zod.def.coerce) unsupported('Zod coercion is unsupported; supply a value-preserving neutral output definition.', path);
        if (entries.length > 0) unsupported('Zod boolean checks are unsupported.', path);
        return { type: 'boolean' };
      }
      if (schema instanceof core.$ZodNull) {
        if (entries.length > 0) unsupported('Zod null checks are unsupported.', path);
        return { type: 'null' };
      }
      if (schema instanceof core.$ZodEnum || schema instanceof core.$ZodLiteral) {
        if (entries.length > 0) unsupported('Zod enum and literal checks are unsupported.', path);
        return emitEnum(schema, path);
      }
      if (schema instanceof core.$ZodArray) {
        if (entries.length > 0) {
          unsupported('Zod array checks have opaque conditions. Use createAgentOutputDefinition with JSON Schema minItems/maxItems, or an explicit local validation-only decoder.', path);
        }
        return { type: 'array', items: visit(schema._zod.def.element, depth + 1, [...path, 'items']) };
      }
      if (schema instanceof core.$ZodNullable) {
        if (entries.length > 0) unsupported('Zod nullable checks are unsupported.', path);
        const inner = visit(schema._zod.def.innerType, depth + 1, [...path, 'anyOf', 0]);
        if ('anyOf' in inner || inner.type === 'null') unsupported('Nullable output requires one non-null, non-nullable inner schema.', path);
        chargeNode(depth + 1, [...path, 'anyOf', 1]);
        return { anyOf: [inner, { type: 'null' }] };
      }
      if (schema instanceof core.$ZodObject) {
        if (entries.length > 0) unsupported('Zod object checks and refinements are unsupported.', path);
        if (!(schema._zod.def.catchall instanceof core.$ZodNever)) unsupported('Output objects must be strict. Use z.strictObject or .strict().', path);
        const shape = schema._zod.def.shape;
        const properties: Record<string, AgentOutputSchemaNode> = {};
        const required: string[] = [];
        for (const key in shape) {
          if (!Object.hasOwn(shape, key)) continue;
          const childPath = [...path, 'properties', key];
          if (required.length === AGENT_OUTPUT_SCHEMA_PROPERTIES_LIMIT) unsupported('Output object exceeds the property limit.', path);
          if (!isOutputPropertyName(key)) unsupported('Output object property names must be bounded, nonempty and safe.', path);
          chargeString(key, childPath);
          const descriptor = Object.getOwnPropertyDescriptor(shape, key);
          if (!descriptor || !('value' in descriptor)) unsupported('Resolved Zod object shapes must contain data properties.', childPath);
          const child: unknown = descriptor.value;
          if (!(child instanceof core.$ZodType)) unsupported('Output schema children must be Zod core schemas.', childPath);
          properties[key] = visit(child, depth + 1, childPath);
          required.push(key);
        }
        return { type: 'object', properties, required, additionalProperties: false };
      }
      return unsupported('This Zod schema type is unsupported. Use a finite strict output object without optional fields, wrappers, transforms or lazy schemas.', path);
    } finally {
      active.delete(schema);
    }
  }

  const result = visit(root, 1, []);
  if (!('type' in result) || result.type !== 'object') unsupported('Output schema root must be a strict Zod object.', []);
  return result;
}
