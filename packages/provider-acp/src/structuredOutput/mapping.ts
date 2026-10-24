import {
  AGENT_OUTPUT_SCHEMA_BYTES_LIMIT,
  AGENT_OUTPUT_SCHEMA_PROFILE,
  AGENT_OUTPUT_VALUE_BYTES_LIMIT,
  type AgentStructuredOutputCapability,
} from '@agen-ai/agent-protocol';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import { AcpProviderConnectionError } from '../connection/errors.js';

/** Explicit native contract; generic ACP metadata support does not imply this feature. */
export interface AcpStructuredOutputMappingSelection {
  readonly mapping: 'grok-build-1.0.62-structured-output-v1';
}

export function resolveAcpStructuredOutputMapping(input: unknown): AcpStructuredOutputMappingSelection | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError('ACP structured output mapping must be an explicit selection.');
  }
  const keys = Reflect.ownKeys(input);
  const descriptor = Object.getOwnPropertyDescriptor(input, 'mapping');
  if (keys.length !== 1 || keys[0] !== 'mapping' || !descriptor || !('value' in descriptor)
    || !descriptor.enumerable || descriptor.value !== 'grok-build-1.0.62-structured-output-v1') {
    throw new TypeError('ACP structured output mapping is unsupported.');
  }
  return Object.freeze({ mapping: 'grok-build-1.0.62-structured-output-v1' });
}

export function assertAcpStructuredOutputIdentity(
  initialized: AcpJsonObject,
  selected: AcpStructuredOutputMappingSelection | undefined,
): void {
  if (!selected) return;
  const meta = initialized._meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)
    || meta.grokShell !== true || meta.agentVersion !== '1.0.62') {
    throw new AcpProviderConnectionError('acp_structured_output_profile_mismatch',
      'The selected structured output mapping requires exact Grok Build agentVersion 1.0.62.');
  }
}

export function acpStructuredOutputCapability(
  selected: AcpStructuredOutputMappingSelection | undefined,
): AgentStructuredOutputCapability {
  return selected ? {
    kind: 'supported', mechanism: 'native', schemaProfile: AGENT_OUTPUT_SCHEMA_PROFILE,
    scope: 'turn', maxSchemaBytes: AGENT_OUTPUT_SCHEMA_BYTES_LIMIT, maxOutputBytes: AGENT_OUTPUT_VALUE_BYTES_LIMIT,
    resume: false, branch: false,
  } : { kind: 'unsupported' };
}
