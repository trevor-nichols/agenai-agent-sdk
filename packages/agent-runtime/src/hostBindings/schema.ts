// ------------------------------------------------------------------------------------------------
//                schema.ts - Bounded JSON Schema validation and argument matching
// ------------------------------------------------------------------------------------------------

import { agentProtocolSerializedJsonBytes, type AgentJsonValue } from "@agen-ai/agent-protocol";
import type { AgentHostToolInputSchema, AgentHostToolSchema } from "./types.js";

export const AGENT_HOST_TOOL_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

export function dataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Host binding data must be a plain object.");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 100) throw new TypeError("Host binding objects cannot exceed 100 properties.");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)
      || !descriptor.enumerable || ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new TypeError("Host binding data must contain only ordinary data properties.");
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function dataArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError("Host binding arrays must be bounded and dense.");
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Host binding arrays must contain ordinary data values.");
    }
    result.push(descriptor.value);
  }
  return result;
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Host binding data has unexpected or missing fields.");
  }
}

function integerBound(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError("Tool schema limits must be bounded nonnegative integers.");
  }
  return value;
}

export function parseAgentHostToolInputSchema(input: unknown): AgentHostToolInputSchema {
  let nodes = 0;
  const active = new WeakSet<object>();
  const visit = (value: unknown, depth: number): AgentHostToolSchema => {
    if (++nodes > 256 || depth > 8 || !value || typeof value !== "object" || active.has(value)) {
      throw new TypeError("Tool schemas must be bounded and acyclic.");
    }
    active.add(value);
    try {
      const source = dataRecord(value);
      if (depth === 0 && (source.$schema !== AGENT_HOST_TOOL_SCHEMA_DIALECT || source.type !== "object")) {
        throw new TypeError("Tool inputs require an object schema using JSON Schema 2020-12.");
      }
      const keys = ["type", "description", ...(depth === 0 ? ["$schema"] : [])];
      const result: Record<string, unknown> = { type: source.type };
      if (depth === 0) result.$schema = AGENT_HOST_TOOL_SCHEMA_DIALECT;
      if (source.description !== undefined) {
        if (typeof source.description !== "string" || source.description.length > 2_000) {
          throw new TypeError("Tool schema descriptions must be bounded strings.");
        }
        result.description = source.description;
      }
      switch (source.type) {
        case "object": {
          exactKeys(source, [...keys, "properties", "required", "additionalProperties"], ["properties", "additionalProperties"]);
          if (source.additionalProperties !== false) throw new TypeError("Tool objects must reject additional properties.");
          const properties = dataRecord(source.properties);
          if (Object.keys(properties).length > 100) throw new TypeError("Tool objects have too many properties.");
          const parsedProperties: Record<string, AgentHostToolSchema> = Object.create(null);
          for (const [key, property] of Object.entries(properties)) {
            if (key.length < 1 || key.length > 128) throw new TypeError("Tool property names must be bounded.");
            parsedProperties[key] = visit(property, depth + 1);
          }
          result.properties = Object.freeze(parsedProperties);
          result.additionalProperties = false;
          if (source.required !== undefined) {
            const required = dataArray(source.required, 100);
            if (new Set(required).size !== required.length || required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key))) {
              throw new TypeError("Required tool properties must be unique declared keys.");
            }
            result.required = Object.freeze([...required]);
          }
          break;
        }
        case "array": {
          exactKeys(source, [...keys, "items", "minItems", "maxItems"], ["items", "maxItems"]);
          const maximum = integerBound(source.maxItems, 100);
          result.maxItems = maximum;
          if (source.minItems !== undefined) result.minItems = integerBound(source.minItems, maximum);
          result.items = visit(source.items, depth + 1);
          break;
        }
        case "string": {
          exactKeys(source, [...keys, "enum", "minLength", "maxLength"], ["maxLength"]);
          const maximum = integerBound(source.maxLength, 16_000);
          const minimum = source.minLength === undefined ? 0 : integerBound(source.minLength, maximum);
          result.maxLength = maximum;
          if (source.minLength !== undefined) result.minLength = minimum;
          if (source.enum !== undefined) {
            const values = dataArray(source.enum, 100);
            if (values.length === 0 || new Set(values).size !== values.length || values.some((entry) =>
              typeof entry !== "string" || [...entry].length < minimum || [...entry].length > maximum)) {
              throw new TypeError("Tool string enums must contain unique strings within their limits.");
            }
            result.enum = Object.freeze([...values]);
          }
          break;
        }
        case "integer":
        case "number": {
          exactKeys(source, [...keys, "minimum", "maximum"]);
          for (const key of ["minimum", "maximum"] as const) {
            const bound = source[key];
            if (bound === undefined) continue;
            if (typeof bound !== "number" || !Number.isFinite(bound)
              || (source.type === "integer" && !Number.isSafeInteger(bound))) {
              throw new TypeError("Tool numeric limits must be finite and type-correct.");
            }
            result[key] = bound;
          }
          if (typeof source.minimum === "number" && typeof source.maximum === "number" && source.minimum > source.maximum) {
            throw new TypeError("Tool numeric limits must be ordered.");
          }
          break;
        }
        case "boolean":
        case "null":
          exactKeys(source, keys);
          break;
        default:
          throw new TypeError("Tool schema type is unsupported.");
      }
      return Object.freeze(result) as unknown as AgentHostToolSchema;
    } finally {
      active.delete(value);
    }
  };
  const schema = visit(input, 0) as AgentHostToolInputSchema;
  if (agentProtocolSerializedJsonBytes(schema) > 8_192) {
    throw new TypeError("Tool schemas cannot exceed 8 KiB.");
  }
  return schema;
}

export function matchesAgentHostToolSchema(schema: AgentHostToolSchema, value: AgentJsonValue): boolean {
  switch (schema.type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value)
        && (schema.required ?? []).every((key) => Object.hasOwn(value, key))
        && Object.entries(value).every(([key, entry]) => Object.hasOwn(schema.properties, key)
          && matchesAgentHostToolSchema(schema.properties[key], entry));
    case "array":
      return Array.isArray(value) && value.length >= (schema.minItems ?? 0)
        && value.length <= schema.maxItems && value.every((entry) => matchesAgentHostToolSchema(schema.items, entry));
    case "string":
      return typeof value === "string" && [...value].length >= (schema.minLength ?? 0)
        && [...value].length <= schema.maxLength && (schema.enum === undefined || schema.enum.includes(value));
    case "number":
    case "integer":
      return typeof value === "number" && Number.isFinite(value)
        && (schema.type !== "integer" || Number.isSafeInteger(value))
        && (schema.minimum === undefined || value >= schema.minimum)
        && (schema.maximum === undefined || value <= schema.maximum);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
  }
}
