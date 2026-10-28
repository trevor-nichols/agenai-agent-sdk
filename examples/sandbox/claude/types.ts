// ------------------------------------------------------------------------------------------------
//                types.ts - Exact-version contained Claude consumer contracts
// ------------------------------------------------------------------------------------------------

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxProcessExit } from '@agen-ai/sandbox';

export type ClaudeSandboxTool = 'Read' | 'Write' | 'Edit' | 'Bash';

export interface ClaudeSandboxRequest {
  readonly credential: Readonly<{ kind: 'api_key'; value: string }>;
  readonly guestExecutable: string;
  readonly model: string;
  readonly tools: readonly ClaudeSandboxTool[];
  readonly maxTurns: number;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

/** The supplied exact SDK implements this subset; no native query mutators are exported. */
export interface ClaudeSdk {
  query(input: { prompt: string; options: Options }): AsyncIterable<SDKMessage> & { close(): void };
}

export type ClaudeProcessSettlement =
  | Readonly<{ kind: 'receipt'; receipt: SandboxProcessExit }>
  | Readonly<{ kind: 'failed'; error: Error; receipt?: SandboxProcessExit }>;

export interface ClaudeSandboxRun {
  /** Claim once and keep reading until settlement, including during cancellation. */
  readonly messages: AsyncIterable<SDKMessage>;
  /** Native process observation; never establishes physical descendant quiescence. */
  readonly settled: Promise<ClaudeProcessSettlement>;
  /** Bounded raw diagnostic bytes, copied on access; never a controller callback. */
  readonly stderr: Uint8Array;
  /** Stop and join the borrowed workload; the caller still owns storage destruction. Retry after failure. */
  cleanup(): Promise<void>;
}
