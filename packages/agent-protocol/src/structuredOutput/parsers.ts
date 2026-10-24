import {
  AgentProtocolValidationError,
  type AgentProtocolParseResult,
} from '../foundation/types.js';
import { snapshotStructuredOutputJson } from './boundedJson.js';
import {
  AGENT_OUTPUT_SCHEMA_BYTES_LIMIT,
  AGENT_OUTPUT_SCHEMA_DEPTH_LIMIT,
  AGENT_OUTPUT_SCHEMA_PROPERTIES_LIMIT,
  AGENT_OUTPUT_VALUE_BYTES_LIMIT,
} from './constants.js';
import { StructuredOutputIssues } from './issues.js';
import { admitOutputSchema, StructuredOutputSchemaError } from './schemaAdmission.js';
import type { AgentOutputSchema } from './types.js';

const admittedSchemas = new WeakSet<AgentOutputSchema>();

export interface AgentOutputLimits {
  readonly maxOutputBytes?: number;
}

function outputByteLimit(limits: AgentOutputLimits): number | undefined {
  if (limits === null || typeof limits !== 'object') return undefined;
  try {
    const prototype: unknown = Object.getPrototypeOf(limits);
    if ((prototype !== Object.prototype && prototype !== null)
      || Reflect.ownKeys(limits).some((key) => key !== 'maxOutputBytes')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(limits, 'maxOutputBytes');
    if (descriptor === undefined) return AGENT_OUTPUT_VALUE_BYTES_LIMIT;
    if (!('value' in descriptor) || !descriptor.enumerable) return undefined;
    const value: unknown = descriptor.value;
    if (value === undefined) return AGENT_OUTPUT_VALUE_BYTES_LIMIT;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= AGENT_OUTPUT_VALUE_BYTES_LIMIT
      ? value : undefined;
  } catch {
    return undefined;
  }
}

export function parseOutputByteLimit(limits: AgentOutputLimits = {}): AgentProtocolParseResult<number> {
  const maxOutputBytes = outputByteLimit(limits);
  if (maxOutputBytes === undefined) {
    return { success: false, issues: [{
      code: 'invalid_output_limits', path: ['maxOutputBytes'],
      message: 'Output byte limit must be a positive integer within the portable profile ceiling.',
    }] };
  }
  return { success: true, data: maxOutputBytes };
}

export function safeParseAgentOutputSchema(
  input: unknown,
  limits?: AgentOutputLimits,
): AgentProtocolParseResult<AgentOutputSchema> {
  const parsedLimit = parseOutputByteLimit(limits);
  if (!parsedLimit.success) return parsedLimit;
  const snapshot = snapshotStructuredOutputJson(input, {
    maxBytes: AGENT_OUTPUT_SCHEMA_BYTES_LIMIT,
    maxDepth: 3 * AGENT_OUTPUT_SCHEMA_DEPTH_LIMIT + 2,
    maxNodes: AGENT_OUTPUT_SCHEMA_BYTES_LIMIT,
    maxCollectionLength: AGENT_OUTPUT_SCHEMA_PROPERTIES_LIMIT,
  });
  if (!snapshot.success) return snapshot;
  try {
    const schema = admitOutputSchema(snapshot.data, parsedLimit.data);
    admittedSchemas.add(schema);
    return { success: true, data: schema };
  } catch (error) {
    if (!(error instanceof StructuredOutputSchemaError)) throw error;
    const issues = new StructuredOutputIssues();
    issues.add('invalid_output_schema', error.message, error.path);
    return { success: false, issues: issues.issues };
  }
}

export function parseAgentOutputSchema(input: unknown, limits?: AgentOutputLimits): AgentOutputSchema {
  const parsed = safeParseAgentOutputSchema(input, limits);
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}

export function trustedOutputSchema(input: AgentOutputSchema): AgentProtocolParseResult<AgentOutputSchema> {
  return admittedSchemas.has(input) ? { success: true, data: input } : safeParseAgentOutputSchema(input);
}
