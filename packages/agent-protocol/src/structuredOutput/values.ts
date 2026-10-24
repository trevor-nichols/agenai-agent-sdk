import type {
  AgentJsonObject,
  AgentJsonValue,
  AgentProtocolParseResult,
  ValidationPathSegment,
} from '../foundation/types.js';
import { codePointLength, isJsonObject, snapshotStructuredOutputJson } from './boundedJson.js';
import {
  AGENT_OUTPUT_VALUE_COLLECTION_LIMIT,
  AGENT_OUTPUT_VALUE_DEPTH_LIMIT,
  AGENT_OUTPUT_VALUE_NODES_LIMIT,
} from './constants.js';
import { StructuredOutputIssues } from './issues.js';
import { parseOutputByteLimit, trustedOutputSchema, type AgentOutputLimits } from './parsers.js';
import type { AgentOutputSchema, AgentOutputSchemaNode } from './types.js';

function isJsonArray(value: AgentJsonValue): value is readonly AgentJsonValue[] {
  return Array.isArray(value);
}

export function validateAgentOutputValue(
  schema: AgentOutputSchema,
  candidate: unknown,
  limits?: AgentOutputLimits,
): AgentProtocolParseResult<AgentJsonObject> {
  const parsedLimit = parseOutputByteLimit(limits);
  if (!parsedLimit.success) return parsedLimit;
  const admitted = trustedOutputSchema(schema);
  if (!admitted.success) return admitted;
  const snapshot = snapshotStructuredOutputJson(candidate, {
    maxBytes: parsedLimit.data,
    maxDepth: AGENT_OUTPUT_VALUE_DEPTH_LIMIT,
    maxNodes: AGENT_OUTPUT_VALUE_NODES_LIMIT,
    maxCollectionLength: AGENT_OUTPUT_VALUE_COLLECTION_LIMIT,
  });
  if (!snapshot.success) return snapshot;
  const issues = new StructuredOutputIssues();

  function matches(node: AgentOutputSchemaNode, value: AgentJsonValue, path: readonly ValidationPathSegment[]): void {
    if (issues.full) return;
    if ('anyOf' in node) {
      if (value !== null) matches(node.anyOf[0], value, path);
      return;
    }
    switch (node.type) {
      case 'object':
        if (!isJsonObject(value)) break;
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(node.properties, key)) issues.add('schema_mismatch', 'Object contains an undeclared property.', [...path, key]);
        }
        for (const [key, childSchema] of Object.entries(node.properties)) {
          const child = value[key];
          if (child === undefined) issues.add('schema_mismatch', 'Object is missing a required property.', [...path, key]);
          else matches(childSchema, child, [...path, key]);
          if (issues.full) return;
        }
        return;
      case 'array':
        if (!isJsonArray(value)) break;
        if ((node.minItems !== undefined && value.length < node.minItems) || (node.maxItems !== undefined && value.length > node.maxItems)) {
          issues.add('schema_mismatch', 'Array length is outside the declared bounds.', path);
        }
        for (const [index, child] of value.entries()) {
          matches(node.items, child, [...path, index]);
          if (issues.full) return;
        }
        return;
      case 'string': {
        if (typeof value !== 'string') break;
        const length = codePointLength(value);
        if ((node.minLength !== undefined && length < node.minLength) || (node.maxLength !== undefined && length > node.maxLength)) {
          issues.add('schema_mismatch', 'String code-point length is outside the declared bounds.', path);
        }
        if (node.enum && !node.enum.includes(value)) issues.add('schema_mismatch', 'String is not one of the declared enum values.', path);
        return;
      }
      case 'integer':
      case 'number':
        if (typeof value !== 'number' || (node.type === 'integer' && !Number.isInteger(value))) break;
        if ((node.minimum !== undefined && value < node.minimum) || (node.maximum !== undefined && value > node.maximum)) {
          issues.add('schema_mismatch', 'Number is outside the declared inclusive bounds.', path);
        }
        return;
      case 'boolean':
        if (typeof value === 'boolean') return;
        break;
      case 'null':
        if (value === null) return;
        break;
    }
    issues.add('schema_mismatch', 'Value does not have the declared JSON type.', path);
  }

  matches(admitted.data, snapshot.data, []);
  if (issues.issues.length > 0) return { success: false, issues: issues.issues };
  if (!isJsonObject(snapshot.data)) {
    issues.add('schema_mismatch', 'Output must be a JSON object.');
    return { success: false, issues: issues.issues };
  }
  return { success: true, data: snapshot.data };
}
