// ------------------------------------------------------------------------------------------------
//                index.ts - Inert OpenCode provider contracts - Dependencies: provider-tools root types
// ------------------------------------------------------------------------------------------------

import type { NodeProviderApiCredential, NodeProviderToolOptions } from '@agen-ai/provider-tools';

export const OPENCODE_PROVIDER_KEY = 'opencode';
/** The exact OpenCode V2 client and native runtime version this package drives. */
export const OPENCODE_VERSION = '2.2.7';

/** The model backends this package routes through OpenCode's bundled providers. */
export type NodeOpenCodeModelProvider = 'anthropic' | 'openai';

/** Native usage controls OpenCode enforces itself. Neither bounds cost, and neither is an invoice cap. */
export interface NodeOpenCodeUsageLimits {
  /** Bounds the output tokens of every model request: turn steps, compaction, generation and titles. */
  readonly maxOutputTokensPerRequest?: number;
  /** The native agent's step bound for one turn. */
  readonly maxModelStepsPerTurn?: number;
}

export interface NodeOpenCodeProviderOptions {
  /** An OpenCode 2.2.7 executable whose bytes match this package's pin for the running platform. */
  readonly executablePath: string;
  readonly provider: NodeOpenCodeModelProvider;
  /** The selected provider's API key; no other credential source is read. */
  readonly credential: NodeProviderApiCredential;
  readonly tools: NodeProviderToolOptions;
  /** Defaults to the selected provider's API origin. HTTPS, or HTTP on a loopback address, without credentials. */
  readonly apiBaseUrl?: string;
  readonly usageLimits?: NodeOpenCodeUsageLimits;
}

export type {
  NodeNativeProviderConfiguration,
  NodeProviderApiCredential,
  NodeProviderFileRestrictions,
  NodeProviderToolLimits,
  NodeProviderToolOptions,
  NodeProviderWorkspace,
} from '@agen-ai/provider-tools';
