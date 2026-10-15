import type { MaybePromise } from '@agen-ai/agent-runtime';
import type { AcpConnectionFactoryContext, AcpConnectionStreams } from '../../contracts.js';

export interface NodeAcpExecutionInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shutdownTimeoutMs: number;
}

/** Reserve fresh inert state; resource acquisition and execution belong to start. */
export interface NodeAcpExecutionBoundary {
  readonly reserve: (input: NodeAcpExecutionInput) => NodeAcpExecutionReservation;
}

/** Own the workload before execution, including descendants in other groups or sessions. */
export interface NodeAcpExecutionReservation {
  readonly start: (context: AcpConnectionFactoryContext) => MaybePromise<AcpConnectionStreams>;
  /** Fence startup, terminate and join the workload and streams; failed release remains retryable. */
  readonly release: () => MaybePromise<void>;
}
