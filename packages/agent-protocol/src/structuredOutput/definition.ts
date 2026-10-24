// ------------------------------------------------------------------------------------------------
//                definition.ts - Local portable output schema and validation-only decoder
// ------------------------------------------------------------------------------------------------

import type { AgentJsonObject, AgentProtocolParseResult } from '../foundation/types.js';
import { parseAgentOutputSchema } from './parsers.js';
import type { AgentOutputSchema } from './types.js';

export interface AgentOutputDefinition<T> {
  readonly schema: AgentOutputSchema;
  readonly decode: (value: AgentJsonObject) => AgentProtocolParseResult<T>;
}

export function createAgentOutputDefinition(schema: AgentOutputSchema): AgentOutputDefinition<AgentJsonObject>;
export function createAgentOutputDefinition<T>(
  schema: AgentOutputSchema,
  decode: (value: AgentJsonObject) => AgentProtocolParseResult<T>,
): AgentOutputDefinition<T>;
export function createAgentOutputDefinition<T>(
  schema: AgentOutputSchema,
  decode?: (value: AgentJsonObject) => AgentProtocolParseResult<T>,
): AgentOutputDefinition<T> | AgentOutputDefinition<AgentJsonObject> {
  if (decode !== undefined && typeof decode !== 'function') {
    throw new TypeError('An output definition decoder must be a function.');
  }
  const ownedSchema = parseAgentOutputSchema(schema);
  if (decode !== undefined) return Object.freeze({ schema: ownedSchema, decode });
  return Object.freeze({
    schema: ownedSchema,
    decode: (value: AgentJsonObject): AgentProtocolParseResult<AgentJsonObject> => ({ success: true, data: value }),
  });
}
