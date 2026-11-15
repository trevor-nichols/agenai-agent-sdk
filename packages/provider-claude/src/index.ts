// ------------------------------------------------------------------------------------------------
//                index.ts - Inert Claude provider contracts - Dependencies: provider-tools root types
// ------------------------------------------------------------------------------------------------

import type { NodeProviderApiCredential, NodeProviderToolOptions } from '@agen-ai/provider-tools';

export const CLAUDE_PROVIDER_KEY = 'claude';
/** The exact Claude Agent SDK and Claude Code tuple this package drives. */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.322';
export const CLAUDE_CODE_VERSION = '2.1.322';

/**
 * Native usage controls Claude enforces itself. Costs are Claude Code's USD estimates, checked after
 * each model response, so a session can end somewhat above its budget; this is not an invoice cap.
 */
export interface NodeClaudeUsageLimits {
  /** Claude Agent SDK `maxBudgetUsd` for the session's one query, cumulative across its turns. */
  readonly maxBudgetUsdPerSession?: number;
}

export interface NodeClaudeProviderOptions {
  /** A Claude Code 2.1.322 executable whose bytes match this package's pin for the running platform. */
  readonly executablePath: string;
  readonly credential: NodeProviderApiCredential;
  readonly tools: NodeProviderToolOptions;
  /** Defaults to the Anthropic API origin. HTTPS, or HTTP on a loopback address, without credentials. */
  readonly apiBaseUrl?: string;
  readonly usageLimits?: NodeClaudeUsageLimits;
}

export type {
  NodeNativeProviderConfiguration,
  NodeProviderApiCredential,
  NodeProviderFileRestrictions,
  NodeProviderToolLimits,
  NodeProviderToolOptions,
  NodeProviderWorkspace,
} from '@agen-ai/provider-tools';
