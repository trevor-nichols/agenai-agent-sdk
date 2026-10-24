import type { AgentJsonObject, AgentJsonValue, ValidationPathSegment } from '../foundation/types.js';
import {
  AGENT_OUTPUT_SCHEMA_BYTES_LIMIT,
  AGENT_OUTPUT_SCHEMA_DEPTH_LIMIT,
  AGENT_OUTPUT_SCHEMA_DESCRIPTION_MAX_LENGTH,
  AGENT_OUTPUT_SCHEMA_DIALECT,
  AGENT_OUTPUT_SCHEMA_ENUM_VALUES_LIMIT,
  AGENT_OUTPUT_SCHEMA_LENGTH_BOUND_LIMIT,
  AGENT_OUTPUT_SCHEMA_NODES_LIMIT,
  AGENT_OUTPUT_VALUE_BYTES_LIMIT,
  AGENT_OUTPUT_VALUE_COLLECTION_LIMIT,
  AGENT_OUTPUT_VALUE_DEPTH_LIMIT,
  AGENT_OUTPUT_VALUE_NODES_LIMIT,
} from './constants.js';
import { codePointLength, isJsonObject, serializedStringBytes } from './boundedJson.js';
import type {
  AgentOutputNonNullSchema,
  AgentOutputNumberSchema,
  AgentOutputNullSchema,
  AgentOutputSchema,
  AgentOutputSchemaNode,
} from './types.js';

export class StructuredOutputSchemaError extends Error {
  constructor(readonly message: string, readonly path: readonly ValidationPathSegment[]) {
    super(message);
  }
}

function invalid(message: string, path: readonly ValidationPathSegment[]): never {
  throw new StructuredOutputSchemaError(message, path);
}

function object(value: AgentJsonValue | undefined, path: readonly ValidationPathSegment[]): AgentJsonObject {
  if (value === undefined || !isJsonObject(value)) invalid('A schema node must be a plain object.', path);
  return value;
}

function keys(value: AgentJsonObject, allowed: readonly string[], path: readonly ValidationPathSegment[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('Schema contains an unsupported keyword.', path);
}

function description(value: AgentJsonObject, path: readonly ValidationPathSegment[]): Readonly<{ description?: string }> {
  if (!Object.hasOwn(value, 'description')) return {};
  if (typeof value.description !== 'string' || codePointLength(value.description) > AGENT_OUTPUT_SCHEMA_DESCRIPTION_MAX_LENGTH) {
    invalid('Schema descriptions must be strings within the code-point limit.', [...path, 'description']);
  }
  return { description: value.description };
}

function bound(value: AgentJsonObject, key: string, path: readonly ValidationPathSegment[], integer: boolean): number | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)
    || (integer && (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > AGENT_OUTPUT_SCHEMA_LENGTH_BOUND_LIMIT))) {
    invalid(integer ? 'Length bounds must be nonnegative safe integers within the profile ceiling.' : 'Numeric bounds must be finite numbers.', [...path, key]);
  }
  return candidate;
}

function ordered(minimum: number | undefined, maximum: number | undefined, path: readonly ValidationPathSegment[]): void {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) invalid('Schema minimum must not exceed maximum.', path);
}

function isNullSchema(value: AgentOutputSchemaNode): value is AgentOutputNullSchema {
  return 'type' in value && value.type === 'null';
}

function isNonNullSchema(value: AgentOutputSchemaNode): value is AgentOutputNonNullSchema {
  return 'type' in value && value.type !== 'null';
}

export function admitOutputSchema(input: AgentJsonValue, maxOutputBytes = AGENT_OUTPUT_VALUE_BYTES_LIMIT): AgentOutputSchema {
  let nodes = 0;

  function node(value: AgentJsonValue, depth: number, path: readonly ValidationPathSegment[], root = false): AgentOutputSchemaNode {
    nodes += 1;
    if (nodes > AGENT_OUTPUT_SCHEMA_NODES_LIMIT || depth > AGENT_OUTPUT_SCHEMA_DEPTH_LIMIT) {
      invalid('Schema exceeds the node or depth limit.', path);
    }
    const source = object(value, path);
    const annotation = description(source, path);
    if (Object.hasOwn(source, 'anyOf')) {
      keys(source, ['anyOf', 'description'], path);
      if (root) invalid('The output schema root must be an object.', path);
      const branches = source.anyOf;
      if (!Array.isArray(branches) || branches.length !== 2) invalid('Nullable schemas require exactly one non-null and one null branch.', [...path, 'anyOf']);
      const firstValue: AgentJsonValue | undefined = branches[0];
      const secondValue: AgentJsonValue | undefined = branches[1];
      if (firstValue === undefined || secondValue === undefined) invalid('Nullable branches must be present.', [...path, 'anyOf']);
      const first = node(firstValue, depth + 1, [...path, 'anyOf', 0]);
      const second = node(secondValue, depth + 1, [...path, 'anyOf', 1]);
      if (isNonNullSchema(first) && isNullSchema(second)) return Object.freeze({ anyOf: Object.freeze([first, second] as const), ...annotation });
      if (isNullSchema(first) && isNonNullSchema(second)) return Object.freeze({ anyOf: Object.freeze([second, first] as const), ...annotation });
      invalid('Nullable schemas require one non-null branch and prohibit nested nullable wrappers.', [...path, 'anyOf']);
    }
    if (root && source.type !== 'object') invalid('The output schema root must be an object.', path);
    const dialect = root ? ['$schema'] : [];
    if (root && Object.hasOwn(source, '$schema') && source.$schema !== AGENT_OUTPUT_SCHEMA_DIALECT) invalid('Only JSON Schema draft 2020-12 is supported.', [...path, '$schema']);

    switch (source.type) {
      case 'object': {
        keys(source, ['type', 'properties', 'required', 'additionalProperties', 'description', ...dialect], path);
        const properties = object(source.properties, [...path, 'properties']);
        const required = source.required;
        if (source.additionalProperties !== false || !Array.isArray(required)) invalid('Object schemas must be closed and explicitly require every property.', path);
        const names = Object.keys(properties);
        const requiredNames = new Set<string>();
        for (const candidate of required) {
          if (typeof candidate !== 'string' || requiredNames.has(candidate) || !Object.hasOwn(properties, candidate)) {
            invalid('Required keys must name every property exactly once.', [...path, 'required']);
          }
          requiredNames.add(candidate);
        }
        if (requiredNames.size !== names.length) invalid('Required keys must name every property exactly once.', [...path, 'required']);
        const parsed: Record<string, AgentOutputSchemaNode> = {};
        for (const name of names) {
          const child = properties[name];
          if (child === undefined) invalid('Object properties require schema nodes.', [...path, 'properties', name]);
          parsed[name] = node(child, depth + 1, [...path, 'properties', name]);
        }
        return Object.freeze({ type: 'object', properties: Object.freeze(parsed), required: Object.freeze(names), additionalProperties: false, ...annotation });
      }
      case 'array': {
        keys(source, ['type', 'items', 'minItems', 'maxItems', 'description'], path);
        const minItems = bound(source, 'minItems', path, true);
        const maxItems = bound(source, 'maxItems', path, true);
        ordered(minItems, maxItems, path);
        if (minItems !== undefined && minItems > AGENT_OUTPUT_VALUE_COLLECTION_LIMIT) invalid('Array minimum cannot exceed the value collection limit.', [...path, 'minItems']);
        const item = source.items;
        if (item === undefined) invalid('Array schemas require one homogeneous item schema.', [...path, 'items']);
        return Object.freeze({ type: 'array', items: node(item, depth + 1, [...path, 'items']),
          ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }), ...annotation });
      }
      case 'string': {
        keys(source, ['type', 'enum', 'minLength', 'maxLength', 'description'], path);
        const minLength = bound(source, 'minLength', path, true);
        const maxLength = bound(source, 'maxLength', path, true);
        ordered(minLength, maxLength, path);
        let values: readonly [string, ...string[]] | undefined;
        if (Object.hasOwn(source, 'enum')) {
          const candidates = source.enum;
          if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > AGENT_OUTPUT_SCHEMA_ENUM_VALUES_LIMIT) invalid('String enums must be nonempty and bounded.', [...path, 'enum']);
          const strings: string[] = [];
          const unique = new Set<string>();
          for (const candidate of candidates) {
            if (typeof candidate !== 'string' || unique.has(candidate)) invalid('String enums require unique strings.', [...path, 'enum']);
            const length = codePointLength(candidate);
            if ((minLength !== undefined && length < minLength) || (maxLength !== undefined && length > maxLength)) invalid('Every enum value must satisfy the string length bounds.', [...path, 'enum']);
            unique.add(candidate);
            strings.push(candidate);
          }
          const [first, ...rest] = strings;
          if (first === undefined) invalid('String enums cannot be empty.', [...path, 'enum']);
          values = Object.freeze([first, ...rest] as const);
        }
        return Object.freeze({ type: 'string', ...(values === undefined ? {} : { enum: values }),
          ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }), ...annotation });
      }
      case 'number':
      case 'integer': {
        keys(source, ['type', 'minimum', 'maximum', 'description'], path);
        const minimum = bound(source, 'minimum', path, false);
        const maximum = bound(source, 'maximum', path, false);
        ordered(minimum, maximum, path);
        if (source.type === 'integer' && minimum !== undefined && maximum !== undefined && Math.ceil(minimum) > Math.floor(maximum)) invalid('Integer bounds admit no integer value.', path);
        return Object.freeze({ type: source.type, ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }), ...annotation });
      }
      case 'boolean':
      case 'null':
        keys(source, ['type', 'description'], path);
        return Object.freeze({ type: source.type, ...annotation });
      default:
        invalid('Schema node type is unsupported.', [...path, 'type']);
    }
  }

  const schema = node(input, 1, [], true);
  if (!('type' in schema) || schema.type !== 'object') invalid('The output schema root must be an object.', []);
  const minimum = minimumValueSize(schema);
  if (minimum.bytes > AGENT_OUTPUT_VALUE_BYTES_LIMIT || minimum.nodes > AGENT_OUTPUT_VALUE_NODES_LIMIT || minimum.depth > AGENT_OUTPUT_VALUE_DEPTH_LIMIT) {
    invalid('Schema cannot produce a value within the profile capacity limits.', []);
  }
  if (minimum.bytes > maxOutputBytes) {
    invalid('Schema cannot produce a value within the configured output byte limit.', []);
  }
  return schema;
}

interface MinimumValueSize {
  readonly bytes: number;
  readonly nodes: number;
  readonly depth: number;
}

function decimalExponent(value: number): number {
  const notation = value.toExponential();
  return Number(notation.slice(notation.indexOf('e') + 1));
}

function minimumNumberBytes(schema: AgentOutputNumberSchema): number {
  const lower = schema.minimum ?? -Number.MAX_VALUE;
  const upper = schema.maximum ?? Number.MAX_VALUE;
  const minimum = schema.type === 'integer' ? Math.ceil(lower) : lower;
  const maximum = schema.type === 'integer' ? Math.floor(upper) : upper;
  if (minimum === maximum) return JSON.stringify(minimum).length;
  if (minimum <= 0 && maximum >= 0) return 1;

  const negative = maximum < 0;
  const absoluteMinimum = negative ? -maximum : minimum;
  const absoluteMaximum = negative ? -minimum : maximum;
  let bytes = Infinity;
  const maximumExponent = decimalExponent(absoluteMaximum);
  // JSON uses fixed notation at exponents -6 through 20. Each magnitude band
  // supplies a lower bound; fractional mantissas may require additional bytes.
  for (let exponent = decimalExponent(absoluteMinimum); exponent <= maximumExponent; exponent += 1) {
    let bandBytes: number;
    if (exponent < -6 || exponent >= 21) {
      bandBytes = 3 + String(Math.abs(exponent)).length;
    } else if (exponent < 0) {
      bandBytes = 2 - exponent;
    } else {
      const firstInteger = Math.ceil(Math.max(absoluteMinimum, Number(`1e${exponent}`)));
      const containsInteger = firstInteger <= absoluteMaximum && firstInteger < Number(`1e${exponent + 1}`);
      bandBytes = exponent + 1 + (containsInteger ? 0 : 2);
    }
    bytes = Math.min(bytes, bandBytes);
  }
  return bytes + (negative ? 1 : 0);
}

function minimumValueSize(schema: AgentOutputSchemaNode): MinimumValueSize {
  if ('anyOf' in schema) {
    const nonNull = minimumValueSize(schema.anyOf[0]);
    return { bytes: Math.min(4, nonNull.bytes), nodes: 1, depth: 1 };
  }
  switch (schema.type) {
    case 'object': {
      const entries = Object.entries(schema.properties);
      let bytes = 2 + Math.max(0, entries.length - 1);
      let nodes = 1;
      let depth = 1;
      for (const [name, child] of entries) {
        const minimum = minimumValueSize(child);
        bytes += serializedStringBytes(name, AGENT_OUTPUT_SCHEMA_BYTES_LIMIT) + 1 + minimum.bytes;
        nodes += minimum.nodes;
        depth = Math.max(depth, 1 + minimum.depth);
      }
      return { bytes, nodes, depth };
    }
    case 'array': {
      const count = schema.minItems ?? 0;
      const child = minimumValueSize(schema.items);
      return { bytes: 2 + Math.max(0, count - 1) + count * child.bytes, nodes: 1 + count * child.nodes, depth: count === 0 ? 1 : 1 + child.depth };
    }
    case 'string':
      return { bytes: schema.enum ? Math.min(...schema.enum.map((value) => serializedStringBytes(value, AGENT_OUTPUT_SCHEMA_BYTES_LIMIT))) : 2 + (schema.minLength ?? 0), nodes: 1, depth: 1 };
    case 'boolean':
    case 'null':
      return { bytes: 4, nodes: 1, depth: 1 };
    case 'integer':
    case 'number':
      return { bytes: minimumNumberBytes(schema), nodes: 1, depth: 1 };
  }
}
