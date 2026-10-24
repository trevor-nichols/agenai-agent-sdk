// ------------------------------------------------------------------------------------------------
//                structuredOutputIntegration.typecheck.ts - Correlated V13 public type proofs
// ------------------------------------------------------------------------------------------------

import type {
  AgentSessionResumeInput,
  AgentStructuredOutputCapability,
  AgentTurnCompletedPayload,
  AgentTurnInputContent,
} from '../src/public/index.js';

declare const failure: Extract<AgentTurnCompletedPayload, { outcome: 'failed' }>['error'];
declare const resumeInput: AgentSessionResumeInput;
declare const output: NonNullable<import('../src/public/index.js').AgentTurnRunInput['output']>;

const completed: AgentTurnCompletedPayload = {
  outcome: 'completed', structuredOutput: { kind: 'json', value: { title: 'Ready' } },
};
const failed: AgentTurnCompletedPayload = {
  outcome: 'failed', error: failure, structuredOutput: { kind: 'unavailable', reason: 'provider_error' },
};

// @ts-expect-error Failed execution cannot claim a JSON result.
const failedJson: AgentTurnCompletedPayload = { outcome: 'failed', error: failure, structuredOutput: { kind: 'json', value: {} } };
// @ts-expect-error Failed execution requires its error.
const missingFailure: AgentTurnCompletedPayload = { outcome: 'failed', structuredOutput: { kind: 'not_requested' } };
// @ts-expect-error Completed execution cannot carry an execution error.
const completedError: AgentTurnCompletedPayload = { outcome: 'completed', error: failure, structuredOutput: { kind: 'not_requested' } };
// @ts-expect-error Canceled execution cannot claim a JSON result.
const canceledJson: AgentTurnCompletedPayload = { outcome: 'canceled', structuredOutput: { kind: 'json', value: {} } };
// @ts-expect-error Every V13 terminal carries explicit structured result truth.
const missingResult: AgentTurnCompletedPayload = { outcome: 'completed' };
// @ts-expect-error Structured output is execution configuration, outside persisted turn content.
const contentOutput: AgentTurnInputContent = { parts: [{ type: 'text', text: 'Title' }], output };
// @ts-expect-error Structured resume remains unsupported in V13.
const resumeOutput: AgentSessionResumeInput = { ...resumeInput, output };

declare const nativeCapability: Extract<AgentStructuredOutputCapability, { kind: 'supported' }>;
// @ts-expect-error Restoration support cannot be advertised in this profile.
const resumeCapability: AgentStructuredOutputCapability = { ...nativeCapability, resume: true };

void [completed, failed, failedJson, missingFailure, completedError, canceledJson, missingResult, contentOutput, resumeOutput, resumeCapability];
